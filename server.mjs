#!/usr/bin/env node
/**
 * bwb-browser — Browser Without Bloat MCP Server
 *
 * A lightweight browser automation MCP server using raw Chrome DevTools Protocol.
 * No Playwright, no Puppeteer — just CDP. Works on Termux/Android and everywhere else.
 *
 * Configuration (ordered by precedence: CLI arg > env var > default):
 *   --browser-path / BWB_CHROME_PATH        — Path to Chrome/Chromium executable
 *   --port / BWB_CDP_PORT                   — Remote debugging port (default: 0 = random free port)
 *   --user-data-dir / BWB_USER_DATA_DIR     — Browser profile directory
 *   --headless / BWB_HEADLESS               — Run headless (default: true)
 *   --screenshots-dir / BWB_SCREENSHOTS_DIR — Directory for saved screenshots
 *   --timeout / BWB_NAV_TIMEOUT             — Navigation timeout in ms (default: 30000)
 *   --lean / BWB_LEAN                       — Survival profile: capped renderers,
 *                                             silenced background services, tab cap,
 *                                             mayfly teardown (default: auto on Termux)
 *   --nuclear / BWB_NUCLEAR                 — Add --single-process (max saving,
 *                                             min stability). Opt-in only.
 *   --idle / BWB_IDLE_MS                    — Mayfly teardown after N ms idle
 *                                             (default: 5min lean, off desktop)
 *   --tab-max / BWB_TAB_MAX                 — Live-tab cap, oldest hibernated
 *                                             (default: 3 lean, unlimited desktop)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import CDP from "chrome-remote-interface";
import { execSync } from "child_process";
import { mkdirSync, readFileSync, existsSync } from "fs";
import { homedir, platform } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import {
  ensureBrowser, restartBrowser, stopBrowser, saveScreenshot,
  cfg, browser, browserExited, actualCdpPort,
  isTermux, pokeActivity, setIdleSuppressed,
} from "./lib/browser.mjs";

// ─── --setup mode ──────────────────────────────────────────────────
if (process.argv.includes('--setup')) {
  const { runSetup } = await import('./lib/setup.mjs');
  runSetup();
  process.exit(0);
}

import {
  gotoUrl, clickElement, fillElement, waitForSelector,
} from "./lib/helpers.mjs";

import {
  getActiveProtocol, createTab, closeTab, switchTab, listTabs, syncActiveTab, clearTabs,
  hibernateTab,
} from "./lib/tabs.mjs";

import { staticFetch } from "./lib/fetch.mjs";
import { sampleResources, assess, resourceFooter, resolveBudgets } from "./lib/vigil.mjs";

import { saveSession, loadSession, listSessions } from "./lib/session.mjs";
import { diagnosePage } from "./lib/diagnose.mjs";
import { applyRealisticProfile } from "./lib/fingerprint.mjs";
import { executeInstruction } from "./lib/act.mjs";

// ─── Config ───────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read version from package.json — single source of truth
const { version: BWB_VERSION } = JSON.parse(
  readFileSync(join(__dirname, 'package.json'), 'utf8')
);

function parseArgs() {
  const args = process.argv.slice(2);
  const cliCfg = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--browser-path": cliCfg.browserPath = args[++i]; break;
      case "--port": cliCfg.port = parseInt(args[++i], 10); break;
      case "--user-data-dir": cliCfg.userDataDir = args[++i]; break;
      case "--headless": cliCfg.headless = args[++i] !== "false"; break;
      case "--screenshots-dir": cliCfg.screenshotsDir = args[++i]; break;
      case "--timeout": cliCfg.navTimeout = parseInt(args[++i], 10); break;
      case "--lean": cliCfg.lean = args[++i] !== "false"; break;
      case "--nuclear": cliCfg.nuclear = args[++i] !== "false"; break;
      case "--idle": cliCfg.idleMs = parseInt(args[++i], 10); break;
      case "--tab-max": cliCfg.tabMax = parseInt(args[++i], 10); break;
      case "--version": console.log(`bwb-browser ${BWB_VERSION}`); process.exit(0);
      case "--help": printHelp(); process.exit(0);
    }
  }
  return cliCfg;
}

function printHelp() {
  console.log(`
 bwb-browser v${BWB_VERSION} — Browser Without Bloat

Browser automation for AI agents. Static-first, lean like air. 26 tools.
Raw CDP — no Playwright, no Puppeteer. Chromium starts only when JS demands it.

Built on Termux/Android. Runs everywhere — including 1GB VPS boxes.

USAGE:
  bwb [options]

OPTIONS:
  --browser-path <path>    Path to Chrome/Chromium binary
  --port <number>          CDP debug port (default: 0 = random)
  --user-data-dir <path>   Browser profile directory
  --headless <bool>        Run headless (default: true)
  --screenshots-dir <path> Directory to save screenshots
  --timeout <ms>           Navigation timeout in ms (default: 30000)
  --lean <bool>            Survival profile (default: auto on Termux)
  --nuclear                Add --single-process (max saving, min stability)
  --idle <ms>              Mayfly teardown after N ms idle (default: 5min lean)
  --tab-max <n>            Live-tab cap, oldest hibernated (default: 3 lean)
  --version                Print version
  --help                   Show this help

TOOLS (26):
  CORE BROWSING:
    browser_goto              Navigate (static-first, escalates to browser)
    browser_screenshot        Take a screenshot
    browser_html              Get page/selector HTML
    browser_text              Get page/selector text
    browser_back              Go back in history
    (title/url folded into browser_status — v4 breaking change)

  INTERACTION:
    browser_click             Click an element
    browser_fill              Fill an input field
    browser_elements          List interactive elements
    browser_eval              Execute JavaScript
    browser_setViewport       Change viewport size

  🔥 ADVANCED:
    browser_act               Natural language page interaction (one tool does it all)
    browser_watch             Live page event capture (console, network + resources)
    browser_diagnose          Full page health diagnostic
    browser_fingerprint       Realistic browser profile for testing
    browser_waitForSelector   Wait for element to appear/disappear

  MULTI-TAB:
    browser_newTab            Create a new tab
    browser_closeTab          Close a tab
    browser_switchTab         Switch to a tab (hibernated tabs wake)
    browser_listTabs          List all open tabs

  SESSION:
    browser_saveCookies       Save session cookies to disk
    browser_loadCookies       Load session cookies from disk
    browser_listSessions      List saved sessions

  ON-DEMAND (verbs ship, weight doesn't — backends install on consent):
    browser_download          Download media (needs system yt-dlp)
    browser_export            Export md/txt/html (pdf/docx/pptx need pip libs)

  LIFECYCLE:
    browser_status            Status + live resources + active profile
    browser_restart           Restart the browser

If bwb saves you time or money, consider supporting development:
  https://github.com/sponsors/krshforever
`);
}

// ─── Dependency Check ─────────────────────────────────────────────────────────

async function ensureDeps() {
  const { createRequire } = await import("module");
  const req = createRequire(import.meta.url);
  const needed = [
    "@modelcontextprotocol/sdk/server/mcp.js",
    "zod",
    "chrome-remote-interface",
  ];
  const missing = [];
  for (const spec of needed) {
    try { req.resolve(spec); } catch {
      missing.push(spec.split("/")[0].split("@")[0] || spec);
    }
  }
  if (missing.length > 0) {
    console.error(
      `\nMissing dependencies: ${missing.join(", ")}\n` +
       `Run: npm install -g bwb-browser\n` +
       `Or:  cd "${__dirname}" && npm install\n` +
       `Or:  npx bwb-browser\n`
    );
    process.exit(1);
  }
}

// ─── Apply Config ────────────────────────────────────────────────────────────

Object.assign(cfg, parseArgs());
cfg.port = cfg.port || parseInt(process.env.BWB_CDP_PORT || "0", 10);
cfg.headless = cfg.headless !== undefined ? cfg.headless : (process.env.BWB_HEADLESS !== "false");
cfg.userDataDir = cfg.userDataDir || process.env.BWB_USER_DATA_DIR || join(homedir(), ".cache", "bwb-browser");
cfg.screenshotsDir = cfg.screenshotsDir || process.env.BWB_SCREENSHOTS_DIR || (() => {
  // Auto-detect: Termux/Android path if available, else ~/bwb-screenshots/
  const androidPath = "/storage/emulated/0/Download/bwb-screenshots";
  if (platform() === "android" && existsSync("/storage/emulated/0/Download")) return androidPath;
  if (process.env.HOME?.includes("com.termux")) return androidPath;
  if (process.env.TERMUX_VERSION) return androidPath;
  return join(homedir(), "bwb-screenshots");
})();
cfg.navTimeout = cfg.navTimeout || parseInt(process.env.BWB_NAV_TIMEOUT || "30000", 10);
// v4 survival defaults: lean auto-detects Termux; mayfly + tab cap follow lean
// unless explicitly overridden. Desktop behavior unchanged (all off).
if (cfg.lean === null || cfg.lean === undefined) {
  if (process.env.BWB_LEAN !== undefined) cfg.lean = process.env.BWB_LEAN !== "false";
  else cfg.lean = isTermux();
}
if (cfg.nuclear === undefined || cfg.nuclear === null) {
  cfg.nuclear = process.env.BWB_NUCLEAR === "true";
}
if (cfg.idleMs === null || cfg.idleMs === undefined) {
  if (process.env.BWB_IDLE_MS !== undefined) cfg.idleMs = parseInt(process.env.BWB_IDLE_MS, 10);
  else cfg.idleMs = cfg.lean ? 5 * 60 * 1000 : 0;
}
if (cfg.tabMax === null || cfg.tabMax === undefined) {
  if (process.env.BWB_TAB_MAX !== undefined) cfg.tabMax = parseInt(process.env.BWB_TAB_MAX, 10);
  else cfg.tabMax = cfg.lean ? 3 : 0;
}
resolveBudgets(cfg.lean);

try { mkdirSync(cfg.screenshotsDir, { recursive: true }); } catch {}

// ─── Watch State (Live Page Event Capture) ─────────────────────────────────────

const WATCH_MAX_EVENTS = 5000;

function watchPush(event) {
  if (watchState.events.length >= WATCH_MAX_EVENTS) watchState.events.shift();
  watchState.events.push(event);
}

const watchState = { active: false, events: [], disposables: [] };

function cleanupWatch() {
  watchState.active = false;
  for (const dispose of watchState.disposables) { try { dispose(); } catch {} }
  watchState.disposables = [];
  watchState.events = [];
}

function setupWatch(events, cdp) {
  cleanupWatch();
  watchState.active = true;

  if (events.includes("console") || events.includes("all")) {
    cdp.Runtime.consoleAPICalled((params) => {
      watchPush({ type: "console", timestamp: Date.now(), level: params.type || "log",
        text: (params.args || []).map(a => a.value !== undefined ? String(a.value) : a.description || "").join(" ") });
    });
    cdp.Runtime.exceptionThrown((params) => {
      const d = params.exceptionDetails;
      watchPush({ type: "exception", timestamp: Date.now(), text: d?.exception?.description || d?.text || "Unknown exception" });
    });
  }
  if (events.includes("network") || events.includes("all")) {
    cdp.Network.requestWillBeSent((params) => {
      watchPush({ type: "network", timestamp: Date.now(), subtype: "request", url: params.request?.url || "", method: params.request?.method || "GET" });
    });
    cdp.Network.responseReceived((params) => {
      if (params.response?.url?.startsWith("data:")) return;
      watchPush({ type: "network", timestamp: Date.now(), subtype: "response", url: params.response?.url || "", status: params.response?.status || 0, mimeType: params.response?.mimeType || "" });
    });
  }
  if (events.includes("navigation") || events.includes("all")) {
    cdp.Page.frameNavigated((params) => {
      watchPush({ type: "navigation", timestamp: Date.now(), url: params.frame?.url || "" });
    });
  }
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({ name: "bwb-browser", version: BWB_VERSION });

// Tool implementations
const tools = {
  // ═══════════════ CORE BROWSING ═══════════════

  browser_goto: {
    description: "Navigate to a URL. Returns page title and URL. v4: static-first — plain pages are fetched + extracted with zero Chromium; JS pages escalate to CDP automatically (see mode field).",
    schema: { url: z.string().describe("URL to navigate to") },
    handler: async ({ url }) => {
      // Rung 1: static fetch. No browser spawned, no LMK risk, milliseconds.
      const attempt = await staticFetch(url, { timeout: Math.min(cfg.navTimeout, 15000) });
      if (attempt.mode === "static") {
        syncActiveTab(attempt.title, attempt.finalUrl);
        return { content: [{ type: "text", text: JSON.stringify({
          mode: "static", title: attempt.title, url: attempt.finalUrl,
          text: attempt.text, confidence: attempt.confidence,
          note: "Served without Chromium. Need interaction/screenshots? Use browser_act / browser_screenshot — that escalates to the browser.",
        }) }] };
      }
      if (attempt.mode === "error") {
        // Dead URL — CDP shares the same network, don't spawn Chromium for a 404.
        return { content: [{ type: "text", text: JSON.stringify({ mode: "error", error: attempt.error }) }] };
      }
      // Rung 2: escalate to Chromium (JS shell, auth wall, non-text).
      const cdp = await getActiveProtocol();
      const { Page, Runtime } = cdp;
      const result = await gotoUrl(Page, Runtime, url, cfg.navTimeout);
      syncActiveTab(result.title, result.url);
      return { content: [{ type: "text", text: JSON.stringify({ ...result, mode: "browser", escalated: attempt.reason }) }] };
    },
  },

  browser_screenshot: {
    description: "Take a screenshot of the current page. Pass a CSS selector to capture just that element.",
    schema: {
      fullPage: z.boolean().describe("Full page screenshot (default false)").optional(),
      quality: z.number().describe("JPEG quality 0-100 (default 80)").optional(),
      selector: z.string().describe("CSS selector to capture only that element (optional)").optional(),
    },
    handler: async ({ fullPage = false, quality = 80, selector }) => {
      const { Page, Runtime } = await getActiveProtocol();
      let clip;
      if (selector) {
        // Element capture: compute bounding rect in page coords, then clip
        const { result } = await Runtime.evaluate({
          expression: `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            const sx = window.scrollX || document.documentElement.scrollLeft;
            const sy = window.scrollY || document.documentElement.scrollTop;
            return JSON.stringify({ x: r.x + sx, y: r.y + sy, width: r.width, height: r.height });
          })()`,
          returnByValue: true,
        });
        const rect = result?.value ? JSON.parse(result.value) : null;
        if (!rect || !rect.width || !rect.height) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Element not found or not visible: ${selector}` }) }] };
        }
        clip = { ...rect, scale: 1 };
      }
      // captureBeyondViewport=false keeps clip math in viewport space; a 0-size clip
      // would be rejected by CDP, so guard against degenerate rects above.
      const { data } = await Page.captureScreenshot({
        format: "jpeg", quality,
        captureBeyondViewport: fullPage || !!clip,
        ...(clip ? { clip } : {}),
      });
      const savedPath = saveScreenshot(data);
      const response = { screenshot: `data:image/jpeg;base64,${data.slice(0, 40)}...`, captured: clip ? selector : (fullPage ? "full page" : "viewport") };
      if (savedPath) response.savedTo = savedPath;
      return { content: [
        { type: "image", data, mimeType: "image/jpeg" },
        { type: "text", text: JSON.stringify(response) },
      ]};
    },
  },

  browser_html: {
    description: "Get HTML source of the page or a CSS selector.",
    schema: { selector: z.string().describe("Optional CSS selector").optional() },
    handler: async ({ selector }) => {
      const { Runtime } = await getActiveProtocol();
      const expr = selector
        ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || ''`
        : "document.documentElement.outerHTML";
      const { result } = await Runtime.evaluate({ expression: expr });
      return { content: [{ type: "text", text: result?.value || "" }] };
    },
  },

  browser_text: {
    description: "Get visible text content of the page or a CSS selector.",
    schema: { selector: z.string().describe("Optional CSS selector").optional() },
    handler: async ({ selector }) => {
      const { Runtime } = await getActiveProtocol();
      const expr = selector
        ? `document.querySelector(${JSON.stringify(selector)})?.textContent || ''`
        : "document.body?.textContent || ''";
      const { result } = await Runtime.evaluate({ expression: expr });
      return { content: [{ type: "text", text: result?.value || "" }] };
    },
  },

  browser_back: {
    description: "Go back in browser history (like clicking the browser back button).",
    schema: {},
    handler: async () => {
      const { Page, Runtime } = await getActiveProtocol();
      // Native CDP back: walk history via navigation entries.
      // NOTE: Page.goBack doesn't exist in the bundled CDP 1.3 protocol —
      // getNavigationHistory + navigateToHistoryEntry is the native equivalent.
      // The wrapper returns history FLAT ({currentIndex, entries}), not {result:{...}}.
      const hist = await Page.getNavigationHistory();
      const entries = hist?.entries || [];
      const currentIdx = hist?.currentIndex ?? -1;
      if (currentIdx > 0 && entries[currentIdx - 1]) {
        await Page.navigateToHistoryEntry({ entryId: entries[currentIdx - 1].id });
      }
      await new Promise(r => setTimeout(r, Math.min(cfg.navTimeout, 1000)));
      const { result } = await Runtime.evaluate({ expression: "document.title" });
      syncActiveTab(result?.value, undefined);
      return { content: [{ type: "text", text: JSON.stringify({ title: result?.value || "" }) }] };
    },
  },

  // ═══════════════ INTERACTION ═══════════════

  browser_click: {
    description: "Click an element by CSS selector. Uses CDP Input.dispatchMouseEvent for native events.",
    schema: { selector: z.string().describe("CSS selector") },
    handler: async ({ selector }) => {
      const cdp = await getActiveProtocol();
      const { Page, Runtime, Input } = cdp;
      const info = await clickElement(Page, Runtime, Input, selector);
      return { content: [{ type: "text", text: JSON.stringify({ clicked: selector, tag: info.tag, text: info.text }) }] };
    },
  },

  browser_fill: {
    description: "Clear and fill an input field with text using native CDP Input.insertText.",
    schema: { selector: z.string().describe("CSS selector for input"), text: z.string().describe("Text to fill") },
    handler: async ({ selector, text }) => {
      const cdp = await getActiveProtocol();
      const { Page, Runtime, Input } = cdp;
      await fillElement(Page, Runtime, Input, selector, text);
      return { content: [{ type: "text", text: JSON.stringify({ filled: selector, text }) }] };
    },
  },

  browser_elements: {
    description: "List interactive elements by kind: links, buttons, inputs, headings.",
    schema: { kind: z.enum(["links", "buttons", "inputs", "headings"]).describe("Element kind") },
    handler: async ({ kind }) => {
      const { Runtime } = await getActiveProtocol();
      const selectors = {
        links: "document.querySelectorAll('a[href]')",
        buttons: "document.querySelectorAll('button, input[type=button], input[type=submit], [role=button]')",
        inputs: "document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select')",
        headings: "document.querySelectorAll('h1,h2,h3,h4,h5,h6')",
      };
      const { result } = await Runtime.evaluate({
        expression: `(() => {
          const items = Array.from(${selectors[kind]});
          return items.map(el => ({ tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 100), id: el.id || '', className: (el.className || '').toString().slice(0, 50) }));
        })()`,
        returnByValue: true,
      });
      return { content: [{ type: "text", text: JSON.stringify(result?.value || []) }] };
    },
  },

  browser_eval: {
    description: "Execute JavaScript in the page context.",
    schema: { expression: z.string().describe("JavaScript expression") },
    handler: async ({ expression }) => {
      const { Runtime } = await getActiveProtocol();
      const response = await Runtime.evaluate({ expression, returnByValue: true });
      if (response.exceptionDetails) {
        const exc = response.exceptionDetails;
        throw new Error(`JS Error: ${exc.exception?.description || exc.text || "Unknown JS error"}`);
      }
      const { result } = response;
      return { content: [{ type: "text", text: JSON.stringify(result?.value ?? result) }] };
    },
  },

  browser_setViewport: {
    description: "Change the viewport size (width × height). Useful for responsive testing.",
    schema: {
      width: z.number().min(320).max(7680).describe("Viewport width in pixels (default: 1280)"),
      height: z.number().min(240).max(4320).describe("Viewport height in pixels (default: 720)"),
    },
    handler: async ({ width = 1280, height = 720 }) => {
      const { Emulation } = await getActiveProtocol();
      await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false });
      return { content: [{ type: "text", text: JSON.stringify({ viewport: `${width}x${height}` }) }] };
    },
  },

  // ═══════════════ 🔥 ADVANCED ═══════════════

  browser_act: {
    description: "GROUNDBREAKING: Natural language page interaction. One tool call does what normally takes 5-10. Examples: 'search for laptops under $1000', 'click the login button', 'go to google.com', 'fill email with test@test.com', 'extract the prices', 'scroll down'. Uses rule-based DOM heuristics — no LLM dependency.",
    schema: { instruction: z.string().describe("Natural language instruction for what to do on the page") },
    handler: async ({ instruction }) => {
      const cdp = await getActiveProtocol();
      const result = await executeInstruction(cdp, instruction);
      if (result.url) syncActiveTab(result.title, result.url);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  },

  browser_watch: {
    description: "GROUNDBREAKING: Live capture of page events (console, network, navigation, exceptions). Start recording, browse around, then poll to see everything that happened.",
    schema: {
      action: z.enum(["start", "poll", "stop"]).describe("start=begin recording, poll=get events since last poll, stop=cleanup"),
      events: z.array(z.enum(["console", "network", "navigation", "all"])).describe("Event types to capture (default: all)").optional(),
    },
    handler: async ({ action, events = ["all"] }) => {
      if (action === "start") {
        const cdp = await getActiveProtocol();
        await cdp.Runtime.enable();
        await cdp.Network.enable();
        setupWatch(events, cdp);
        setIdleSuppressed(true); // recording in progress — mayfly must not teardown
        return { content: [{ type: "text", text: JSON.stringify({ status: "watching", events, msg: "Recording started. Poll to get events." }) }] };
      }
      if (action === "poll") {
        const snapshot = [...watchState.events];
        watchState.events = [];
        // Resource vigilance rides the existing poll rhythm — no new mechanism.
        let resources = null;
        try { resources = sampleResources(browser?.pid, listTabs().filter((t) => !t.hibernated).length); } catch {}
        return { content: [{ type: "text", text: JSON.stringify({ count: snapshot.length, events: snapshot, resources }) }] };
      }
      if (action === "stop") {
        const remaining = [...watchState.events];
        cleanupWatch();
        setIdleSuppressed(false);
        return { content: [{ type: "text", text: JSON.stringify({ status: "stopped", captured: remaining.length, events: remaining }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ error: "Invalid action" }) }] };
    },
  },

  browser_diagnose: {
    description: "Full page health diagnostic. Returns performance metrics, console errors, broken images, meta tags, and a health score. Like Lighthouse for your agent.",
    schema: {},
    handler: async () => {
      const cdp = await getActiveProtocol();
      const report = await diagnosePage(cdp);
      return { content: [{ type: "text", text: JSON.stringify(report) }] };
    },
  },

  browser_fingerprint: {
    description: "Apply a realistic browser fingerprint to reduce false-positive automation detection in CI/testing. Normalizes navigator.webdriver, plugins, languages, chrome.runtime, and user-agent for more realistic test conditions.",
    schema: {},
    handler: async () => {
      const cdp = await getActiveProtocol();
      const result = await applyRealisticProfile(cdp);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  },

  browser_waitForSelector: {
    description: "Wait for a CSS selector to appear (visible) or disappear from the DOM. Polls every 200ms until found or timeout.",
    schema: {
      selector: z.string().describe("CSS selector to wait for"),
      timeout: z.number().describe("Max wait time in ms (default: 10000)").optional(),
      disappear: z.boolean().describe("Wait for element to disappear instead of appear (default: false)").optional(),
      visible: z.boolean().describe("Require element to be visible (non-zero dimensions, default: true)").optional(),
    },
    handler: async ({ selector, timeout = 10000, disappear = false, visible = true }) => {
      const { Runtime } = await getActiveProtocol();
      await waitForSelector(Runtime, selector, { timeout, disappear, visible });
      return { content: [{ type: "text", text: JSON.stringify({ found: !disappear, disappeared: disappear }) }] };
    },
  },

  // ═══════════════ MULTI-TAB ═══════════════

  browser_newTab: {
    description: "Create a new browser tab, optionally navigate to a URL. Automatically switches to the new tab.",
    schema: { url: z.string().describe("URL to navigate to in the new tab (optional)").optional() },
    handler: async ({ url }) => {
      const result = await createTab(url);
      return { content: [{ type: "text", text: JSON.stringify({ tab: result.id, title: result.title, url: result.url }) }] };
    },
  },

  browser_closeTab: {
    description: "Close a browser tab by targetId. If no targetId provided, closes the active tab. Cannot close the last remaining tab — use browser_restart instead.",
    schema: { targetId: z.string().describe("Target tab ID to close (optional, defaults to active tab)").optional() },
    handler: async ({ targetId }) => {
      const result = await closeTab(targetId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  },

  browser_switchTab: {
    description: "Switch to a different browser tab by targetId.",
    schema: { targetId: z.string().describe("Target tab ID to switch to") },
    handler: async ({ targetId }) => {
      const result = await switchTab(targetId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  },

  browser_listTabs: {
    description: "List all open browser tabs with their IDs, titles, URLs, and active status.",
    schema: {},
    handler: async () => {
      const result = listTabs();
      return { content: [{ type: "text", text: JSON.stringify({ tabs: result, count: result.length }) }] };
    },
  },

  // ═══════════════ SESSION ═══════════════

  browser_saveCookies: {
    description: "Save the current browser session (cookies) to disk. 'Login once, agent works for days.' Sessions persist across agent and server restarts.",
    schema: { name: z.string().describe("Name for this session (e.g., 'twitter-login', 'gmail')") },
    handler: async ({ name }) => {
      const cdp = await getActiveProtocol();
      const result = await saveSession(name, cdp);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  },

  browser_loadCookies: {
    description: "Load a saved browser session (cookies) from disk. Navigate to the target domain after loading for the cookies to take effect.",
    schema: { name: z.string().describe("Session name to load (e.g., 'twitter-login')") },
    handler: async ({ name }) => {
      const cdp = await getActiveProtocol();
      const result = await loadSession(name, cdp);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  },

  browser_listSessions: {
    description: "List all saved browser sessions with cookie counts and save dates.",
    schema: {},
    handler: async () => {
      const sessions = listSessions();
      return { content: [{ type: "text", text: JSON.stringify({ sessions, count: sessions.length }) }] };
    },
  },

  // ═══════════════ ON-DEMAND CAPABILITIES ═══════════════
  // Verbs ship, weight doesn't. Heavy backends (yt-dlp, reportlab) are NEVER
  // bundled — probed at call time, installed only on explicit user consent.

  browser_download: {
    description: "Download media from a URL (video, audio, subtitles, thumbnail). Requires yt-dlp on the system — if missing, returns install instructions instead of failing silently. No silent installs, ever.",
    schema: {
      url: z.string().describe("Media URL"),
      format: z.enum(["best", "audio", "video", "subtitles", "thumbnail"]).describe("What to download").optional(),
      quality: z.enum(["best", "good", "worst"]).describe("Quality tier").optional(),
    },
    handler: async ({ url, format = "best", quality = "best" }) => {
      // No shell metachars ever reach execSync — http(s) only.
      if (!/^https?:\/\/[^\\s"';`$(){}|&<>]+$/i.test(url)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "refused: URL must be http(s) without shell metacharacters" }) }] };
      }
      let hasYtDlp = false;
      try {
        execSync("yt-dlp --version", { stdio: "ignore", timeout: 5000 });
        hasYtDlp = true;
      } catch {}
      if (!hasYtDlp) {
        return { content: [{ type: "text", text: JSON.stringify({
          needsInstall: true,
          tool: "yt-dlp",
          install: {
            termux: "pkg install yt-dlp",
            debian: "pip install yt-dlp",
            macos: "brew install yt-dlp",
          },
          ask: "yt-dlp is not installed. Reply YES (agent: ask the human) to install it, or install manually and retry. Nothing was downloaded.",
        }) }] };
      }
      const outDir = join(dirname(cfg.screenshotsDir), "bwb-downloads");
      try { mkdirSync(outDir, { recursive: true }); } catch {}
      const args = ["--no-playlist", "-P", outDir, "--print", "after_move:filepath"];
      if (format === "audio") args.push("-x", "--audio-format", "mp3");
      else if (format === "subtitles") args.push("--write-subs", "--skip-download");
      else if (format === "thumbnail") args.push("--write-thumbnail", "--skip-download");
      if (quality === "worst") args.push("-f", "worst");
      else if (quality === "good") args.push("-f", "best[height<=720]");
      args.push(url);
      try {
        const out = execSync(`yt-dlp ${args.map((a) => `"${a}"`).join(" ")}`, { encoding: "utf8", timeout: 600000, maxBuffer: 1024 * 1024 });
        const file = out.trim().split("\n").pop();
        return { content: [{ type: "text", text: JSON.stringify({ downloaded: file, format, quality }) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "download failed", detail: String(err.message || err).slice(0, 500) }) }] };
      }
    },
  },

  browser_export: {
    description: "Export findings/text to a file. md/txt/html always work (zero deps). docx/pdf/pptx need python libs — if missing, returns install instructions. No silent installs.",
    schema: {
      text: z.string().describe("Content to export (markdown accepted)"),
      format: z.enum(["md", "txt", "html", "pdf", "docx", "pptx"]).describe("Output format").optional(),
      output_path: z.string().describe("Where to write the file").optional(),
      title: z.string().describe("Document title").optional(),
    },
    handler: async ({ text, format = "md", output_path, title = "bwb export" }) => {
      const { writeFileSync: wfs } = await import("fs");
      const dest = output_path || join(dirname(cfg.screenshotsDir), `bwb-export-${Date.now()}.${format === "txt" ? "txt" : format === "html" ? "html" : "md"}`);
      if (["md", "txt"].includes(format)) {
        try { wfs(dest, text, "utf8"); } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `write failed: ${err.message}` }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ exported: dest, format }) }] };
      }
      if (format === "html") {
        const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        try { wfs(dest, `<!doctype html><html><head><meta charset="utf8"><title>${title}</title></head><body><pre>${esc}</pre></body></html>`, "utf8"); } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `write failed: ${err.message}` }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ exported: dest, format }) }] };
      }
      // pdf/docx/pptx need python libs — probe, then consent-gate.
      const need = { pdf: "reportlab", docx: "python-docx", pptx: "python-pptx" }[format];
      let have = false;
      try {
        execSync(`python3 -c "import ${need.split("-").join("_")}"`, { stdio: "ignore", timeout: 10000 });
        have = true;
      } catch {}
      if (!have) {
        return { content: [{ type: "text", text: JSON.stringify({
          needsInstall: true,
          tool: need,
          install: `pip install ${need}`,
          ask: `${need} is not installed. Reply YES (agent: ask the human) to install it, or install manually and retry. Nothing was written. md/txt/html export works without it.`,
        }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ ready: true, tool: need, note: "Backend present. Tell the agent to run the conversion explicitly — bwb never executes installs itself." }) }] };
    },
  },

  // ═══════════════ LIFECYCLE ═══════════════

  browser_status: {
    description: "Get browser and page status including opened tabs and connection info. v4: includes live resource readings (MCP + Chromium MB, budgets) so the agent sees pressure before Android does.",
    schema: {},
    handler: async () => {
      const status = { connected: false, port: cfg.port, actualPort: null, running: false, pid: null, tabs: [] };
      if (browser && !browserExited) {
        status.running = true;
        status.pid = browser.pid;
        status.tabs = listTabs();
        // actualCdpPort is the real bound port; cfg.port may be 0 (random).
        // Never fall back to a hardcoded 9222 — that could be another tool's browser.
        const listPort = actualCdpPort || cfg.port;
        if (listPort) {
          try {
            status.actualPort = actualCdpPort || cfg.port;
            const targets = await CDP.List({ port: listPort });
            status.connected = true;
            status.targets = targets.map(t => ({ type: t.type, url: t.url, title: t.title }));
          } catch { status.connected = false; }
        }
      }
      try {
        status.resources = sampleResources(browser?.pid, status.tabs.filter((t) => !t.hibernated).length);
        status.resources.state = assess(status.resources);
        status.profile = { lean: cfg.lean, nuclear: cfg.nuclear, idleMs: cfg.idleMs, tabMax: cfg.tabMax };
      } catch {}
      return { content: [{ type: "text", text: JSON.stringify(status) }] };
    },
  },

  browser_restart: {
    description: "Cleanly restart the browser process. Useful for freeing memory, clearing state, or recovering from issues during long-running sessions.",
    schema: {},
    handler: async () => {
      clearTabs(); // Kill stale tab connections before restart
      cleanupWatch(); // Detach event listeners from the dying protocol before it's gone
      const result = await restartBrowser();
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  },
};

// ─── Register & Start ─────────────────────────────────────────────────────────

// Single choke point for every tool call: poke the mayfly timer, then append
// a ~100-byte resource footer. On critical pressure, shed load BEFORE
// returning — hibernate oldest tabs, teardown at one tab — and say so.
for (const [name, tool] of Object.entries(tools)) {
  const inner = tool.handler;
  server.tool(name, tool.description, tool.schema, async (args) => {
    let result;
    try {
      result = await inner(args);
    } finally {
      try { pokeActivity(); } catch {}
    }
    try {
      const liveTabs = listTabs().filter((t) => !t.hibernated).length;
      const sample = sampleResources(browser?.pid, liveTabs);
      let note = "";
      if (assess(sample) === "critical" && browser && !browserExited) {
        // Evidence first: keep the peak numbers that triggered the shed.
        const peak = `${sample.mcpMb}+${sample.chromiumMb ?? "?"}MB`;
        // Shed oldest non-active tabs first; teardown at one tab. Journal keeps all.
        const victims = listTabs().filter((t) => !t.active && !t.hibernated).map((t) => t.id);
        for (const id of victims) {
          await hibernateTab(id);
          const after = sampleResources(browser?.pid, listTabs().filter((t) => !t.hibernated).length);
          note = `shed tab ${id.slice(0, 8)} at peak ${peak}`;
          Object.assign(sample, after);
          if (assess(sample) !== "critical") break;
        }
        if (assess(sample) === "critical" && listTabs().filter((t) => !t.hibernated).length <= 1) {
          try { await stopBrowser("oom-guard"); } catch {}
          note += `${note ? "; " : ""}browser stopped at peak ${peak} (oom-guard) — journal saved, next call resurrects`;
        }
      }
      if (result && Array.isArray(result.content)) {
        result.content.push({ type: "text", text: resourceFooter(sample, note) });
      }
    } catch {}
    return result;
  });
}

await ensureDeps();
const transport = new StdioServerTransport();
await server.connect(transport);
