/**
 * bwb-browser — Multi-tab Management
 *
 * Manages multiple page targets (tabs) within a single Chrome browser instance.
 * Uses CDP's target system to create, close, switch, and list tabs.
 * Each tab gets its own CDP protocol connection.
 */

import CDP from "chrome-remote-interface";
import { ensureBrowser, protocol, actualCdpPort, cfg, attached, browserExited, cdpAddress } from "./browser.mjs";
import { assertNavigable } from "./urlpolicy.mjs";
import { openTab, getState } from "./drishti.mjs";
import { attachTelemetry } from "./telemetry.mjs";
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";

// ─── Tab Journal (working-set survival across LMK kills / mayfly teardown) ───
// Tiny JSON append on every mutation. Journal is the truth the next fresh
// browser restores from — cookies live in user-data-dir, tab URLs live here.
//
// The journal stores ORIGIN + PATH only. Tab URLs routinely carry OAuth
// callbacks, magic links and reset tokens in the query string, and on desktop
// nothing re-navigates them anyway (see restoreJournal) — so writing and
// replaying the full URL was leaking credentials onto disk for no benefit.
// BWB_JOURNAL=full restores the old behaviour for anyone who needs it.

function journalPath() {
  if (!cfg.userDataDir) return null;
  // drishti mode: the tabs belong to the human and live on the phone. Writing a
  // journal here would only invite a restore that navigates their tabs later.
  if (cfg.drishti) return null;
  return join(cfg.userDataDir, "bwb-tabs.json");
}

/** Strip query + fragment unless the user explicitly asked for full URLs. */
export function journalUrl(url) {
  if (!url) return url;
  if (cfg.journalFull) return url;
  try {
    const u = new URL(url);
    return u.origin === "null" ? u.href : `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

function saveJournal() {
  try {
    const path = journalPath();
    if (!path) return;
    const entries = [];
    for (const [id, tab] of tabs) {
      if (tab.url && tab.url !== "about:blank") {
        entries.push({
          url: journalUrl(tab.url),
          ...(cfg.journalFull ? { fullUrl: tab.url } : {}),
          title: tab.title || "",
          active: id === activeTabId,
        });
      }
    }
    mkdirSync(path.replace(/[^/\\]+$/, ""), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(entries), { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {}
}

function loadJournal() {
  try {
    const path = journalPath();
    if (!path || !existsSync(path)) return [];
    const entries = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(entries)) return [];
    // fullUrl only exists when BWB_JOURNAL=full was on when it was written.
    return entries
      .filter((e) => e && (e.url || e.fullUrl))
      .map((e) => ({ ...e, url: e.fullUrl || e.url }));
  } catch {
    return [];
  }
}

// Live-tab cap: 0/unset = unlimited (desktop). Lean profiles set 3.
function liveCount() {
  let n = 0;
  for (const tab of tabs.values()) if (!tab.hibernated) n++;
  return n;
}

// ─── Tab State ───────────────────────────────────────────────────────────────

/** @type {Map<string, {protocol: import('chrome-remote-interface').Protocol|null, title: string, url: string}>} */
const tabs = new Map();
let activeTabId = null;

// ─── Ensure Default Tab Registered ──────────────────────────────────────────

async function ensureDefaultTab() {
  if (tabs.size > 0) return;

  // Browser must be started first
  await ensureBrowser();
  if (!protocol) {
    throw new Error(
      `Browser not started (exited=${browserExited} attached=${attached} port=${actualCdpPort}). ` +
      `If another bwb process is using ${cfg.userDataDir}, it kills this browser — use a different --user-data-dir or --port.`
    );
  }

  const targets = await CDP.List(cdpAddress());
  const pages = targets.filter(t => t.type === "page");
  if (!pages.length) return;

  if (cfg.drishti) {
    // Register the human's tabs. Never navigate them, and mark them unowned so
    // browser_closeTab can refuse to close what it did not open.
    for (const page of pages) {
      tabs.set(page.id, { protocol: null, title: page.title, url: page.url, owned: false });
    }
    activeTabId = pickDrishtiTarget(pages);
    return;
  }

  const page = pages[0];
  tabs.set(page.id, { protocol: protocol, title: page.title, url: page.url });
  activeTabId = page.id;
}

/**
 * Which of drishti's page targets is the one on screen?
 *
 * We used to ask POST /bwb/state with an 800ms budget. That was a lie twice
 * over: the call is a long-poll (it holds for tens of seconds by design), and a
 * hard timeout inside a tab pick makes connecting take a second for no reason.
 * Contract v1 has no "active target" field, so use what WebView guarantees:
 * new targets are appended, the newest page target is the visible one.
 */
function pickDrishtiTarget(pages) {
  return pages[pages.length - 1].id;
}

/** Open a CDP connection to one specific tab (drishti gives each its own). */
async function connectTab(targetId) {
  const tab = tabs.get(targetId);
  if (!tab) throw new Error(`Tab not found: ${targetId}`);
  if (tab.protocol) return tab.protocol;
  const cdp = await CDP({
    target: targetId,
    ...cdpAddress(),
    ...(attached ? { local: true } : {}),
  });
  tab.protocol = cdp;
  return cdp;
}

// ─── getActiveProtocol ───────────────────────────────────────────────────────

/**
 * Returns the CDP protocol for the active tab.
 * If no tabs are managed, ensures browser is started and returns default protocol.
 * All tool handlers should use this instead of ensureBrowser() directly.
 *
 * This is also where the static rung is paid off: if browser_goto answered
 * from a plain HTTP fetch, the browser has never seen the URL. The first tool
 * that needs Chromium materializes it here — the browser starts, navigates to
 * the same URL, and every later tool works on that page.
 */
export async function getActiveProtocol() {
  if (tabs.size === 0) {
    await ensureDefaultTab();
  }

  if (activeTabId && tabs.has(activeTabId)) {
    const tab = tabs.get(activeTabId);
    if (tab.hibernated) return wakeTab(activeTabId);
    if (tab.protocol) {
      // Console and network have to be recording before the thing that fails,
      // so every client is instrumented the moment it is handed out.
      attachTelemetry(tab.protocol).catch(() => {});
      return tab.protocol;
    }
    // drishti: each page target has its own socket; the global connection may
    // point at a tab the human is not looking at.
    if (cfg.drishti) return connectTab(activeTabId);
  }

  // Fallback to default protocol
  attachTelemetry(protocol).catch(() => {});
  return protocol;
}

/**
 * A page served by the static rung that Chromium has not loaded yet.
 * Set by browser_goto; consumed (navigated to) by the first browser tool.
 */
let pendingStatic = null;

export function setPendingStatic(url, title = "") {
  pendingStatic = url ? { url, title } : null;
}

export function getPendingStatic() {
  return pendingStatic;
}

export function clearPendingStatic() {
  pendingStatic = null;
}

/** True when a browser-backed tool must run but Chromium shows nothing. */
export function needsMaterialize() {
  if (!pendingStatic) return false;
  const tab = activeTabId ? tabs.get(activeTabId) : null;
  const current = tab?.url || "";
  return !current || current === "about:blank" || current !== pendingStatic.url;
}

/**
 * Bring Chromium to the page the static rung served, if the tab is not already
 * there. Called from the single choke point (server.mjs) before any tool that
 * needs a live page.
 */
export async function materializeStatic() {
  if (!needsMaterialize()) return null;
  const target = pendingStatic;
  const cdp = await getActiveProtocol();
  try {
    assertNavigable(target.url);
    await cdp.Page.enable?.();
    // Wait for the real load events rather than a fixed sleep: a fixed sleep
    // is how the first browser_text after a static goto comes back empty.
    const { gotoUrl } = await import("./helpers.mjs");
    const landed = await gotoUrl(cdp.Page, cdp.Runtime, target.url, cfg.navTimeout || 30000);
    pendingStatic = null;
    syncActiveTab(landed.title, landed.url);
    return landed;
  } catch (err) {
    pendingStatic = null;
    throw err;
  }
}

/**
 * Hibernate a tab: URL stays in the journal + visible in listTabs, but the
 * renderer is closed and memory freed. Woken transparently on switchTab.
 * Never hibernates the active tab — caller must switch away first.
 *
 * The default tab's `protocol` IS the global browser connection, so closing
 * that target used to leave the global connected to a dead target: the next
 * ensureBrowser() saw a live `protocol` and handed out a connection to a tab
 * that no longer existed.
 */
export async function hibernateTab(targetId) {
  const id = targetId || [...tabs.keys()].find((k) => k !== activeTabId && !tabs.get(k)?.hibernated);
  if (!id || !tabs.has(id)) return null;
  const tab = tabs.get(id);
  if (tab.hibernated) return { id, hibernated: true };
  // drishti: every tab is the human's. Closing one to save RAM is not ours to do.
  if (cfg.drishti) return { id, skipped: true, reason: "drishti mode: never closes the human's tabs" };
  // Guest mode: those are the user's real tabs. Never close one to save RAM.
  if (attached) return { id, skipped: true, reason: "attach mode: never closes real tabs" };
  try { await CDP.Close({ id, ...cdpAddress() }); } catch {}
  closeTabConnection(tab);
  tabs.set(id, { protocol: null, title: tab.title, url: tab.url, hibernated: true });
  saveJournal();
  return { id, hibernated: true, url: tab.url };
}

/** Close a tab's CDP connection, including the shared global one. */
function closeTabConnection(tab) {
  if (!tab?.protocol) return;
  try {
    if (tab.protocol === protocol) protocol.close().catch(() => {});
  } catch {}
}

/** Wake a hibernated tab: fresh target, journaled URL re-navigated. */
async function wakeTab(targetId) {
  const tab = tabs.get(targetId);
  if (!tab || !tab.hibernated) return tab?.protocol || protocol;
  // drishti tabs are never hibernated; if one is, just reconnect — never
  // re-open it through /json/new (WebView doesn't have it).
  if (cfg.drishti) {
    tab.hibernated = false;
    return connectTab(targetId);
  }
  const info = await CDP.New({ ...cdpAddress(), url: tab.url || "about:blank" });
  const newProtocol = await CDP({ target: info.id, ...cdpAddress() });
  tabs.delete(targetId);
  tabs.set(info.id, { protocol: newProtocol, title: info.title || tab.title, url: info.url || tab.url });
  if (activeTabId === targetId) activeTabId = info.id;
  saveJournal();
  return newProtocol;
}

/**
 * Restore the journaled working set after a fresh spawn. First entry
 * navigates now; the rest become about:blank placeholders woken on switch.
 * Capped at cfg.tabMax so restore never re-spikes memory at startup.
 *
 * Auto-restore RE-NAVIGATES. On a lean profile that is the point (resurrect
 * the working set after an LMK kill). On desktop it is not: a stale journal
 * from yesterday would re-fire every URL the moment bwb starts. So on desktop
 * the entries are surfaced as placeholders and nothing is fetched until the
 * agent asks for it via browser_listTabs + browser_switchTab.
 */
export async function restoreJournal() {
  // drishti never journals and never re-navigates the human's tabs.
  if (cfg.drishti) return false;
  const entries = loadJournal();
  if (!entries.length) return false;
  await ensureDefaultTab();
  const cap = cfg.tabMax && cfg.tabMax > 0 ? cfg.tabMax : entries.length;
  const wanted = entries.slice(0, Math.max(cap, 1));
  const auto = Boolean(cfg.lean) || Boolean(cfg.journalFull);
  let first = true;
  for (const entry of wanted) {
    if (first && auto) {
      first = false;
      try {
        await protocol.Page.navigate({ url: entry.url });
        syncActiveTab(entry.title, entry.url);
      } catch {}
      continue;
    }
    first = false;
    try {
      const info = await CDP.New({ ...cdpAddress(), url: "about:blank" });
      const newProtocol = await CDP({ target: info.id, ...cdpAddress() });
      tabs.set(info.id, { protocol: newProtocol, title: entry.title || "", url: "", pendingUrl: entry.url });
    } catch {}
  }
  saveJournal();
  return auto;
}

// ─── Create Tab ──────────────────────────────────────────────────────────────

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The target that appeared between two listings — bwb's stand-in for a mapping
 * the app cannot provide.
 *
 * A single new page target is unambiguous. More than one means the human opened
 * a tab at the same moment, so the URL decides; if it still is not clear, this
 * returns null and the caller reports a failure rather than attaching to
 * somebody else's tab.
 */
export function pickNewTarget(before, after, url) {
  const known = new Set((before || []).map((t) => t.id));
  const fresh = (after || []).filter((t) => t.type === "page" && !known.has(t.id));
  if (fresh.length === 0) return null;
  if (fresh.length === 1) return fresh[0];
  const wanted = String(url || "").trim().replace(/\/+$/, "");
  if (!wanted) return null;
  return fresh.find((t) => String(t.url || "").replace(/\/+$/, "").startsWith(wanted)) || null;
}

/**
 * Creates a new browser tab and navigates to url (or about:blank).
 * Switches to the new tab automatically.
 *
 * drishti: WebView has no /json/new (verified: HTTP 500 "Could not create new
 * page"), so the tab is created by the app itself via POST /bwb/tab and bwb
 * attaches to the target it reports.
 */
export async function createTab(url) {
  if (url) assertNavigable(url, { allowDomains: cfg.allowDomains || null });
  await ensureDefaultTab();

  if (cfg.drishti) {
    // The app cannot tell us its CDP target id: `POST /bwb/tab` answers with a
    // registry id, and WebView exposes no mapping from a WebView instance to its
    // devtools target. So diff the target list around the create call — the one
    // that appeared is the tab we just asked for. Done before the create, so a
    // tab the human opens in the same second cannot be mistaken for ours.
    const before = await CDP.List(cdpAddress()).catch(() => []);
    const info = await openTab({ url: url || null });
    let target = null;
    for (let attempt = 0; attempt < 25 && !target; attempt++) {
      const after = await CDP.List(cdpAddress()).catch(() => []);
      target = pickNewTarget(before, after, url);
      if (!target) await pause(120);
    }
    if (!target) {
      throw new Error(
        "drishti created the tab (registry id " + (info?.tabId || info?.id || "unknown") + ") " +
        "but no new CDP target appeared within 3s. The tab is open and visible; bwb just cannot attach to it. " +
        "Try browser_listTabs and switch to it.",
      );
    }
    tabs.set(target.id, {
      protocol: null,
      title: target.title || info?.tab?.title || "",
      url: target.url || url || "",
      owned: true,
      drishtiTab: info?.tabId || null,
    });
    activeTabId = target.id;
    return { id: target.id, title: target.title || "", url: target.url || url || "", drishtiTab: info?.tabId || null };
  }

  // Live-tab cap: hibernate the oldest non-active tab instead of growing
  // renderers until Android LMK notices. Journal keeps everything restorable.
  // Never in attach mode — those tabs belong to the human.
  if (!attached && cfg.tabMax && cfg.tabMax > 0) {
    while (liveCount() >= cfg.tabMax) {
      const victim = [...tabs.keys()].find((k) => k !== activeTabId && !tabs.get(k)?.hibernated);
      if (!victim) break;
      await hibernateTab(victim);
    }
  }

  const info = await CDP.New({ ...cdpAddress(), url: url || "about:blank" });

  // Create a CDP connection for this specific target
  const newProtocol = await CDP({ target: info.id, ...cdpAddress() });
  tabs.set(info.id, { protocol: newProtocol, title: info.title || "", url: info.url || url || "" });
  activeTabId = info.id;
  saveJournal();

  return { id: info.id, title: info.title || "", url: info.url || "" };
}

// ─── Close Tab ───────────────────────────────────────────────────────────────

/**
 * Closes a tab by targetId. If no targetId provided, closes the active tab.
 * Cannot close the last remaining tab.
 */
export async function closeTab(targetId) {
  await ensureDefaultTab();

  const id = targetId || activeTabId;
  if (!id) throw new Error("No tab to close");

  if (tabs.size <= 1) {
    throw new Error("Cannot close the only remaining tab. Use browser_restart instead.");
  }

  const tab = tabs.get(id);
  // drishti: only close what bwb opened. The rest are the human's.
  if (cfg.drishti && tab && tab.owned === false) {
    throw new Error(
      `Refusing to close tab ${id}: the human opened it, not bwb. ` +
      "drishti mode never closes or navigates the user's tabs."
    );
  }

  try {
    await CDP.Close({ id, ...cdpAddress() });
  } catch (err) {
    if (cfg.drishti) {
      throw new Error(
        `WebView cannot close a tab over CDP (${err.message}). Close it in the drishti app instead.`
      );
    }
    throw err;
  }

  closeTabConnection(tab);
  tabs.delete(id);

  // Switch to another tab
  if (activeTabId === id) {
    activeTabId = tabs.keys().next().value;
  }
  saveJournal();

  return { closed: id, activeTab: activeTabId };
}

// ─── Switch Tab ──────────────────────────────────────────────────────────────

/**
 * Switches to a different tab by targetId. Hibernated tabs and restored
 * placeholders wake transparently (async navigation on first switch).
 */
export async function switchTab(targetId) {
  if (!targetId) throw new Error("No targetId provided");
  if (!tabs.has(targetId)) {
    throw new Error(`Tab not found: ${targetId}`);
  }

  const tab = tabs.get(targetId);
  if (tab.hibernated) {
    await wakeTab(targetId);
    const woken = tabs.get(activeTabId);
    return { id: activeTabId, title: woken?.title, url: woken?.url, woken: true };
  }
  activeTabId = targetId;
  // drishti: switching in bwb does not move the app's visible page, but it does
  // move which target the next command talks to — so connect to that one.
  if (cfg.drishti) {
    try { await connectTab(targetId); } catch {}
  }
  if (tab.pendingUrl) {
    const url = tab.pendingUrl;
    delete tab.pendingUrl;
    try {
      const cdp = tab.protocol || protocol;
      const { Page } = cdp;
      await Page.navigate({ url });
      tab.url = url;
    } catch {}
  }
  saveJournal();
  const current = tabs.get(activeTabId);
  return { id: activeTabId, title: current?.title, url: current?.url };
}

// ─── List Tabs ───────────────────────────────────────────────────────────────

/**
 * Lists all open tabs with their IDs, titles, URLs, and active status.
 */
export function listTabs() {
  const result = [];
  for (const [id, tab] of tabs) {
    result.push({
      id,
      title: tab.title,
      url: tab.url,
      active: id === activeTabId,
      ...(tab.owned === undefined ? {} : { owned: tab.owned }),
      ...(tab.hibernated ? { hibernated: true } : {}),
      ...(tab.pendingUrl ? { pendingUrl: tab.pendingUrl } : {}),
    });
  }
  return result;
}

// ─── Clear Tabs (for restart) ───────────────────────────────────────────────

/**
 * Clears all tab state. Called during browser restart to prevent stale connections.
 */
export function clearTabs() {
  tabs.clear();
  activeTabId = null;
}

// ─── Tab Sync (update title/url after navigation) ───────────────────────────

/**
 * Call after navigation to keep tab metadata current.
 */
export function syncActiveTab(title, url) {
  if (activeTabId && tabs.has(activeTabId)) {
    const tab = tabs.get(activeTabId);
    if (title) tab.title = title;
    if (url) tab.url = url;
    saveJournal();
  }
}
