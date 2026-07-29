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
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import CDP from "chrome-remote-interface";
import { mkdirSync, existsSync } from "fs";
import { homedir, platform } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import {
  ensureBrowser, restartBrowser, saveScreenshot,
  cfg, browser, browserExited, actualCdpPort,
} from "./lib/browser.mjs";

import {
  gotoUrl, clickElement, fillElement, waitForSelector,
} from "./lib/helpers.mjs";

import {
  getActiveProtocol, createTab, closeTab, switchTab, listTabs, syncActiveTab, clearTabs,
} from "./lib/tabs.mjs";

import { saveSession, loadSession, listSessions } from "./lib/session.mjs";
import { diagnosePage } from "./lib/diagnose.mjs";
import { applyRealisticProfile } from "./lib/fingerprint.mjs";
import { executeInstruction } from "./lib/act.mjs";

// ─── Config ───────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

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
      case "--version": console.log("bwb-browser 3.0.0"); process.exit(0);
      case "--help": printHelp(); process.exit(0);
    }
  }
  return cliCfg;
}

function printHelp() {
  console.log(`
bwb-browser v3.0.0 — Browser Without Bloat

Browser automation for AI agents. 76KB. 25 tools. Zero heavy dependencies.
Uses raw CDP — no Playwright, no Puppeteer, no 400MB downloads.

Built on Termux/Android. Runs everywhere. Weighs nothing.

USAGE:
  bwb [options]

OPTIONS:
  --browser-path <path>    Path to Chrome/Chromium binary
  --port <number>          CDP debug port (default: 0 = random)
  --user-data-dir <path>   Browser profile directory
  --headless <bool>        Run headless (default: true)
  --screenshots-dir <path> Directory to save screenshots
  --timeout <ms>           Navigation timeout in ms (default: 30000)
  --version                Print version
  --help                   Show this help

TOOLS (25):
  CORE BROWSING:
    browser_goto              Navigate to a URL
    browser_screenshot        Take a screenshot
    browser_html              Get page/selector HTML
    browser_text              Get page/selector text
    browser_title             Get page title
    browser_url               Get current URL
    browser_back              Go back in history

  INTERACTION:
    browser_click             Click an element
    browser_fill              Fill an input field
    browser_elements          List interactive elements
    browser_eval              Execute JavaScript
    browser_setViewport       Change viewport size

  🔥 ADVANCED:
    browser_act               Natural language page interaction (one tool does it all)
    browser_watch             Live page event capture (console, network)
    browser_diagnose          Full page health diagnostic
    browser_fingerprint       Realistic browser profile for testing
    browser_waitForSelector   Wait for element to appear/disappear

  MULTI-TAB:
    browser_newTab            Create a new tab
    browser_closeTab          Close a tab
    browser_switchTab         Switch to a different tab
    browser_listTabs          List all open tabs

  SESSION:
    browser_saveCookies       Save session cookies to disk
    browser_loadCookies       Load session cookies from disk
    browser_listSessions      List saved sessions

  LIFECYCLE:
    browser_status            Browser connection status
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

const server = new McpServer({ name: "bwb-browser", version: "3.0.0" });

// Tool implementations
const tools = {
  // ═══════════════ CORE BROWSING ═══════════════

  browser_goto: {
    description: "Navigate to a URL. Returns page title and URL.",
    schema: { url: z.string().describe("URL to navigate to") },
    handler: async ({ url }) => {
      const cdp = await getActiveProtocol();
      const { Page, Runtime } = cdp;
      const result = await gotoUrl(Page, Runtime, url, cfg.navTimeout);
      syncActiveTab(result.title, result.url);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  },

  browser_screenshot: {
    description: "Take a screenshot of the current page.",
    schema: {
      fullPage: z.boolean().describe("Full page screenshot (default false)").optional(),
      quality: z.number().describe("JPEG quality 0-100 (default 80)").optional(),
    },
    handler: async ({ fullPage = false, quality = 80 }) => {
      const { Page } = await getActiveProtocol();
      const { data } = await Page.captureScreenshot({ format: "jpeg", quality, captureBeyondViewport: fullPage });
      const savedPath = saveScreenshot(data);
      const response = { screenshot: `data:image/jpeg;base64,${data.slice(0, 40)}...` };
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

  browser_title: {
    description: "Get current page title.",
    schema: {},
    handler: async () => {
      const { Runtime } = await getActiveProtocol();
      const { result } = await Runtime.evaluate({ expression: "document.title" });
      return { content: [{ type: "text", text: result?.value || "" }] };
    },
  },

  browser_url: {
    description: "Get current page URL.",
    schema: {},
    handler: async () => {
      const { Runtime } = await getActiveProtocol();
      const { result } = await Runtime.evaluate({ expression: "window.location.href" });
      return { content: [{ type: "text", text: result?.value || "" }] };
    },
  },

  browser_back: {
    description: "Go back in browser history (like clicking the browser back button).",
    schema: {},
    handler: async () => {
      const { Page, Runtime } = await getActiveProtocol();
      await Page.goBack();
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
        return { content: [{ type: "text", text: JSON.stringify({ status: "watching", events, msg: "Recording started. Poll to get events." }) }] };
      }
      if (action === "poll") {
        const snapshot = [...watchState.events];
        watchState.events = [];
        return { content: [{ type: "text", text: JSON.stringify({ count: snapshot.length, events: snapshot }) }] };
      }
      if (action === "stop") {
        const remaining = [...watchState.events];
        cleanupWatch();
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
      const result = switchTab(targetId);
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

  // ═══════════════ LIFECYCLE ═══════════════

  browser_status: {
    description: "Get browser and page status including opened tabs and connection info.",
    schema: {},
    handler: async () => {
      const status = { connected: false, port: cfg.port, actualPort: null, running: false, pid: null, tabs: [] };
      if (browser && !browserExited) {
        status.running = true;
        status.pid = browser.pid;
        status.tabs = listTabs();
        try {
          if (actualCdpPort) {
            status.actualPort = actualCdpPort;
            const targets = await CDP.List({ port: actualCdpPort });
            status.connected = true;
            status.targets = targets.map(t => ({ type: t.type, url: t.url, title: t.title }));
          } else {
            const targets = await CDP.List({ port: cfg.port || 9222 });
            status.connected = true;
            status.targets = targets.map(t => ({ type: t.type, url: t.url, title: t.title }));
          }
        } catch { status.connected = false; }
      }
      return { content: [{ type: "text", text: JSON.stringify(status) }] };
    },
  },

  browser_restart: {
    description: "Cleanly restart the browser process. Useful for freeing memory, clearing state, or recovering from issues during long-running sessions.",
    schema: {},
    handler: async () => {
      clearTabs(); // Kill stale tab connections before restart
      const result = await restartBrowser();
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  },
};

// ─── Register & Start ─────────────────────────────────────────────────────────

for (const [name, tool] of Object.entries(tools)) {
  server.tool(name, tool.description, tool.schema, tool.handler);
}

await ensureDeps();
const transport = new StdioServerTransport();
await server.connect(transport);
