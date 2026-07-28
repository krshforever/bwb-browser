/**
 * bwb-browser — Multi-tab Management
 *
 * Manages multiple page targets (tabs) within a single Chrome browser instance.
 * Uses CDP's target system to create, close, switch, and list tabs.
 * Each tab gets its own CDP protocol connection.
 */

import CDP from "chrome-remote-interface";
import { ensureBrowser, protocol, actualCdpPort, cfg } from "./browser.mjs";

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
    if (tab.protocol) return tab.protocol;
  }

  // Fallback to default protocol
  return protocol;
}

// ─── Create Tab ──────────────────────────────────────────────────────────────

/**
 * Creates a new browser tab and navigates to url (or about:blank).
 * Switches to the new tab automatically.
 */
export async function createTab(url) {
  await ensureDefaultTab();

  const port = actualCdpPort || cfg.port;
  const info = await CDP.New({ port, url: url || "about:blank" });

  // Create a CDP connection for this specific target
  const newProtocol = await CDP({ target: info.id, port });
  tabs.set(info.id, { protocol: newProtocol, title: info.title || "", url: info.url || url || "" });
  activeTabId = info.id;

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

  return { closed: id, activeTab: activeTabId };
}

// ─── Switch Tab ──────────────────────────────────────────────────────────────

/**
 * Switches to a different tab by targetId.
 */
export function switchTab(targetId) {
  if (!targetId) throw new Error("No targetId provided");
  if (!tabs.has(targetId)) {
    throw new Error(`Tab not found: ${targetId}`);
  }

  activeTabId = targetId;
  const tab = tabs.get(targetId);
  return { id: targetId, title: tab.title, url: tab.url };
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
  }
}
