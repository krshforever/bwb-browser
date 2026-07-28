#!/usr/bin/env node
/**
 * bwb-browser-termux — Browser Without Bloat MCP Server
 *
 * A lightweight browser automation MCP server using raw Chrome DevTools Protocol.
 * No Playwright, no Puppeteer — just CDP. Works on Termux/Android and everywhere else.
 *
 * Configuration (ordered by precedence: CLI arg > env var > default):
 *   --browser-path / BWB_CHROME_PATH     — Path to Chrome/Chromium executable
 *   --port / BWB_CDP_PORT                — Remote debugging port (default: 9222)
 *   --user-data-dir / BWB_USER_DATA_DIR  — Browser profile directory
 *   --headless / BWB_HEADLESS            — Run headless (default: true)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, execSync } from "child_process";
import CDP from "chrome-remote-interface";
import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";

// ─── Config ───────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const cfg = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--browser-path": cfg.browserPath = args[++i]; break;
      case "--port": cfg.port = parseInt(args[++i], 10); break;
      case "--user-data-dir": cfg.userDataDir = args[++i]; break;
      case "--headless": cfg.headless = args[++i] !== "false"; break;
      case "--version": console.log("bwb-browser-termux 1.0.8"); process.exit(0);
      case "--help": printHelp(); process.exit(0);
    }
  }
  return cfg;
}

function printHelp() {
  console.log(`
bwb-browser-termux — Browser Without Bloat MCP Server

USAGE:
  bwb [options]

OPTIONS:
  --browser-path <path>    Path to Chrome/Chromium binary
  --port <number>          CDP debug port (default: 9222)
  --user-data-dir <path>   Browser profile directory
  --headless <bool>        Run headless (default: true)
  --version                Print version
  --help                   Show this help

ENVIRONMENT VARIABLES:
  BWB_CHROME_PATH          Path to Chrome/Chromium binary
  BWB_CDP_PORT             CDP debug port
  BWB_USER_DATA_DIR        Browser profile directory
  BWB_HEADLESS             Run headless (true/false)

TOOLS (11):
  browser_goto       Navigate to a URL
  browser_screenshot Take a screenshot
  browser_html       Get page/selector HTML
  browser_text       Get page/selector text
  browser_click      Click an element
  browser_fill       Fill an input field
  browser_elements   List interactive elements
  browser_title      Get page title
  browser_url        Get current URL
  browser_eval       Execute JavaScript
  browser_status     Browser connection status
`);
}

function detectBrowser() {
  const cli = parseArgs();
  const envPath = process.env.BWB_CHROME_PATH;
  const cliPath = cli.browserPath;

  if (cliPath) return cliPath;
  if (envPath) return envPath;

  const os = platform();
  const home = homedir();

  // Ordered search paths per platform
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

// ─── Browser Lifecycle ────────────────────────────────────────────────────────

const cfg = { ...parseArgs() };
cfg.port = cfg.port || parseInt(process.env.BWB_CDP_PORT || "9222", 10);
cfg.headless = cfg.headless !== undefined ? cfg.headless : (process.env.BWB_HEADLESS !== "false");
cfg.userDataDir = cfg.userDataDir || process.env.BWB_USER_DATA_DIR || join(homedir(), ".cache", "bwb-browser");

let browser = null;
let protocol = null;
let browserStartup = null;

async function findBrowser() {
  const path = detectBrowser();
  if (!path) {
    throw new Error(
      "Cannot find Chrome/Chromium. Set BWB_CHROME_PATH env var or pass --browser-path.\n" +
      "Install on Termux: pkg install chromium\n" +
      "Install on Linux:  apt install chromium-browser\n" +
      "Install on macOS:  brew install --cask google-chrome"
    );
  }
  return path;
}

async function ensureBrowser() {
  if (protocol) return protocol;
  if (browserStartup) return browserStartup;

  let startResolve, startReject;
  browserStartup = new Promise((res, rej) => { startResolve = res; startReject = rej; });
  browserStartup.catch(() => { browserStartup = null; });

  (async () => {
    try {
      const browserPath = await findBrowser();
      const args = [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-setuid-sandbox",
        "--disable-software-rasterizer",
        "--remote-debugging-port=" + cfg.port,
        "--user-data-dir=" + cfg.userDataDir,
      ];

      if (!cfg.headless) args.shift();

      browser = spawn(browserPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
      });

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          startReject(new Error(`Browser startup timed out after 15s. Check: ${browserPath}`));
        }
      }, 15000);

      const listener = (data) => {
        const msg = data.toString();
        if (msg.includes("DevTools listening on")) {
          clearTimeout(timeout);
          resolved = true;
          CDP({ port: cfg.port })
            .then((p) => { protocol = p; startResolve(p); })
            .catch(startReject);
        }
      };

      browser.stderr.on("data", listener);
      browser.on("error", (err) => {
        if (!resolved) {
          clearTimeout(timeout);
          startReject(new Error(`Browser spawn failed: ${err.message}`));
        }
      });
    } catch (err) {
      browserStartup = null;
      startReject(err);
    }
  })();

  return browserStartup;
}

async function cleanup() {
  try {
    if (protocol) await protocol.close();
  } catch {}
  if (browser) {
    browser.kill("SIGKILL");
    setTimeout(() => browser?.kill("SIGTERM"), 1000);
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "bwb-browser-termux",
  version: "1.0.8",
});

// Tool implementations
const tools = {
  browser_goto: {
    description: "Navigate to a URL. Returns page title and URL.",
    schema: { url: z.string().describe("URL to navigate to") },
    handler: async ({ url }) => {
      const p = await ensureBrowser();
      const { Page, Runtime } = p;
      await Page.enable();
      await Page.navigate({ url });
      await new Promise(r => setTimeout(r, 2000));
      const { result } = await Runtime.evaluate({ expression: "document.title" });
      return { content: [{ type: "text", text: JSON.stringify({ title: result.value, url }) }] };
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
      const { data } = await Page.captureScreenshot({ format: "jpeg", quality, captureBeyondViewport: fullPage });
      return { content: [{ type: "image", data, mimeType: "image/jpeg" }] };
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
      return { content: [{ type: "text", text: result.value || "" }] };
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
      return { content: [{ type: "text", text: result.value || "" }] };
    },
  },

  browser_click: {
    description: "Click an element by CSS selector.",
    schema: { selector: z.string().describe("CSS selector") },
    handler: async ({ selector }) => {
      const p = await ensureBrowser();
      const { Runtime } = p;
      const { result } = await Runtime.evaluate({
        expression: `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return 'NOT_FOUND';if(typeof el.click==='function'){el.click();return 'CLICKED'}return 'NOT_CLICKABLE'})()`,
      });
      const status = result.value;
      if (status === "NOT_FOUND") throw new Error(`Element not found: ${selector}`);
      return { content: [{ type: "text", text: `Clicked ${selector}` }] };
    },
  },

  browser_fill: {
    description: "Clear and fill an input field with text.",
    schema: {
      selector: z.string().describe("CSS selector for input"),
      text: z.string().describe("Text to fill"),
    },
    handler: async ({ selector, text }) => {
      const p = await ensureBrowser();
      const { Runtime } = p;
      const { result } = await Runtime.evaluate({
        expression: `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return 'NOT_FOUND';el.value='';el.value=${JSON.stringify(text)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return 'FILLED'})()`,
      });
      if (result.value === "NOT_FOUND") throw new Error(`Element not found: ${selector}`);
      return { content: [{ type: "text", text: `Filled ${selector}` }] };
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
        expression: `(()=>{return Array.from(${selectors[kind]}).map(el=>({tag:el.tagName.toLowerCase(),text:(el.textContent||'').trim().slice(0,100),id:el.id||'',className:(el.className||'').toString().slice(0,50)}))})()`,
      });
      return { content: [{ type: "text", text: JSON.stringify(result.value) }] };
    },
  },

  browser_title: {
    description: "Get current page title.",
    schema: {},
    handler: async () => {
      const p = await ensureBrowser();
      const { Runtime } = p;
      const { result } = await Runtime.evaluate({ expression: "document.title" });
      return { content: [{ type: "text", text: result.value || "" }] };
    },
  },

  browser_url: {
    description: "Get current page URL.",
    schema: {},
    handler: async () => {
      const p = await ensureBrowser();
      const { Runtime } = p;
      const { result } = await Runtime.evaluate({ expression: "window.location.href" });
      return { content: [{ type: "text", text: result.value || "" }] };
    },
  },

  browser_eval: {
    description: "Execute JavaScript in the page context.",
    schema: { expression: z.string().describe("JavaScript expression") },
    handler: async ({ expression }) => {
      const p = await ensureBrowser();
      const { Runtime } = p;
      const { result } = await Runtime.evaluate({ expression });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  },

  browser_status: {
    description: "Get browser and page status including connected tabs.",
    schema: {},
    handler: async () => {
      try {
        const targets = await CDP.List({ port: cfg.port });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              connected: true,
              port: cfg.port,
              targets: targets.map(t => ({ type: t.type, url: t.url, title: t.title })),
            }),
          }],
        };
      } catch {
        return { content: [{ type: "text", text: JSON.stringify({ connected: false, port: cfg.port }) }] };
      }
    },
  },
};

// Register all tools
for (const [name, tool] of Object.entries(tools)) {
  server.tool(name, tool.description, tool.schema, tool.handler);
}

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
