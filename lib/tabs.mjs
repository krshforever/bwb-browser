/**
 * bwb-browser — Multi-tab Management
 *
 * Manages multiple page targets (tabs) within a single Chrome browser instance.
 * Uses CDP's target system to create, close, switch, and list tabs.
 * Each tab gets its own CDP protocol connection.
 */

import CDP from "chrome-remote-interface";
import { ensureBrowser, protocol, actualCdpPort, cfg, attached } from "./browser.mjs";
import { assertNavigable } from "./urlpolicy.mjs";
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
  if (!protocol) throw new Error("Browser not started");

  const port = actualCdpPort || cfg.port;
  const targets = await CDP.List({ port });
  const page = targets.find(t => t.type === "page");
  if (page) {
    tabs.set(page.id, { protocol, title: page.title, url: page.url });
    activeTabId = page.id;
  }
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
    if (tab.protocol) return tab.protocol;
  }

  // Fallback to default protocol
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
    await cdp.Page.navigate({ url: target.url });
    // Give the load a moment so the first Runtime.evaluate after this sees the
    // new document, not the previous one.
    await new Promise((r) => setTimeout(r, 1200));
    const { result } = await cdp.Runtime.evaluate({
      expression: "JSON.stringify({ title: document.title, url: location.href })",
      returnByValue: true,
    });
    let landed = null;
    try { landed = JSON.parse(result?.value || "null"); } catch {}
    pendingStatic = null;
    if (landed?.url) syncActiveTab(landed.title, landed.url);
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
  // Guest mode: those are the user's real tabs. Never close one to save RAM.
  if (attached) return { id, skipped: true, reason: "attach mode: never closes real tabs" };
  const port = actualCdpPort || cfg.port;
  try { await CDP.Close({ id, port }); } catch {}
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
  const port = actualCdpPort || cfg.port;
  const info = await CDP.New({ port, url: tab.url || "about:blank" });
  const newProtocol = await CDP({ target: info.id, port });
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
  const entries = loadJournal();
  if (!entries.length) return false;
  await ensureDefaultTab();
  const cap = cfg.tabMax && cfg.tabMax > 0 ? cfg.tabMax : entries.length;
  const wanted = entries.slice(0, Math.max(cap, 1));
  const port = actualCdpPort || cfg.port;
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
      const info = await CDP.New({ port, url: "about:blank" });
      const newProtocol = await CDP({ target: info.id, port });
      tabs.set(info.id, { protocol: newProtocol, title: entry.title || "", url: "", pendingUrl: entry.url });
    } catch {}
  }
  saveJournal();
  return auto;
}

// ─── Create Tab ──────────────────────────────────────────────────────────────

/**
 * Creates a new browser tab and navigates to url (or about:blank).
 * Switches to the new tab automatically.
 */
export async function createTab(url) {
  if (url) assertNavigable(url, { allowDomains: cfg.allowDomains || null });
  await ensureDefaultTab();

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

  const port = actualCdpPort || cfg.port;
  const info = await CDP.New({ port, url: url || "about:blank" });

  // Create a CDP connection for this specific target
  const newProtocol = await CDP({ target: info.id, port });
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

  const port = actualCdpPort || cfg.port;
  await CDP.Close({ id, port });

  const tab = tabs.get(id);
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
