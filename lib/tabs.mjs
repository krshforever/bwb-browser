/**
 * bwb-browser — Multi-tab Management
 *
 * Manages multiple page targets (tabs) within a single Chrome browser instance.
 * Uses CDP's target system to create, close, switch, and list tabs.
 * Each tab gets its own CDP protocol connection.
 */

import CDP from "chrome-remote-interface";
import { ensureBrowser, protocol, actualCdpPort, cfg } from "./browser.mjs";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";

// ─── Tab Journal (working-set survival across LMK kills / mayfly teardown) ───
// Tiny JSON append on every mutation. Journal is the truth the next fresh
// browser restores from — cookies live in user-data-dir, tab URLs live here.

function journalPath() {
  if (!cfg.userDataDir) return null;
  return join(cfg.userDataDir, "bwb-tabs.json");
}

function saveJournal() {
  try {
    const path = journalPath();
    if (!path) return;
    const entries = [];
    for (const [id, tab] of tabs) {
      if (tab.url && tab.url !== "about:blank") {
        entries.push({ url: tab.url, title: tab.title || "", active: id === activeTabId });
      }
    }
    writeFileSync(path, JSON.stringify(entries));
  } catch {}
}

function loadJournal() {
  try {
    const path = journalPath();
    if (!path || !existsSync(path)) return [];
    const entries = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(entries) ? entries.filter((e) => e && e.url) : [];
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
 * Hibernate a tab: URL stays in the journal + visible in listTabs, but the
 * renderer is closed and memory freed. Woken transparently on switchTab.
 * Never hibernates the active tab — caller must switch away first.
 */
export async function hibernateTab(targetId) {
  const id = targetId || [...tabs.keys()].find((k) => k !== activeTabId && !tabs.get(k)?.hibernated);
  if (!id || !tabs.has(id)) return null;
  const tab = tabs.get(id);
  if (tab.hibernated) return { id, hibernated: true };
  const port = actualCdpPort || cfg.port;
  try { await CDP.Close({ id, port }); } catch {}
  if (tab.protocol && tab.protocol !== protocol) {
    try { await tab.protocol.close(); } catch {}
  }
  tabs.set(id, { protocol: null, title: tab.title, url: tab.url, hibernated: true });
  saveJournal();
  return { id, hibernated: true, url: tab.url };
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
 */
export async function restoreJournal() {
  const entries = loadJournal();
  if (!entries.length) return false;
  await ensureDefaultTab();
  const cap = cfg.tabMax && cfg.tabMax > 0 ? cfg.tabMax : entries.length;
  const wanted = entries.slice(0, Math.max(cap, 1));
  const port = actualCdpPort || cfg.port;
  let first = true;
  for (const entry of wanted) {
    if (first) {
      first = false;
      try {
        await protocol.Page.navigate({ url: entry.url });
        syncActiveTab(entry.title, entry.url);
      } catch {}
      continue;
    }
    try {
      const info = await CDP.New({ port, url: "about:blank" });
      const newProtocol = await CDP({ target: info.id, port });
      tabs.set(info.id, { protocol: newProtocol, title: entry.title || "", url: "", pendingUrl: entry.url });
    } catch {}
  }
  saveJournal();
  return true;
}

// ─── Create Tab ──────────────────────────────────────────────────────────────

/**
 * Creates a new browser tab and navigates to url (or about:blank).
 * Switches to the new tab automatically.
 */
export async function createTab(url) {
  await ensureDefaultTab();

  // Live-tab cap: hibernate the oldest non-active tab instead of growing
  // renderers until Android LMK notices. Journal keeps everything restorable.
  if (cfg.tabMax && cfg.tabMax > 0) {
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
  if (tab && tab.protocol && tab.protocol !== protocol) {
    try { await tab.protocol.close(); } catch {}
  }
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
