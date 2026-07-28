#!/usr/bin/env node
/**
 * bwb-browser — Browser Without Bloat MCP Server
 *
 * A lightweight browser automation MCP server using raw Chrome DevTools Protocol.
 * No Playwright, no Puppeteer — just CDP. Works on Termux/Android and everywhere else.
 *
 * Configuration (ordered by precedence: CLI arg > env var > default):
 *   --browser-path / BWB_CHROME_PATH        — Path to Chrome/Chromium executable
 *   --port / BWB_CDP_PORT                   — Remote debugging port (default: 9222)
 *   --user-data-dir / BWB_USER_DATA_DIR     — Browser profile directory
 *   --headless / BWB_HEADLESS               — Run headless (default: true)
 *   --screenshots-dir / BWB_SCREENSHOTS_DIR — Directory for saved screenshots
 *   --timeout / BWB_NAV_TIMEOUT             — Navigation timeout in ms (default: 30000)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, execSync } from "child_process";
import CDP from "chrome-remote-interface";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir, platform } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Config ───────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const args = process.argv.slice(2);
  const cfg = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--browser-path": cfg.browserPath = args[++i]; break;
      case "--port": cfg.port = parseInt(args[++i], 10); break;
      case "--user-data-dir": cfg.userDataDir = args[++i]; break;
      case "--headless": cfg.headless = args[++i] !== "false"; break;
      case "--screenshots-dir": cfg.screenshotsDir = args[++i]; break;
      case "--timeout": cfg.navTimeout = parseInt(args[++i], 10); break;
      case "--version": console.log("bwb-browser 2.0.1"); process.exit(0);
      case "--help": printHelp(); process.exit(0);
    }
  }
  return cfg;
}

function printHelp() {
  console.log(`
bwb-browser — Browser Without Bloat MCP Server

USAGE:
  bwb [options]

OPTIONS:
  --browser-path <path>    Path to Chrome/Chromium binary
  --port <number>          CDP debug port (default: 9222)
  --user-data-dir <path>   Browser profile directory
  --headless <bool>        Run headless (default: true)
  --screenshots-dir <path> Directory to save screenshots (default: /storage/emulated/0/Download/bwb-screenshots)
  --timeout <ms>           Navigation timeout in ms (default: 30000)
  --version                Print version
  --help                   Show this help

ENVIRONMENT VARIABLES:
  BWB_CHROME_PATH          Path to Chrome/Chromium binary
  BWB_CDP_PORT             CDP debug port
  BWB_USER_DATA_DIR        Browser profile directory
  BWB_HEADLESS             Run headless (true/false)
  BWB_SCREENSHOTS_DIR      Directory to save screenshots
  BWB_NAV_TIMEOUT          Navigation timeout in ms

TOOLS (15):
  browser_goto         Navigate to a URL
  browser_screenshot   Take a screenshot
  browser_html         Get page/selector HTML
  browser_text         Get page/selector text
  browser_click        Click an element
  browser_fill         Fill an input field
  browser_elements     List interactive elements
  browser_title        Get page title
  browser_url          Get current URL
  browser_eval         Execute JavaScript (with exception capture)
  browser_status       Browser connection status
  browser_watch        Live page event capture (console, network, navigation)
  browser_waitForSelector Wait for element to appear/disappear
  browser_setViewport  Change viewport size
  browser_back         Go back in history
`);
}

// ─── Dependency Check ─────────────────────────────────────────────────────────

// Verify all dependencies are resolvable before starting MCP server
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
    try {
      req.resolve(spec);
    } catch {
      missing.push(spec.split("/")[0].split("@")[0] || spec);
    }
  }
  if (missing.length > 0) {
    console.error(
      `\nMissing dependencies: ${missing.join(", ")}\n` +
      `Run: npm install -g bwb-browser-termux\n` +
      `Or:  cd "${__dirname}" && npm install\n` +
      `Or:  npx bwb-browser-termux\n`
    );
    process.exit(1);
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

const cfg = { ...parseArgs() };
cfg.port = cfg.port || parseInt(process.env.BWB_CDP_PORT || "0", 10);
cfg.headless = cfg.headless !== undefined ? cfg.headless : (process.env.BWB_HEADLESS !== "false");
cfg.userDataDir = cfg.userDataDir || process.env.BWB_USER_DATA_DIR || join(homedir(), ".cache", "bwb-browser");
cfg.screenshotsDir = cfg.screenshotsDir || process.env.BWB_SCREENSHOTS_DIR || "/storage/emulated/0/Download/bwb-screenshots";
cfg.navTimeout = cfg.navTimeout || parseInt(process.env.BWB_NAV_TIMEOUT || "30000", 10);

// Ensure screenshots directory exists
try { mkdirSync(cfg.screenshotsDir, { recursive: true }); } catch {}

let browser = null;
let protocol = null;
let browserStartup = null;
let browserExited = false;
let actualCdpPort = null; // actual port Chrome picked (parsed from stderr)

// ─── Kill Orphaned Chrome (Termux-safe) ───────────────────────────────────────

// `fuser -k` and `lsof` can't read /proc/net/tcp on Termux/Android (permission denied).
// Instead, kill by PID from `ps` — works on every platform.
function killOrphanedChrome() {
  try {
    execSync(
      `ps aux | grep -E "[c]hrome" | grep -v grep | awk '{print $2}' | xargs -r kill -9 2>/dev/null; true`,
      { encoding: "utf8", timeout: 5000 }
    );
  } catch {}
}

// ─── Browser Detection ────────────────────────────────────────────────────────

function findBrowserPath(cliPath) {
  if (cliPath) return cliPath;
  const envPath = process.env.BWB_CHROME_PATH;
  if (envPath) return envPath;

  const os = platform();
  const home = homedir();

  const candidates = {
    android: [
      "/data/data/com.termux/files/usr/bin/chromium-browser",
      "/data/data/com.termux/files/usr/bin/chromium",
      "/data/data/com.termux/files/usr/bin/google-chrome",
    ],
    linux: [
      "google-chrome",
      "chromium-browser",
      "chromium",
      "google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ],
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      join(home, "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"),
    ],
  };

  const osCandidates = candidates[os] || candidates.linux;
  for (const bin of osCandidates) {
    try {
      const path = execSync(`which "${bin}" 2>/dev/null || echo "no"`, { encoding: "utf8", timeout: 3000 }).trim();
      if (path && path !== "no") return path;
    } catch { /* try next */ }
    if (existsSync(bin)) return bin;
  }

  return null;
}

function assertBrowserExists(cliPath) {
  const path = findBrowserPath(cliPath);
  if (!path) {
    throw new Error(
      "Cannot find Chrome/Chromium. Set BWB_CHROME_PATH env var or pass --browser-path.\n" +
      "Install on Termux: pkg install chromium\n" +
      "Install on Linux:  apt install chromium-browser\n" +
      "Install on macOS:  brew install --cask google-chrome\n" +
      "Install on Windows: Download from https://www.google.com/chrome/"
    );
  }
  return path;
}

// ─── Browser Lifecycle ────────────────────────────────────────────────────────

async function ensureBrowser() {
  // If protocol is active, return it
  if (protocol && !browserExited) return protocol;

  // If another call is already starting the browser, join it
  if (browserStartup) return browserStartup;

  // Close stale protocol if browser was restarted
  if (protocol) {
    try { await protocol.close(); } catch {}
    protocol = null;
  }
  // Reset exit flag if trying to restart
  browserExited = false;
  actualCdpPort = null;

  let startResolve, startReject;
  browserStartup = new Promise((res, rej) => { startResolve = res; startReject = rej; });
  browserStartup.catch(() => { browserStartup = null; });

  (async () => {
    try {
      const browserPath = assertBrowserExists(cfg.browserPath);

      // Kill any lingering Chrome processes from previous sessions
      // Cannot use `fuser -k` on Termux (no /proc/net/tcp access)
      killOrphanedChrome();
      // Small pause for OS to release resources
      await new Promise(r => setTimeout(r, 500));

      // Port 0 = Chrome picks a random free port (avoids conflicts)
      const debugPort = cfg.port || 0;
      const args = [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-setuid-sandbox",
        "--disable-software-rasterizer",
        "--remote-debugging-port=" + debugPort,
        "--user-data-dir=" + cfg.userDataDir,
      ];

      if (!cfg.headless) args.shift();

      browser = spawn(browserPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
      });

      let resolved = false;

      // Mark browser as exited when process dies
      browser.on("exit", (code, signal) => {
        browserExited = true;
        if (!resolved) {
          // Browser died before CDP connected
          clearTimeout(startTimeout);
          startReject(new Error(`Browser exited with code ${code} (signal ${signal}) before CDP connected`));
        }
        // Don't reset protocol here — let the next ensureBrowser() call handle it
      });

      browser.on("error", (err) => {
        if (!resolved) {
          clearTimeout(startTimeout);
          startReject(new Error(`Browser spawn failed: ${err.message}`));
        }
      });

      const startTimeout = setTimeout(() => {
        if (!resolved) {
          browserExited = true;
          try { browser.kill("SIGKILL"); } catch {}
          startReject(new Error(`Browser startup timed out after 15s. Check: ${browserPath}`));
        }
      }, 15000);

      const listener = (data) => {
        const msg = data.toString();
        // Extract actual port from: "DevTools listening on ws://127.0.0.1:PORT/PATH"
        // CDP() accepts {port: N} — NOT a ws:// URL as endpoint
        const portMatch = msg.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
        if (portMatch) {
          actualCdpPort = parseInt(portMatch[1], 10);
          clearTimeout(startTimeout);
          resolved = true;
          CDP({ port: actualCdpPort })
            .then((p) => {
              protocol = p;
              startResolve(p);
            })
            .catch((err) => {
              try { browser.kill("SIGKILL"); } catch {}
              browserExited = true;
              startReject(new Error(`CDP connection failed: ${err.message}`));
            });
        }
      };

      browser.stderr.on("data", listener);
    } catch (err) {
      browserStartup = null;
      browserExited = true;
      startReject(err);
    }
  })();

  return browserStartup;
}

// ─── Navigation Helper ────────────────────────────────────────────────────────

async function gotoUrl(page, runtime, url, timeoutMs) {
  await page.enable();

  // Register event listeners BEFORE calling navigate
  // loadEventFired fires when page fully loads (CSS, images, etc.)
  const loadPromise = page.loadEventFired().then(() => true);
  // First meaningful paint — earlier than load for faster SPAs
  const domPromise = page.domContentEventFired().then(() => true);

  await page.navigate({ url });

  // Wait for load event OR timeout, whichever comes first
  await Promise.race([
    Promise.all([loadPromise, domPromise]),
    new Promise(r => setTimeout(() => r(false), timeoutMs)),
  ]);

  // Small grace for JS framework rendering
  await new Promise(r => setTimeout(r, 500));

  const { result } = await runtime.evaluate({ expression: "document.title" });
  return { title: result?.value || "", url };
}

// ─── Click Helper (uses CDP Input.dispatchMouseEvent) ─────────────────────────

async function clickElement(page, runtime, input, selector) {
  // Get element bounding box via JS
  const { result } = await runtime.evaluate({
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify({ error: 'NOT_FOUND' });
      const rect = el.getBoundingClientRect();
      return JSON.stringify({
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        width: rect.width,
        height: rect.height,
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 50),
      });
    })()`,
  });

  let info;
  try { info = JSON.parse(result.value); } catch {
    throw new Error(`Element not found: ${selector}`);
  }

  if (info.error === "NOT_FOUND") {
    throw new Error(`Element not found: ${selector}`);
  }

  // Also try native click for form elements
  await runtime.evaluate({
    expression: `document.querySelector(${JSON.stringify(selector)})?.click()`,
  });

  // Dispatch real mouse events via CDP Input domain
  const x = Math.round(info.x);
  const y = Math.round(info.y);
  await input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });

  return info;
}

// ─── Fill Helper (uses CDP Input.insertText) ──────────────────────────────────

async function fillElement(page, runtime, input, selector, text) {
  // Focus the element first
  const { result } = await runtime.evaluate({
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NOT_FOUND';
      el.focus();
      el.value = '';
      return 'FOCUSED';
    })()`,
  });

  if (result.value === "NOT_FOUND") {
    throw new Error(`Element not found: ${selector}`);
  }

  // Clear existing text via CDP Input domain
  await input.dispatchKeyEvent({ type: "keyDown", key: "Control" });
  await input.dispatchKeyEvent({ type: "keyDown", key: "a" });
  await input.dispatchKeyEvent({ type: "keyUp", key: "a" });
  await input.dispatchKeyEvent({ type: "keyUp", key: "Control" });
  await input.dispatchKeyEvent({ type: "keyDown", key: "Delete" });
  await input.dispatchKeyEvent({ type: "keyUp", key: "Delete" });

  // Insert text via CDP Input domain
  await input.insertText({ text });
}

// ─── Screenshot Helper ────────────────────────────────────────────────────────

function saveScreenshot(base64Data) {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `bwb-${timestamp}.jpeg`;
  const filepath = join(cfg.screenshotsDir, filename);
  try {
    mkdirSync(cfg.screenshotsDir, { recursive: true });
    writeFileSync(filepath, Buffer.from(base64Data, "base64"));
    return filepath;
  } catch (err) {
    return null;
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

let cleaningUp = false;

function cleanupSync() {
  if (cleaningUp) return;
  cleaningUp = true;
  try {
    if (browser) {
      browser.kill("SIGTERM");
      // Max 3s for graceful shutdown
      setTimeout(() => {
        try { browser?.kill("SIGKILL"); } catch {}
      }, 3000);
      browser = null;
    }
  } catch {}
}

async function cleanupAsync() {
  if (cleaningUp) return;
  cleaningUp = true;
  try {
    if (protocol) await protocol.close();
  } catch {}
  try {
    if (browser) {
      browser.kill("SIGTERM");
      await new Promise(r => setTimeout(r, 2000));
      try { browser?.kill("SIGKILL"); } catch {}
      browser = null;
    }
  } catch {}
}

process.on("exit", cleanupSync);
process.on("SIGINT", () => { cleanupSync(); process.exit(0); });
process.on("SIGTERM", () => { cleanupSync(); process.exit(0); });
process.on("SIGHUP", () => { cleanupSync(); process.exit(0); });

// ─── Watch State (Groundbreaking: Live Page Event Capture) ─────────────────────
//
// This is the feature NO other MCP browser server has:
// Agent calls browser_watch({action:"start"}) → browser starts recording console
// messages, network requests, navigations, and JS exceptions in real-time.
// Agent calls browser_watch({action:"poll"}) → gets ALL events since last poll.
// Agent calls browser_watch({action:"stop"}) → cleans up.
//
// No more flying blind — the agent can SEE what the page is doing internally.

const watchState = {
  active: false,
  events: [],
  disposables: [],
};

function cleanupWatch() {
  watchState.active = false;
  for (const dispose of watchState.disposables) {
    try { dispose(); } catch {}
  }
  watchState.disposables = [];
  watchState.events = [];
}

function setupWatch(events, protocol) {
  cleanupWatch();
  watchState.active = true;

  if (events.includes("console") || events.includes("all")) {
    protocol.Runtime.consoleAPICalled((params) => {
      watchState.events.push({
        type: "console",
        timestamp: Date.now(),
        level: params.type || "log",
        text: (params.args || [])
          .map((a) => a.value !== undefined ? String(a.value) : a.description || "")
          .join(" "),
      });
    });
    protocol.Runtime.exceptionThrown((params) => {
      const d = params.exceptionDetails;
      watchState.events.push({
        type: "exception",
        timestamp: Date.now(),
        text: d?.exception?.description || d?.text || "Unknown exception",
      });
    });
  }

  if (events.includes("network") || events.includes("all")) {
    protocol.Network.requestWillBeSent((params) => {
      watchState.events.push({
        type: "network",
        timestamp: Date.now(),
        subtype: "request",
        url: params.request?.url || "",
        method: params.request?.method || "GET",
      });
    });
    protocol.Network.responseReceived((params) => {
      // Only fire for actual pages/resources, not data: URIs
      if (params.response?.url?.startsWith("data:")) return;
      watchState.events.push({
        type: "network",
        timestamp: Date.now(),
        subtype: "response",
        url: params.response?.url || "",
        status: params.response?.status || 0,
        mimeType: params.response?.mimeType || "",
      });
    });
  }

  if (events.includes("navigation") || events.includes("all")) {
    protocol.Page.frameNavigated((params) => {
      watchState.events.push({
        type: "navigation",
        timestamp: Date.now(),
        url: params.frame?.url || "",
      });
    });
  }
}

// ─── waitForSelector Helper ──────────────────────────────────────────────────

async function waitForSelector(runtime, selector, opts = {}) {
  const timeout = opts.timeout || 10000;
  const disappear = opts.disappear || false;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const { result } = await runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify({ status: "NOT_FOUND" });
        const rect = el.getBoundingClientRect();
        const hidden = rect.width === 0 || rect.height === 0;
        const text = (el.textContent || "").trim().slice(0, 200);
        return JSON.stringify({ status: "FOUND", tag: el.tagName, text, hidden });
      })()`,
    });
    const info = JSON.parse(result?.value || "{}");

    if (disappear && info.status === "NOT_FOUND") return true;
    if (!disappear && info.status === "FOUND" && !info.hidden) return true;
    if (!disappear && info.status === "FOUND" && !opts.visible) return true;

    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(`browser_waitForSelector: "${selector}" not ${disappear ? "disappeared" : "found"} within ${timeout}ms`);
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "bwb-browser",
  version: "2.0.1",
});

// Tool implementations
const tools = {
  browser_goto: {
    description: "Navigate to a URL. Returns page title and URL.",
    schema: { url: z.string().describe("URL to navigate to") },
    handler: async ({ url }) => {
      const p = await ensureBrowser();
      const { Page, Runtime } = p;
      const result = await gotoUrl(Page, Runtime, url, cfg.navTimeout);
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
      const p = await ensureBrowser();
      const { Page } = p;
      const { data } = await Page.captureScreenshot({
        format: "jpeg",
        quality,
        captureBeyondViewport: fullPage,
      });
      // Save to disk for user access
      const savedPath = saveScreenshot(data);
      const response = { screenshot: `data:image/jpeg;base64,${data.slice(0, 40)}...` };
      if (savedPath) response.savedTo = savedPath;
      return {
        content: [
          { type: "image", data, mimeType: "image/jpeg" },
          { type: "text", text: JSON.stringify(response) },
        ],
      };
    },
  },

  browser_html: {
    description: "Get HTML source of the page or a CSS selector.",
    schema: { selector: z.string().describe("Optional CSS selector").optional() },
    handler: async ({ selector }) => {
      const p = await ensureBrowser();
      const { Runtime } = p;
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
      const p = await ensureBrowser();
      const { Runtime } = p;
      const expr = selector
        ? `document.querySelector(${JSON.stringify(selector)})?.textContent || ''`
        : "document.body?.textContent || ''";
      const { result } = await Runtime.evaluate({ expression: expr });
      return { content: [{ type: "text", text: result?.value || "" }] };
    },
  },

  browser_click: {
    description: "Click an element by CSS selector. Uses CDP Input.dispatchMouseEvent for native events.",
    schema: { selector: z.string().describe("CSS selector") },
    handler: async ({ selector }) => {
      const p = await ensureBrowser();
      const { Page, Runtime, Input } = p;
      const info = await clickElement(Page, Runtime, Input, selector);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ clicked: selector, tag: info.tag, text: info.text }),
        }],
      };
    },
  },

  browser_fill: {
    description: "Clear and fill an input field with text using native CDP Input.insertText.",
    schema: {
      selector: z.string().describe("CSS selector for input"),
      text: z.string().describe("Text to fill"),
    },
    handler: async ({ selector, text }) => {
      const p = await ensureBrowser();
      const { Page, Runtime, Input } = p;
      await fillElement(Page, Runtime, Input, selector, text);
      return { content: [{ type: "text", text: JSON.stringify({ filled: selector, text }) }] };
    },
  },

  browser_elements: {
    description: "List interactive elements by kind: links, buttons, inputs, headings.",
    schema: { kind: z.enum(["links", "buttons", "inputs", "headings"]).describe("Element kind") },
    handler: async ({ kind }) => {
      const p = await ensureBrowser();
      const { Runtime } = p;
      const selectors = {
        links: "document.querySelectorAll('a[href]')",
        buttons: "document.querySelectorAll('button, input[type=button], input[type=submit], [role=button]')",
        inputs: "document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select')",
        headings: "document.querySelectorAll('h1,h2,h3,h4,h5,h6')",
      };
      const { result } = await Runtime.evaluate({
        expression: `(() => {
          const items = Array.from(${selectors[kind]});
          return items.map(el => ({
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().slice(0, 100),
            id: el.id || '',
            className: (el.className || '').toString().slice(0, 50),
          }));
        })()`,
        returnByValue: true,
      });
      return { content: [{ type: "text", text: JSON.stringify(result?.value || []) }] };
    },
  },

  browser_title: {
    description: "Get current page title.",
    schema: {},
    handler: async () => {
      const p = await ensureBrowser();
      const { Runtime } = p;
      const { result } = await Runtime.evaluate({ expression: "document.title" });
      return { content: [{ type: "text", text: result?.value || "" }] };
    },
  },

  browser_url: {
    description: "Get current page URL.",
    schema: {},
    handler: async () => {
      const p = await ensureBrowser();
      const { Runtime } = p;
      const { result } = await Runtime.evaluate({ expression: "window.location.href" });
      return { content: [{ type: "text", text: result?.value || "" }] };
    },
  },

  browser_eval: {
    description: "Execute JavaScript in the page context.",
    schema: { expression: z.string().describe("JavaScript expression") },
    handler: async ({ expression }) => {
      const p = await ensureBrowser();
      const { Runtime } = p;
      // Runtime.evaluate returns { result: {...}, exceptionDetails?: {...} }
      // Check exceptionDetails BEFORE destructuring result
      const response = await Runtime.evaluate({ expression, returnByValue: true });
      if (response.exceptionDetails) {
        const exc = response.exceptionDetails;
        const msg = exc.exception?.description || exc.text || "Unknown JS error";
        throw new Error(`JS Error: ${msg}`);
      }
      const { result } = response;
      return { content: [{ type: "text", text: JSON.stringify(result?.value ?? result) }] };
    },
  },

  browser_status: {
    description: "Get browser and page status including connected tabs.",
    schema: {},
    handler: async () => {
      const status = { connected: false, port: cfg.port, actualPort: null, running: false, pid: null };
      if (browser && !browserExited) {
        status.running = true;
        status.pid = browser.pid;
        try {
          // Use actual port Chrome picked, or try configured port
          let targets;
          if (actualCdpPort) {
            status.actualPort = actualCdpPort;
            targets = await CDP.List({ port: actualCdpPort });
          } else {
            targets = await CDP.List({ port: cfg.port || 9222 });
          }
          status.connected = true;
          status.targets = targets.map(t => ({
            type: t.type,
            url: t.url,
            title: t.title,
          }));
        } catch {
          status.connected = false;
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(status) }] };
    },
  },

  // ─── GROUNDBREAKING: Live Browser Event Capture ─────────────────────────
  // No other MCP browser server gives the agent feedback from the page.
  // This turns bwb from "blind screenshot-taker" into "live debug partner."

  browser_watch: {
    description: "GROUNDBREAKING: Live capture of page events (console, network, navigation, exceptions). Start recording, browse around, then poll to see everything that happened. First tool of its kind in any MCP browser server.",
    schema: {
      action: z.enum(["start", "poll", "stop"]).describe("start=begin recording, poll=get events since last poll, stop=cleanup"),
      events: z.array(z.enum(["console", "network", "navigation", "all"])).describe("Event types to capture (default: all)").optional(),
    },
    handler: async ({ action, events = ["all"] }) => {
      if (action === "start") {
        const p = await ensureBrowser();
        // Enable domains needed for event capture
        await p.Runtime.enable();
        await p.Network.enable();
        setupWatch(events, p);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ status: "watching", events, msg: "Recording started. Call browser_watch({action:'poll'}) to get events." }),
          }],
        };
      }

      if (action === "poll") {
        const snapshot = [...watchState.events];
        watchState.events = [];
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ count: snapshot.length, events: snapshot }),
          }],
        };
      }

      if (action === "stop") {
        const remaining = [...watchState.events];
        cleanupWatch();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ status: "stopped", captured: remaining.length, events: remaining }),
          }],
        };
      }

      return { content: [{ type: "text", text: JSON.stringify({ error: "Invalid action" }) }] };
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
      const p = await ensureBrowser();
      const { Runtime } = p;
      await waitForSelector(Runtime, selector, { timeout, disappear, visible });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ found: !disappear, disappeared: disappear }),
        }],
      };
    },
  },

  browser_setViewport: {
    description: "Change the viewport size (width × height). Useful for responsive testing or capturing full-page screenshots at specific dimensions.",
    schema: {
      width: z.number().min(320).max(7680).describe("Viewport width in pixels (default: 1280)"),
      height: z.number().min(240).max(4320).describe("Viewport height in pixels (default: 720)"),
    },
    handler: async ({ width = 1280, height = 720 }) => {
      const p = await ensureBrowser();
      await p.Page.setViewport({ width, height });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ viewport: `${width}x${height}` }),
        }],
      };
    },
  },

  browser_back: {
    description: "Go back in browser history (like clicking the browser back button).",
    schema: {},
    handler: async () => {
      const p = await ensureBrowser();
      const { Page, Runtime } = p;
      await Page.navigate({ url: "javascript:history.back()" });
      await new Promise((r) => setTimeout(r, 500));
      const { result } = await Runtime.evaluate({ expression: "document.title" });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ title: result?.value || "" }),
        }],
      };
    },
  },
};

// Register all tools
for (const [name, tool] of Object.entries(tools)) {
  server.tool(name, tool.description, tool.schema, tool.handler);
}

// ─── Start ────────────────────────────────────────────────────────────────────

await ensureDeps();
const transport = new StdioServerTransport();
await server.connect(transport);
