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
 *   --attach-port / BWB_ATTACH_PORT         — Attach to an already-running
 *                                             browser's CDP port (e.g. 9222)
 *                                             instead of spawning. Guest mode:
 *                                             never spawns, kills, or restores.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import CDP from "chrome-remote-interface";
import { execFileSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync, realpathSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import {
  ensureBrowser, restartBrowser, stopBrowser, saveScreenshot,
  cfg, browser, browserExited, actualCdpPort, attached, cdpAddress,
  isTermux, pokeActivity, setIdleSuppressed,
} from "./lib/browser.mjs";

// ─── --setup mode ──────────────────────────────────────────────────
if (process.argv.includes('--setup')) {
  const { runSetup } = await import('./lib/setup.mjs');
  runSetup();
  process.exit(0);
}

// ─── Terminal subcommands (not MCP flags) ─────────────────────────
// `bwb pair` / `bwb unpair` / `bwb drishti` talk to the app, print, and exit.
if (["pair", "unpair", "drishti", "note", "notes"].includes(process.argv[2])) {
  const { runCli } = await import('./lib/drishti-cli.mjs');
  process.exit(await runCli(process.argv[2], process.argv.slice(3)));
}

import {
  gotoUrl, clickElement, fillElement, waitForSelector,
} from "./lib/helpers.mjs";
import {
  buildSnapshot, clickRef, fillRef, clickWarning, StaleRefError,
} from "./lib/snapshot.mjs";
import {
  hoverRef, selectRef, pressKey, scroll, dragRef, waitFor,
} from "./lib/interact.mjs";
import {
  attachTelemetry, readConsole, readNetwork, telemetryStats,
} from "./lib/telemetry.mjs";
import { storage, frames, extract, uploadFiles } from "./lib/extract.mjs";
import { setDialogPolicy, dialogStatus, answerDialog } from "./lib/dialog.mjs";

import {
  getActiveProtocol, createTab, closeTab, switchTab, listTabs, syncActiveTab, clearTabs,
  hibernateTab, setPendingStatic, getPendingStatic, materializeStatic, needsMaterialize,
} from "./lib/tabs.mjs";

import { staticFetch, capText } from "./lib/fetch.mjs";
import { sampleResources, assess, resourceFooter, resolveBudgets } from "./lib/vigil.mjs";

import { saveSession, loadSession, listSessions } from "./lib/session.mjs";
import { diagnosePage } from "./lib/diagnose.mjs";
import { applyRealisticProfile } from "./lib/fingerprint.mjs";
import { executeInstruction, redactIfSecret } from "./lib/act.mjs";
import { parseArgs, resolveConfig, ConfigError } from "./lib/config.mjs";
import { assertNavigable, assertHttpUrl, UrlPolicyError } from "./lib/urlpolicy.mjs";
import {
  applyDrishtiDefaults, detectDrishti, resolveContext, maskToken,
  humanStep, createStepReporter, runDrishtiAware, askHelp,
  waitForHandback, DrishtiPausedError, NoteFeed, getNotes,
} from "./lib/drishti.mjs";

// ─── Config ───────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read version from package.json — single source of truth
const { version: BWB_VERSION } = JSON.parse(
  readFileSync(join(__dirname, 'package.json'), 'utf8')
);

function printHelp() {
  console.log(`
 bwb-browser v${BWB_VERSION} — Browser Without Bloat

Browser automation for AI agents. Static-first, lean like air. 41 tools.
CDP over one thin client — no Playwright, no Puppeteer, no bundled browser.
Chromium starts only when JS demands it.

Built on Termux/Android. Runs everywhere — including 1GB VPS boxes.

USAGE:
  bwb [options]
  bwb pair [--port <n>]     Pair with the drishti app (one tap on the phone)
  bwb unpair                Forget the paired drishti token
  bwb drishti               Doctor: app, relay, token, tabs, control API

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
  --attach-port <n>        Attach to a running browser's CDP port (e.g. 9222).
                           Guest mode: no spawn, no kill, visible window.
  --drishti                Native drishti mode: attach to the drishti app, use
                           its paired token, pause on takeover, ask for sites
  --no-drishti             Force drishti mode off (it also auto-detects)
  --readonly               Refuse every state-changing tool (browse only)
  --allow-domains <list>   Comma-separated host allowlist for navigation
  --always-browser         Skip the static rung; always use Chromium
  --no-sandbox             Disable the Chromium sandbox (auto on Termux/root)
  --journal-full           Journal full URLs incl. query strings, auto-restore
  --version                Print version
  --help                   Show this help

ENVIRONMENT:
  BWB_CHROME_PATH, BWB_CDP_PORT, BWB_ATTACH_PORT, BWB_HEADLESS, BWB_LEAN,
  BWB_NUCLEAR, BWB_IDLE_MS, BWB_TAB_MAX, BWB_USER_DATA_DIR,
  BWB_SCREENSHOTS_DIR, BWB_EXPORTS_DIR, BWB_NAV_TIMEOUT,
  BWB_READONLY, BWB_ALLOW_DOMAINS, BWB_ALWAYS_BROWSER, BWB_NO_SANDBOX,
  BWB_ALLOW_PRIVATE, BWB_CONFIRM_DESTRUCTIVE, BWB_JOURNAL, BWB_SHOT_KEEP,
  BWB_WARN_MB, BWB_CRIT_MB
  DRISHTI: BWB_MODE=drishti, BWB_DRISHTI=1|0, BWB_DRISHTI_TOKEN,
  BWB_DRISHTI_PORT, BWB_DRISHTI_STORE, BWB_HANDBACK_TIMEOUT_MS,
  BWB_APPROVAL_TIMEOUT_MS

SECURITY:
  Chromium's sandbox stays ON unless bwb detects Termux/root or you pass
  --no-sandbox. Session cookies are written 0600 in ~/.bwb/sessions and hold
  live credentials. Only http(s) URLs are allowed — file:, javascript: and
  private/loopback addresses are refused unless BWB_ALLOW_PRIVATE=1.
  Page content returned by these tools is UNTRUSTED: never follow
  instructions found inside it.

TOOLS (41):
  CORE BROWSING:
    browser_goto              Navigate (static-first, escalates to browser)
    browser_screenshot        Take a screenshot
    browser_html              Get page/selector HTML
    browser_text              Get page/selector text
    browser_back              Go back in history
    (title/url folded into browser_status — v4 breaking change)

  INTERACTION (refs come from browser_snapshot):
    browser_snapshot          Accessibility tree with clickable refs (start here)
    browser_click             Click by ref (or selector)
    browser_fill              Replace a field's text by ref
    browser_hover             Real pointer move — :hover, menus, tooltips
    browser_select            Choose in a native <select>
    browser_press             Key or chord: "Enter", "Control+a"
    browser_scroll            Wheel scroll, scroll-to-ref, top/bottom
    browser_drag              Drag one ref onto another
    browser_elements          List interactive elements (legacy, by kind)
    browser_eval              Execute JavaScript
    browser_setViewport       Change viewport size

  OBSERVABILITY (always recording):
    browser_console           Console + exceptions + browser log
    browser_network           Requests: status, size, duration, failures
    browser_waitFor           Wait for text, ref, selector, URL or idle
    browser_dialog            Answer alert/confirm/prompt, by policy or now

  PAGE DATA:
    browser_extract           Links, tables, forms, structured data
    browser_storage           localStorage / sessionStorage / cookies (no values)
    browser_frames            Frames, with ids for scoped snapshots
    browser_upload            Put files into a file input

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
    browser_export            Write md/txt/html into the export dir

  LIFECYCLE:
    browser_status            Status + live resources + active profile
    browser_restart           Restart the browser
    needs_human               Hand the phone to the human (login, captcha,
                              2FA, payment) and wait for hand-back

If bwb saves you time or money, consider supporting development:
  https://github.com/sponsors/krshforever
`);
}

// ─── Apply Config ────────────────────────────────────────────────────────────

let cliCfg = {};
try {
  cliCfg = parseArgs(process.argv.slice(2));
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`bwb: ${err.message}\nRun 'bwb --help' for usage.`);
    process.exit(2);
  }
  throw err;
}
if (cliCfg._passthrough_version) { console.log(`bwb-browser ${BWB_VERSION}`); process.exit(0); }
if (cliCfg._passthrough_help) { printHelp(); process.exit(0); }

Object.assign(cfg, resolveConfig(cliCfg, process.env, { isTermux: isTermux() }));

// ─── Drishti mode resolution ─────────────────────────────────────────────────
// explicit --drishti / BWB_MODE=drishti → on (hard error if unpaired)
// explicit --no-drishti → off
// otherwise AUTO: paired store + GET /bwb/hello reporting app "drishti".
if (cfg.drishti === null) {
  const detected = await detectDrishti();
  if (detected.enabled) applyDrishtiDefaults(cfg);
} else if (cfg.drishti) {
  try {
    applyDrishtiDefaults(cfg);
  } catch (err) {
    console.error(`bwb: ${err.message}`);
    process.exit(2);
  }
}

resolveBudgets(cfg.lean);

// Control-plane helpers. dctx is null outside drishti mode: no status posts, no
// /bwb/* calls, and tools behave exactly as they always have.
const dctx = cfg.drishti ? resolveContext() : null;
const stepReporter = dctx ? createStepReporter(dctx) : null;

try { mkdirSync(cfg.screenshotsDir, { recursive: true }); } catch {}

// True once browser_loadCookies succeeds: a page that needs the session's
// cookies must not be answered by an anonymous static fetch (F04).
let cookiesLoaded = false;

// ─── Export Path Confinement (F07) ────────────────────────────────────────────
// browser_export used to accept any output_path: an injected page could steer
// the agent into overwriting ~/.bashrc. Writes are now confined to one
// directory, with an extension allowlist, symlink checks, and no silent
// overwrite.

const EXPORT_EXTS = { md: ".md", txt: ".txt", html: ".html" };

function exportsDir() {
  return process.env.BWB_EXPORTS_DIR || join(dirname(cfg.screenshotsDir), "bwb-exports");
}

/**
 * Resolve a caller-supplied filename inside the export dir.
 * @returns {{path: string}|{error: Error}}
 */
export function resolveExportPath(filename, format, overwrite = false) {
  const dir = exportsDir();
  const ext = EXPORT_EXTS[format];
  if (!ext) return { error: new Error(`Unsupported export format: ${format}`) };

  let base;
  if (filename) {
    base = filename;
    // An absolute path or a traversal is a refusal, not something to normalize
    // into shape: the caller is told the file name, not the path.
    if (base.includes("/") || base.includes("\\") || base === "..") {
      return { error: new Error(`Refusing path outside the export directory: ${filename}. Pass a plain file name.`) };
    }
  } else {
    base = `bwb-export-${Date.now()}${ext}`;
  }
  if (!base.endsWith(ext)) base += ext;

  const path = join(dir, base);
  // Resolve symlinks on the directory too, or a symlinked export dir is a
  // free pass out of the sandbox.
  let realDir;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    realDir = realpathSync(dir);
  } catch (err) {
    return { error: new Error(`Export directory unusable: ${err.message}`) };
  }
  const realPath = join(realDir, base);
  if (!realPath.startsWith(realDir + "/")) {
    return { error: new Error(`Refusing path outside the export directory: ${filename}`) };
  }
  if (!overwrite) {
    try {
      if (statSync(realPath)) return { error: new Error(`${base} already exists. Pass overwrite:true to replace it.`) };
    } catch { /* does not exist — good */ }
  }
  return { path: realPath };
}

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

// chrome-remote-interface's event subscriptions return an UNSUBSCRIBE
// function. The old code discarded every one of them, so cleanupWatch() removed
// nothing: calling `start` twice doubled the events, and listeners stayed bound
// to a tab that had been switched away from or closed.
function setupWatch(events, cdp) {
  cleanupWatch();
  watchState.active = true;
  const keep = (dispose) => { if (typeof dispose === "function") watchState.disposables.push(dispose); };
  const want = (kind) => events.includes("all") || events.includes(kind);

  if (want("console")) {
    keep(cdp.Runtime.consoleAPICalled((params) => {
      watchPush({ type: "console", timestamp: Date.now(), level: params.type || "log",
        text: (params.args || []).map(a => a.value !== undefined ? String(a.value) : a.description || "").join(" ") });
    }));
    keep(cdp.Runtime.exceptionThrown((params) => {
      const d = params.exceptionDetails;
      watchPush({ type: "exception", timestamp: Date.now(), text: d?.exception?.description || d?.text || "Unknown exception" });
    }));
  }
  if (want("network")) {
    keep(cdp.Network.requestWillBeSent((params) => {
      watchPush({ type: "network", timestamp: Date.now(), subtype: "request", url: params.request?.url || "", method: params.request?.method || "GET" });
    }));
    keep(cdp.Network.responseReceived((params) => {
      if (params.response?.url?.startsWith("data:")) return;
      watchPush({ type: "network", timestamp: Date.now(), subtype: "response", url: params.response?.url || "", status: params.response?.status || 0, mimeType: params.response?.mimeType || "" });
    }));
  }
  if (want("navigation")) {
    keep(cdp.Page.frameNavigated((params) => {
      watchPush({ type: "navigation", timestamp: Date.now(), url: params.frame?.url || "" });
    }));
  }
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({ name: "bwb-browser", version: BWB_VERSION });

/** Uniform error envelope: tools report failures as data, never as throws. */
function errResult(err, prefix = "") {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: JSON.stringify({ error: prefix ? `${prefix}: ${message}` : message }) }] };
}

/** Tools that change state — disabled wholesale by --readonly / BWB_READONLY. */
const WRITE_TOOLS = new Set([
  "browser_click", "browser_fill", "browser_eval", "browser_act",
  "browser_export", "browser_download", "browser_saveCookies", "browser_restart",
  "browser_newTab", "browser_closeTab", "browser_switchTab",
  "browser_setViewport", "browser_fingerprint", "browser_back",
]);

// Tool implementations
/**
 * Refs from the most recent snapshot, PER TAB.
 *
 * Keyed by the CDP client, which is one per tab. Two agents on two tabs must
 * not overwrite each other's refs — that was a real bug waiting to happen the
 * moment more than one tab is open. Not persisted: a ref only means something
 * against the DOM that produced it, and a ref that outlives its snapshot must
 * resolve to nothing rather than to whatever moved into that slot.
 */
const snapshots = new WeakMap();
const EMPTY_SNAPSHOT = { id: null, refs: {}, at: 0 };
const rememberSnapshot = (cdp, snap) => {
  const record = { id: snap.id, refs: snap.refs, at: Date.now() };
  if (cdp && typeof cdp === "object") snapshots.set(cdp, record);
  return record;
};
const refsFor = (cdp) => (cdp && snapshots.get(cdp)) || EMPTY_SNAPSHOT;

const tools = {
  // ═══════════════ CORE BROWSING ═══════════════

  browser_goto: {
    description: "Open a URL. `mode:\"auto\"` (default) tries a plain HTTP fetch with article extraction first (fast, no browser) and falls back to Chromium for JS-rendered pages, login walls, or when cookies are loaded; `mode:\"browser\"` always uses Chromium. Returns `{mode, title, url, text, links}`. Only http(s) URLs are allowed. After a static result the next browser tool brings Chromium to that same URL automatically.",
    schema: {
      url: z.string().describe("URL to navigate to (http/https only)"),
      mode: z.enum(["auto", "static", "browser"]).describe("auto (default): static first, browser on demand. static: never spawn Chromium. browser: always use Chromium.").optional(),
      maxChars: z.number().describe("Cap on returned text (default 20000)").optional(),
      raw: z.boolean().describe("Return the raw HTML text instead of Readability output").optional(),
    },
    handler: async ({ url, mode = "auto", maxChars = 20000, raw = false }) => {
      try {
        assertNavigable(url, { allowDomains: cfg.allowDomains || null });
      } catch (err) {
        return errResult(err);
      }

      // ─── Shared escalation path (F04): one navigate() for every entry point ───
      const navigateInBrowser = async () => {
        const cdp = await getActiveProtocol();
        setPendingStatic(null);
        let result;
        try {
          result = await gotoUrl(cdp.Page, cdp.Runtime, url, cfg.navTimeout, {
            allowDomains: cfg.allowDomains || null,
          });
        } catch (err) {
          // A failed navigation is DATA, not a protocol-level exception: the
          // agent needs to read "ERR_NAME_NOT_RESOLVED", not a stack trace.
          throw Object.assign(err, { isToolError: true });
        }
        syncActiveTab(result.title, result.url);
        return { ...result, mode: "browser" };
      };

      // Skip the static rung when it would answer DIFFERENTLY than the browser
      // would: cookies loaded this run, a browser already showing a real page,
      // or the global BWB_ALWAYS_BROWSER override.
      const browserBusy = browser && !browserExited;
      const useStatic =
        mode === "static" ||
        (mode === "auto" && !cfg.alwaysBrowser && !cookiesLoaded && !browserBusy);

      if (useStatic) {
        const attempt = await staticFetch(url, {
          timeout: Math.min(cfg.navTimeout, 15000),
          allowPrivate: cfg.allowPrivate,
          allowDomains: cfg.allowDomains?.length ? cfg.allowDomains : null,
          maxChars,
          raw,
        });
        if (attempt.mode === "static") {
          // Record it: the first tool that needs Chromium navigates there.
          setPendingStatic(attempt.finalUrl || url, attempt.title);
          return { content: [{ type: "text", text: JSON.stringify({
            mode: "static", title: attempt.title, url: attempt.finalUrl,
            text: attempt.text, links: attempt.links || [], confidence: attempt.confidence,
            ...(attempt.truncated ? { truncated: true, nextOffset: attempt.nextOffset } : {}),
            note: "Served without Chromium. Interaction or screenshots start the browser on this same URL.",
          }) }] };
        }
        if (attempt.mode === "error") {
          // Dead URL — CDP shares the same network, don't spawn Chromium for a 404.
          return { content: [{ type: "text", text: JSON.stringify({ mode: "error", error: attempt.error }) }] };
        }
        // Rung 2: escalate (JS shell, auth wall, non-text content).
        const result = await navigateInBrowser();
        return { content: [{ type: "text", text: JSON.stringify({ ...result, escalated: attempt.reason }) }] };
      }

      const result = await navigateInBrowser();
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
    description: "Return the page HTML (or the outerHTML of the first element matching a CSS selector). Capped at `maxChars` (default 200000). Use browser_text for human-readable text, browser_elements for a clickable list.",
    schema: {
      selector: z.string().describe("Optional CSS selector").optional(),
      maxChars: z.number().describe("Cap on returned HTML (default 200000)").optional(),
    },
    handler: async ({ selector, maxChars = 200000 }) => {
      const { Runtime } = await getActiveProtocol();
      const expr = selector
        ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || ''`
        : "document.documentElement.outerHTML";
      const { result } = await Runtime.evaluate({ expression: expr });
      const html = result?.value || "";
      return { content: [{ type: "text", text: capText(html, maxChars).text }] };
    },
  },

  browser_text: {
    description: "Return the visible text (`innerText`) of the page or of the first element matching a CSS selector — no script/style bodies, no hidden nodes. Capped at `maxChars` (default 20000; `truncated:true` when cut).",
    schema: {
      selector: z.string().describe("Optional CSS selector").optional(),
      maxChars: z.number().describe("Cap on returned text (default 20000)").optional(),
    },
    handler: async ({ selector, maxChars = 20000 }) => {
      const { Runtime } = await getActiveProtocol();
      // innerText, not textContent: textContent includes <script>/<style>
      // bodies and display:none subtrees, which is not "visible text".
      const expr = selector
        ? `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`
        : `(document.body?.innerText ?? document.body?.textContent ?? '')`;
      const { result } = await Runtime.evaluate({ expression: expr });
      const text = result?.value || "";
      const capped = capText(text, maxChars);
      return {
        content: [{ type: "text", text: JSON.stringify(capped.truncated
          ? { text: capped.text, truncated: true, nextOffset: capped.nextOffset }
          : { text: capped.text }) }],
      };
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
    description: "Click an element. Prefer `ref` from browser_snapshot — it is a fact about the node the browser reported, not a guess about the page's CSS. `selector` still works. Scrolls into view and hit-tests the click point first; the result reports `hit` (whether the point really was that element) and `landedOn` (what was actually there).",
    schema: {
      selector: z.string().describe("CSS selector (use ref instead when you have one)").optional(),
      ref: z.string().describe("Ref from the latest browser_snapshot, e.g. e12").optional(),
    },
    handler: async ({ selector, ref }) => {
      if (!selector && !ref) throw new Error("browser_click needs either a ref (from browser_snapshot) or a selector");
      const cdp = await getActiveProtocol();
      if (ref) {
        const info = await clickRef(cdp, refsFor(cdp).refs, ref);
        return { content: [{ type: "text", text: JSON.stringify({
          clicked: ref, element: info.element, via: info.via,
          hit: info.hit, landedOn: info.landedOn,
          ...(clickWarning(info) ? { warning: clickWarning(info) } : {}),
        }) }] };
      }
      const { Page, Runtime, Input } = cdp;
      const info = await clickElement(Page, Runtime, Input, selector);
      return { content: [{ type: "text", text: JSON.stringify({
        clicked: selector, tag: info.tag, text: info.text,
        hit: info.hit, landedOn: info.landedOn,
        ...(clickWarning(info) ? { warning: clickWarning(info) } : {}),
      }) }] };
    },
  },

  browser_fill: {
    description: "Clear a field and replace its content. Prefer `ref` from browser_snapshot; `selector` still works. Uses native CDP Input.insertText, so the page's own input events fire. Returns the length only — never the text — when the field is a password or looks like a secret.",
    schema: {
      selector: z.string().describe("CSS selector for the input (use ref instead when you have one)").optional(),
      ref: z.string().describe("Ref from the latest browser_snapshot, e.g. e12").optional(),
      text: z.string().describe("Text to fill"),
    },
    handler: async ({ selector, ref, text }) => {
      if (!selector && !ref) throw new Error("browser_fill needs either a ref (from browser_snapshot) or a selector");
      const cdp = await getActiveProtocol();
      if (ref) {
        const info = await fillRef(cdp, refsFor(cdp).refs, ref, text);
        const secretField = info.tag === "input" && /pass/i.test(info.element) ||
          /pass|secret|token|otp|pin|cvv|card/i.test(String(info.element));
        return { content: [{ type: "text", text: JSON.stringify({
          filled: ref, element: info.element,
          ...(secretField ? { length: info.length, redacted: true } : { length: info.length }),
        }) }] };
      }
      const { Page, Runtime, Input } = cdp;
      const info = await fillElement(Page, Runtime, Input, selector, text);
      // Redact on what the FIELD is, not only what the selector is called:
      // `#pw` is a password field just as much as `#password` is.
      const secretField = info.type === "password" ||
        /pass|secret|token|otp|pin|cvv|card/i.test(selector);
      const echo = secretField
        ? { length: [...String(text)].length, redacted: true }
        : redactIfSecret(selector, text);
      return { content: [{ type: "text", text: JSON.stringify({ filled: selector, ...echo }) }] };
    },
  },

  browser_snapshot: {
    description: "Accessibility tree of the page as indented text, with `[ref=e12]` on every actionable node. The fastest way to understand an unfamiliar page, and the stable way to act on it: pass the ref to browser_click or browser_fill instead of writing CSS. Refs belong to one snapshot — once the page changes, take a new one rather than reusing an old ref.",
    schema: {
      interactiveOnly: z.boolean().describe("Only actionable nodes — no headings, landmarks or paragraphs (default false)").optional(),
      maxNodes: z.number().describe("Cap on nodes walked before truncating (default 600)").optional(),
      frameId: z.string().describe("Read this frame instead of the main document (from browser_frames)").optional(),
    },
    handler: async ({ interactiveOnly = false, maxNodes = 600, frameId }) => {
      const cdp = await getActiveProtocol();
      const snap = await buildSnapshot(cdp, { interactiveOnly, maxNodes, frameId });
      rememberSnapshot(cdp, snap);
      if (snap.empty) {
        return { content: [{ type: "text", text: `# snapshot ${snap.id} · empty\n\n${snap.empty}` }] };
      }
      const header = `# snapshot ${snap.id} · ${snap.stats.refs} refs · ${snap.stats.nodes} nodes` +
        ` · ${snap.stats.elapsedMs}ms${snap.stats.truncated ? " · TRUNCATED (narrow with interactiveOnly or maxNodes)" : ""}`;
      return { content: [{ type: "text", text: `${header}\n\n${snap.text}` }] };
    },
  },

  browser_hover: {
    description: "Move the real pointer onto a ref from browser_snapshot — CSS :hover, dropdown menus and tooltips behave because it is a real mouse move, not a synthetic event. Returns where the pointer landed.",
    schema: { ref: z.string().describe("Ref from the latest browser_snapshot (e12), or a CSS selector") },
    handler: async ({ ref }) => {
      const cdp = await getActiveProtocol();
      const info = await hoverRef(cdp, refsFor(cdp).refs, ref);
      return { content: [{ type: "text", text: JSON.stringify(info) }] };
    },
  },

  browser_select: {
    description: "Choose an option in a native <select> by value, exact visible label, or index. Fires input and change, so frameworks notice. For a custom dropdown (button + list) use browser_click twice instead — the error says so if you try.",
    schema: {
      ref: z.string().describe("Ref of the <select> (e12), or a CSS selector"),
      values: z.array(z.string()).describe("Option value, exact label, or index — one entry per choice"),
    },
    handler: async ({ ref, values }) => {
      const cdp = await getActiveProtocol();
      const info = await selectRef(cdp, refsFor(cdp).refs, ref, values);
      return { content: [{ type: "text", text: JSON.stringify(info) }] };
    },
  },

  browser_press: {
    description: "Press a key or a chord at whatever has focus: \"Enter\", \"Tab\", \"Escape\", \"ArrowDown\", \"Control+a\", \"Meta+Shift+k\". Modifiers go down first and up last, so the page sees one chord and not three unrelated keydowns. Focus a field with browser_click or browser_fill first.",
    schema: {
      key: z.string().describe("Key or chord, e.g. \"Enter\" or \"Control+a\""),
      times: z.number().describe("Repeat count (default 1)").optional(),
    },
    handler: async ({ key, times = 1 }) => {
      const cdp = await getActiveProtocol();
      const info = await pressKey(cdp, key, { times });
      return { content: [{ type: "text", text: JSON.stringify(info) }] };
    },
  },

  browser_scroll: {
    description: "Scroll with real wheel events (lazy loading and scroll-linked animation behave), or scroll an element into view by ref, or jump to top/bottom. Returns the resulting scroll position.",
    schema: {
      ref: z.string().describe("Scroll this element into view — ref or CSS selector").optional(),
      deltaY: z.number().describe("Pixels down (negative scrolls up)").optional(),
      deltaX: z.number().describe("Pixels right (negative scrolls left)").optional(),
      toTop: z.boolean().describe("Jump to the top of the page").optional(),
      toBottom: z.boolean().describe("Jump to the bottom of the page").optional(),
    },
    handler: async (args) => {
      const cdp = await getActiveProtocol();
      const info = await scroll(cdp, { ...args, refs: refsFor(cdp).refs });
      return { content: [{ type: "text", text: JSON.stringify(info) }] };
    },
  },

  browser_drag: {
    description: "Drag one element onto another (refs from browser_snapshot) with real mouse motion — the intermediate moves are what make HTML5 drag-and-drop and pointer-event libraries believe the drag started.",
    schema: {
      from: z.string().describe("What to drag — ref or CSS selector"),
      to: z.string().describe("Where to drop — ref or CSS selector"),
      steps: z.number().describe("Intermediate moves (default 12)").optional(),
    },
    handler: async ({ from, to, steps = 12 }) => {
      const cdp = await getActiveProtocol();
      const info = await dragRef(cdp, refsFor(cdp).refs, from, to, { steps });
      return { content: [{ type: "text", text: JSON.stringify(info) }] };
    },
  },

  browser_console: {
    description: "Console output, uncaught exceptions and browser log entries from this page — always recording, so nobody has to remember to start it. Includes what happened during navigation, which is where the real errors are. `clear: true` empties the buffer after reading.",
    schema: {
      level: z.enum(["debug", "info", "log", "warn", "error"]).describe("Only this level").optional(),
      limit: z.number().describe("Newest N entries (default 100)").optional(),
      since: z.number().describe("Only entries at or after this epoch-ms timestamp").optional(),
      clear: z.boolean().describe("Empty the buffer after reading").optional(),
    },
    handler: async ({ level, limit = 100, since = 0, clear = false }) => {
      const cdp = await getActiveProtocol();
      await attachTelemetry(cdp);
      const out = { ...readConsole({ level, limit, since, clear }), ...(telemetryStats().error ? { telemetryError: telemetryStats().error } : {}) };
      if (!out.count && telemetryStats().error) out.hint = "Console capture is not running: " + telemetryStats().error;
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    },
  },

  browser_network: {
    description: "Requests the page made (method, URL, type, status, size, duration, failure) — always recording, requests only, never bodies. Filter to failures or HTTP errors to find what broke.",
    schema: {
      filter: z.enum(["all", "failed", "http-error", "xhr"]).describe("failed=no response, http-error=status>=400, xhr=fetch/XHR only").optional(),
      type: z.string().describe("Resource type: Document, XHR, Fetch, Script, Stylesheet, Image…").optional(),
      limit: z.number().describe("Newest N requests (default 100)").optional(),
      since: z.number().describe("Only requests at or after this epoch-ms timestamp").optional(),
      clear: z.boolean().describe("Empty the buffer after reading").optional(),
    },
    handler: async ({ filter = "all", type, limit = 100, since = 0, clear = false }) => {
      const cdp = await getActiveProtocol();
      await attachTelemetry(cdp);
      const out = readNetwork({ filter: filter === "all" ? undefined : filter, type, limit, since, clear });
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    },
  },

  browser_waitFor: {
    description: "Wait for exactly one condition, then return: text to appear (or disappear), a ref to become visible (or vanish), a selector, a URL (with * wildcards), or the network to go idle. Use this instead of sleep-and-hope. On timeout the error says what was last seen and suggests a fresh snapshot.",
    schema: {
      text: z.string().describe("Wait until this text is on the page").optional(),
      ref: z.string().describe("Wait until this ref is visible").optional(),
      selector: z.string().describe("Wait until this selector matches").optional(),
      url: z.string().describe("Wait until location matches, * is a wildcard").optional(),
      until: z.enum(["visible", "hidden", "detached"]).describe("Invert the condition (default visible)").optional(),
      networkIdle: z.boolean().describe("Also require no requests in flight").optional(),
      timeout: z.number().describe("Milliseconds (default 10000)").optional(),
    },
    handler: async (args) => {
      const cdp = await getActiveProtocol();
      await attachTelemetry(cdp);
      const info = await waitFor(cdp, { ...args, refs: refsFor(cdp).refs });
      return { content: [{ type: "text", text: JSON.stringify(info) }] };
    },
  },

  browser_dialog: {
    description: "alert/confirm/prompt block the page until answered. `action: status` shows the policy and the last dialog; `mode: accept|dismiss` sets a standing policy so future dialogs are answered automatically; `action: answer` answers the one that is open right now. Default is no policy — on Drishti the app answers dialogs itself, and two answers to one dialog is worse than one.",
    schema: {
      action: z.enum(["status", "set", "answer"]).describe("status=show policy, set=choose a mode, answer=respond now").optional(),
      mode: z.enum(["accept", "dismiss", "off"]).describe("Standing policy for dialogs (accept=OK, dismiss=Cancel, off=leave alone)").optional(),
      promptText: z.string().describe("Text to type into prompt() when accepting").optional(),
      accept: z.boolean().describe("For action=answer: true=OK, false=Cancel (default true)").optional(),
    },
    handler: async ({ action = "status", mode, promptText, accept = true }) => {
      const cdp = await getActiveProtocol();
      if (action === "set") {
        if (!mode) throw new Error("browser_dialog with action=set needs a mode: accept, dismiss or off");
        const out = await setDialogPolicy(cdp, { mode, promptText });
        return { content: [{ type: "text", text: JSON.stringify(out) }] };
      }
      if (action === "answer") {
        const out = await answerDialog(cdp, { accept, promptText });
        return { content: [{ type: "text", text: JSON.stringify(out) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(dialogStatus(cdp)) }] };
    },
  },

  browser_storage: {
    description: "localStorage, sessionStorage or cookies for this page. Reads return names, sizes and flags — never values, because a value is usually a token and a token in context is a leak. Use action \"get-value\" for one key when you genuinely need its content, and \"set\"/\"remove\"/\"clear\" to change state.",
    schema: {
      target: z.enum(["local", "session", "cookies"]).describe("Which store (default local)").optional(),
      action: z.enum(["get", "get-value", "set", "remove", "clear"]).describe("get=list, get-value=one key's content, clear=empty the store").optional(),
      key: z.string().describe("Key name, or cookie name").optional(),
      value: z.string().describe("Value for set — never echoed back").optional(),
      domain: z.string().describe("Cookie domain (defaults to the current page)").optional(),
    },
    handler: async (args) => {
      const cdp = await getActiveProtocol();
      const out = await storage(cdp, args);
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    },
  },

  browser_frames: {
    description: "Every frame on the page, flattened, with ids and URLs. Use a frame id with browser_snapshot to read inside an iframe instead of guessing its contents from the parent.",
    schema: {},
    handler: async () => {
      const cdp = await getActiveProtocol();
      const out = await frames(cdp);
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    },
  },

  browser_extract: {
    description: "Pull a page's structures out whole: links (text+href), tables (headers+rows), forms (fields, types, labels, required), or structured data (title, meta, JSON-LD, headings). Cheaper and more correct than scraping browser_text.",
    schema: {
      kind: z.enum(["links", "tables", "forms", "structured"]).describe("What to extract").optional(),
      selector: z.string().describe("Limit to a subtree, e.g. \"main\"").optional(),
      limit: z.number().describe("Max rows/items per structure (default 100)").optional(),
    },
    handler: async (args) => {
      const cdp = await getActiveProtocol();
      const out = await extract(cdp, args);
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    },
  },

  browser_upload: {
    description: "Put files into a file input without opening the OS picker (which a headless or phone browser cannot answer). Absolute paths on this machine; the input must be <input type=file>. Returns the file names and how many the input accepted.",
    schema: {
      ref: z.string().describe("Ref of the file input (e12), or its CSS selector"),
      files: z.array(z.string()).describe("Absolute paths on this machine"),
    },
    handler: async ({ ref, files }) => {
      const cdp = await getActiveProtocol();
      const out = await uploadFiles(cdp, refsFor(cdp).refs, ref, files);
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
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
    description: "Run a JavaScript expression in the active page and return its JSON-serializable result. Promises are awaited (`timeout` ms, default 10000). Runs with the page's privileges, including any logged-in session: only run code you wrote or understand.",
    schema: {
      expression: z.string().describe("JavaScript expression"),
      timeout: z.number().describe("Max ms to await a promise (default 10000)").optional(),
    },
    handler: async ({ expression, timeout = 10000 }) => {
      const { Runtime } = await getActiveProtocol();
      const response = await Runtime.evaluate({
        expression,
        returnByValue: true,
        // Without awaitPromise, `await fetch(...)` and async IIFEs resolve to
        // {} — the single most common reason an agent thinks its script "did
        // nothing".
        awaitPromise: true,
        timeout,
      });
      if (response.exceptionDetails) {
        const exc = response.exceptionDetails;
        throw new Error(`JS Error: ${exc.exception?.description || exc.text || "Unknown JS error"}`);
      }
      const { result } = response;
      let value = result?.value;
      if (value === undefined && result?.description) value = result.description;
      return { content: [{ type: "text", text: JSON.stringify(value ?? null) }] };
    },
  },

  browser_setViewport: {
    description: "Change the viewport size (width × height) for responsive testing. Defaults to 1280×720. Pass `reset:true` to clear the override.",
    schema: {
      width: z.number().min(320).max(7680).describe("Viewport width in pixels (default 1280)").optional(),
      height: z.number().min(240).max(4320).describe("Viewport height in pixels (default 720)").optional(),
      reset: z.boolean().describe("Clear the override and return to the window size").optional(),
    },
    handler: async ({ width = 1280, height = 720, reset = false }) => {
      const { Emulation } = await getActiveProtocol();
      if (reset) {
        await Emulation.clearDeviceMetricsOverride();
        return { content: [{ type: "text", text: JSON.stringify({ viewport: "reset" }) }] };
      }
      await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false });
      return { content: [{ type: "text", text: JSON.stringify({ viewport: `${width}x${height}` }) }] };
    },
  },

  // ═══════════════ 🔥 ADVANCED ═══════════════

  browser_act: {
    description: "Perform one simple action on the current page from a plain-English instruction: `go to <url>`, `search for <text>`, `click <label>`, `fill <field> with <value>`, `type <text> in <field>`, `scroll down|up`, `extract <text>`, `what's on this page`. Matching is literal text/label based (no LLM): if several elements match it returns `candidates` instead of guessing, and clicks on destructive labels (delete/buy/pay/submit…) return `needs_confirmation` unless `force:true`. Returns `{action, ...}` or `{action:\"<name>_error\", error}`. For anything precise use browser_click, browser_fill, browser_elements or browser_eval with a CSS selector.",
    schema: {
      instruction: z.string().describe("Natural language instruction for what to do on the page"),
      force: z.boolean().describe("Click even when the matched label looks destructive").optional(),
    },
    handler: async ({ instruction, force = false }) => {
      const cdp = await getActiveProtocol();
      const result = await executeInstruction(cdp, instruction, {
        confirmDestructive: cfg.confirmDestructive,
        force,
        // Navigation goes through the same ladder-aware path as browser_goto,
        // so an act navigation leaves the browser on the page it claims.
        navigate: async (url) => {
          try { assertNavigable(url, { allowDomains: cfg.allowDomains || null }); }
          catch (err) { throw err; }
          const res = await gotoUrl(cdp.Page, cdp.Runtime, url, cfg.navTimeout, {
            allowDomains: cfg.allowDomains || null,
          });
          return { url: res.url, timedOut: res.timedOut };
        },
      });
      if (result.url) syncActiveTab(result.title, result.url);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  },

  browser_watch: {
    description: "Record page events from the active tab. `start` begins capturing console messages, exceptions, network requests/responses and navigations (`events`: console, network, navigation, all). `poll` returns and clears events since the last poll, plus memory readings. `stop` ends capture and returns what remains. Keeps the newest 5,000 events. Bound to the tab that was active at `start` — switching tabs or restarting the browser stops the capture.",
    schema: {
      action: z.enum(["start", "poll", "stop"]).describe("start=begin recording, poll=get events since last poll, stop=cleanup"),
      events: z.array(z.enum(["console", "network", "navigation", "all"])).describe("Event types to capture (default: all)").optional(),
    },
    handler: async ({ action, events = ["all"] }) => {
      if (action === "start") {
        const cdp = await getActiveProtocol();
        await cdp.Runtime.enable();
        await cdp.Network.enable();
        // frameNavigated is only delivered after Page.enable — the old code
        // subscribed without it and silently captured no navigation events.
        await cdp.Page.enable?.();
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
    description: "Page health check for the active page: load timings, console errors, broken images, meta tags, interaction counts, and a heuristic score (0-100, weighted penalty sum — not a Lighthouse audit). Safe to call while browser_watch is recording.",
    schema: {},
    handler: async () => {
      const cdp = await getActiveProtocol();
      const report = await diagnosePage(cdp, { keepRuntimeEnabled: watchState.active });
      return { content: [{ type: "text", text: JSON.stringify(report) }] };
    },
  },

  browser_fingerprint: {
    description: "Apply common anti-detection patches (hide the webdriver flag, plausible plugins/languages, a user agent derived from the real Chromium build) to pages loaded afterwards. Intended for testing sites you own or have permission to test. Call before browser_goto.",
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
    description: "List all open browser tabs with their IDs, titles, URLs, and active status. In Drishti mode the app owns the tabs, so they come back with owned:false — readable, not yours to navigate or close.",
    schema: {},
    handler: async () => {
      let result = listTabs();
      let source = "registry";
      // A guest has no registry of its own: the tabs belong to the app the
      // human is holding. Ask the app, and mark every one owned:false — the
      // same rule browser_status follows, so the two tools cannot disagree.
      if (result.length === 0 && cfg.drishti && dctx) {
        try {
          const targets = await CDP.List(cdpAddress());
          const pages = targets.filter((t) => t.type === "page");
          result = pages.map((t, i) => ({
            id: t.id, title: t.title, url: t.url, active: i === 0, owned: false,
          }));
          source = "drishti";
        } catch { /* relay down: an empty list is the honest answer */ }
      }
      return { content: [{ type: "text", text: JSON.stringify({ tabs: result, count: result.length, source }) }] };
    },
  },

  // ═══════════════ SESSION ═══════════════

  browser_saveCookies: {
    description: "Save cookies for this browser profile as a JSON file in ~/.bwb/sessions (permissions 600). The file contains live login credentials: treat it like a password. Pass `domains` to save only some sites. After loading, navigate to the target site for cookies to apply.",
    schema: {
      name: z.string().describe("Name for this session (e.g., 'gmail')"),
      domains: z.array(z.string()).describe("Only save cookies for these domains (optional; default: all)").optional(),
    },
    handler: async ({ name, domains }) => {
      const cdp = await getActiveProtocol();
      const result = await saveSession(name, cdp, { domains });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  },

  browser_loadCookies: {
    description: "Load a saved session (cookies) from disk. Only http(s) pages requested after this call will use them — static fetches are skipped for the rest of the run, so a logged-in page is never answered anonymously.",
    schema: { name: z.string().describe("Session name to load (e.g., 'gmail')") },
    handler: async ({ name }) => {
      const cdp = await getActiveProtocol();
      const result = await loadSession(name, cdp);
      // From here on the static rung would answer with a logged-OUT page and
      // report high confidence. Force the browser rung.
      cookiesLoaded = true;
      return { content: [{ type: "text", text: JSON.stringify({ ...result, staticFetchDisabled: true }) }] };
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
    description: "Download media from a URL (video, audio, subtitles, thumbnail). Requires yt-dlp on the system — if missing, returns install instructions and downloads nothing. http(s) only; the URL is passed to yt-dlp as an argument, never through a shell.",
    schema: {
      url: z.string().describe("Media URL (http/https)"),
      format: z.enum(["best", "audio", "video", "subtitles", "thumbnail"]).describe("What to download").optional(),
      quality: z.enum(["best", "good", "worst"]).describe("Quality tier").optional(),
    },
    handler: async ({ url, format = "best", quality = "best" }) => {
      // Real URL parsing instead of a regex. The old regex had `\\s` inside a
      // character class — a literal backslash AND the letter "s" — so every URL
      // containing an "s" was refused (x.com/user/status/1, instagram, tiktok)
      // while "https://example.com/a b" was accepted.
      let target;
      try {
        target = assertHttpUrl(url, { allowDomains: cfg.allowDomains || null });
      } catch (err) {
        return errResult(err, "refused: only http(s) URLs without shell metacharacters are allowed");
      }
      let hasYtDlp = false;
      try {
        execFileSync("yt-dlp", ["--version"], { stdio: "ignore", timeout: 5000 });
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
      // `--` ends option parsing so a URL can never be read as a yt-dlp flag.
      args.push("--", target.href);
      try {
        // execFile, not execSync: no shell is constructed at any point.
        const out = execFileSync("yt-dlp", args, { encoding: "utf8", timeout: 600000, maxBuffer: 1024 * 1024 });
        const file = out.trim().split("\n").pop();
        return { content: [{ type: "text", text: JSON.stringify({ downloaded: file, format, quality }) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "download failed", detail: String(err.message || err).slice(0, 500) }) }] };
      }
    },
  },

  browser_export: {
    description: "Write text to a file inside the bwb export directory (default ~/bwb-exports). Formats: md, txt, html. Paths outside the export directory are refused. No pdf/docx/pptx: those were reported as \"ready\" while writing nothing.",
    schema: {
      text: z.string().describe("Content to export (markdown accepted)"),
      format: z.enum(["md", "txt", "html"]).describe("Output format").optional(),
      filename: z.string().describe("File name inside the export dir (optional; extension from format)").optional(),
      title: z.string().describe("Document title (html only)").optional(),
      overwrite: z.boolean().describe("Allow replacing an existing file").optional(),
    },
    handler: async ({ text, format = "md", filename, title = "bwb export", overwrite = false }) => {
      const dest = resolveExportPath(filename, format, overwrite);
      if (dest.error) return errResult(dest.error);
      if (format === "html") {
        const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        writeFileSync(dest.path,
          `<!doctype html><html><head><meta charset="utf8"><title>${title}</title></head><body><pre>${esc}</pre></body></html>`,
          "utf8");
      } else {
        writeFileSync(dest.path, text, "utf8");
      }
      return { content: [{ type: "text", text: JSON.stringify({ exported: dest.path, format }) }] };
    },
  },

  // ═══════════════ LIFECYCLE ═══════════════

  needs_human: {
    description: "Hand the phone to the human, then wait. Use this for logins, captchas, 2FA, payments, or anything that must not be automated — never try to bypass them yourself. Posts the reason to the drishti app and long-polls until the human taps Hand back. Returns {status:\"user_done\"} or {status:\"timed_out\"}; outside drishti mode it returns {status:\"not_drishti\"} and changes nothing.",
    schema: {
      reason: z.string().describe("One plain sentence shown on the phone, e.g. \"Log in to Gmail\""),
      timeout_sec: z.number().describe("How long to wait for the human (default 300)").optional(),
    },
    handler: async ({ reason, timeout_sec = 300 }) => {
      if (!cfg.drishti || !dctx) {
        return { content: [{ type: "text", text: JSON.stringify({
          status: "not_drishti",
          message: "needs_human only works in drishti mode. Ask the human in chat instead.",
        }) }] };
      }
      let askError = null;
      try {
        await askHelp({ ...dctx, reason });
      } catch (err) {
        askError = err.message;
      }
      stepReporter?.report(reason, "needs_human", "waiting");
      const wait = await waitForHandback({
        ...dctx,
        timeoutMs: Math.max(1, Number(timeout_sec) || 300) * 1000,
      });
      stepReporter?.report(reason, "needs_human", wait.handedBack ? "done" : "timed out");
      return { content: [{ type: "text", text: JSON.stringify({
        status: wait.handedBack ? "user_done" : "timed_out",
        waited_sec: Math.round(wait.waitedMs / 1000),
        ...(askError ? { help_post_failed: askError, note: "The app was not notified — the human only saw this in chat." } : {}),
      }) }] };
    },
  },

  browser_status: {
    description: "Get browser and page status including opened tabs and connection info. v4: includes live resource readings (MCP + Chromium MB, budgets) so the agent sees pressure before Android does.",
    schema: {},
    handler: async () => {
      const status = { connected: false, port: cfg.port, actualPort: null, running: false, pid: null, tabs: [] };
      // Drishti is attach-only and owns no child process: `browser` stays null
      // and `attached` stays false while a live WebView is right there. Liveness
      // is the paired socket, exactly as it is for --attach-port. Without this,
      // status answered "connected:false, tabs:[]" to an agent that was, at that
      // moment, driving the page in front of the user.
      const guest = Boolean(cfg.drishti && dctx);
      if ((browser && !browserExited) || (attached && !browserExited) || guest) {
        status.running = true;
        status.pid = browser ? browser.pid : null;
        if (attached || guest) status.attached = true;
        status.tabs = listTabs();
        // actualCdpPort is the real bound port; cfg.port may be 0 (random).
        // Never fall back to a hardcoded 9222 — that could be another tool's browser.
        const listPort = actualCdpPort || cfg.attachPort || cfg.port;
        if (listPort) {
          try {
            status.actualPort = actualCdpPort || listPort;
            const targets = await CDP.List(cfg.drishti ? cdpAddress() : { port: listPort });
            status.connected = true;
            status.targets = targets.map(t => ({ type: t.type, url: t.url, title: t.title }));
            // A guest's tabs are the app's, not ours — we never opened them, so
            // they are owned:false and the agent may read but not drive them.
            // Report them here rather than an empty registry: "0 tabs" next to a
            // visible page is the kind of lie that makes an agent spawn work.
            if (guest && status.tabs.length === 0) {
              const pages = targets.filter(t => t.type === "page");
              status.tabs = pages.map((t, i) => ({
                id: t.id, title: t.title, url: t.url, active: i === 0, owned: false,
              }));
            }
          } catch (err) {
            // Say why. "connected:false" with no reason sends the agent off to
            // inspect its own network instead of the phone's relay.
            status.connected = false;
            status.error = err?.message || String(err);
          }
        }
      }
      try {
        status.resources = sampleResources(browser?.pid, status.tabs.filter((t) => !t.hibernated).length);
        status.resources.state = assess(status.resources);
        status.profile = { lean: cfg.lean, nuclear: cfg.nuclear, idleMs: cfg.idleMs, tabMax: cfg.tabMax };
        if (attached) status.profile.attached = actualCdpPort || cfg.attachPort;
        if (cfg.drishti) status.profile.drishti = true;
      } catch {}
      if (cfg.drishti && dctx) {
        // Never the token itself — masked, for the same reason session cookies
        // are never echoed back. No state probe here: /bwb/state is a long-poll
        // by contract, and a status snapshot is not allowed to block on one.
        // `bwb drishti` is the command that asks the app how it is doing.
        status.drishti = { port: dctx.port, token: maskToken(dctx.token) };
      }
      return { content: [{ type: "text", text: JSON.stringify(status) }] };
    },
  },

  browser_restart: {
    description: "Cleanly restart the browser process, then resume the page you were on. Use it to free memory, clear state, or recover from a wedged session. Cookies in the profile survive; in-page state does not.",
    schema: {},
    handler: async () => {
      // An explicit restart is the agent asking for a fresh browser mid-task,
      // not permission to forget which page the task was on. Re-queue the
      // current URL so the next page tool lands back on it.
      const active = listTabs().find((t) => t.active);
      const resume = /^https?:/i.test(active?.url || "") ? active.url : null;
      clearTabs(); // Kill stale tab connections before restart
      cleanupWatch(); // Detach event listeners from the dying protocol before it's gone
      const result = await restartBrowser();
      if (resume) setPendingStatic(resume, active.title);
      return { content: [{ type: "text", text: JSON.stringify({ ...result, resuming: resume }) }] };
    },
  },
};

// ─── Register & Start ─────────────────────────────────────────────────────────

// Tools that operate on a live page. browser_goto and the static tools are
// excluded: they must work without ever starting Chromium.
const PAGE_TOOLS = new Set([
  "browser_text", "browser_html", "browser_screenshot", "browser_click",
  "browser_fill", "browser_elements", "browser_eval", "browser_back",
  "browser_waitForSelector", "browser_diagnose", "browser_fingerprint",
  "browser_loadCookies", "browser_saveCookies",
]);

// Single choke point for every tool call:
//   1. --readonly blocks state-changing tools before they run
//   2. materialize a pending static page so "static first" is actually true
//   3. poke the mayfly timer
//   4. append a ~100-byte resource footer, shedding load on critical pressure
let criticalStreak = 0;

/**
 * drishti mode wraps every step: tell the phone what is happening, and when the
 * app pushes back (takeover, unapproved site) pause and resume instead of
 * reporting a failure the human did not cause.
 */
async function runDrishtiStep(name, args, inner) {
  if (!dctx) return inner(args);
  const step = humanStep(name, args);
  stepReporter?.report(step, name, "running");
  try {
    const out = await runDrishtiAware(() => inner(args), dctx);
    stepReporter?.report(step, name, "done");
    return out;
  } catch (err) {
    stepReporter?.report(step, name, err instanceof DrishtiPausedError ? "paused" : "failed");
    throw err;
  }
}

// ─── Steering notes (contract §5.1 / §5.2) ──────────────────────────────────
// The human types a correction in the app while the agent is working. It is
// pulled, not pushed — the relay has no way to reach us — so it rides on the
// next tool result. Created lazily: a session that never pairs pays nothing.
let steeringFeed = null;

async function notesForThisCall() {
  if (!dctx) return "";
  if (!steeringFeed) {
    steeringFeed = new NoteFeed({
      fetchNotes: (after) => getNotes({ ...dctx, after, timeoutMs: 800 }),
    });
  }
  return steeringFeed.next();
}

for (const [name, tool] of Object.entries(tools)) {
  const inner = tool.handler;
  server.tool(name, tool.description, tool.schema, async (args) => {
    if (cfg.readonly && WRITE_TOOLS.has(name)) {
      return { content: [
        { type: "text", text: JSON.stringify({
          error: `bwb is running in --readonly mode: ${name} is disabled. Restart without --readonly (or BWB_READONLY) to allow state changes.`,
        }) },
        { type: "text", text: resourceFooter(sampleResources(null, 0), "readonly") },
      ] };
    }

    // Static-first only pays off if the browser catches up when it matters.
    // Before any tool that needs a live page, navigate Chromium to whatever
    // browser_goto served statically (F04).
    if (PAGE_TOOLS.has(name) && needsMaterialize()) {
      try {
        await materializeStatic();
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({
          error: `Could not load the statically fetched page in the browser: ${err.message}`,
        }) }] };
      }
    }
    // A watch is bound to one tab: switching tabs or restarting invalidates it.
    if (watchState.active && (name === "browser_switchTab" || name === "browser_closeTab")) {
      cleanupWatch();
      setIdleSuppressed(false);
    }

    let result;
    try {
      result = await runDrishtiStep(name, args, inner);
    } catch (err) {
      if (err instanceof DrishtiPausedError) {
        // A pause that expired is data, not a crash: the human needs to know
        // exactly what to tap, and the agent needs to know nothing happened.
        result = { content: [{ type: "text", text: JSON.stringify({
          paused: true,
          reason: err.drishti?.kind || "unknown",
          message: err.message,
        }) }] };
      } else if (err?.isToolError || err?.name === "UrlPolicyError") {
        result = errResult(err);
      } else {
        throw err;
      }
    } finally {
      try { pokeActivity(); } catch {}
    }
    try {
      const liveTabs = listTabs().filter((t) => !t.hibernated).length;
      const sample = sampleResources(browser?.pid, liveTabs);
      let note = "";
      // Never auto-shed in attach mode: those are the user's REAL tabs.
      // Report pressure in the footer; the human closes their own tabs.
      if (!attached && assess(sample) === "critical" && browser && !browserExited) {
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
        // Teardown throws away in-page state (a half-filled form, scroll
        // position, a page's JS heap) and the next call resurrects from the
        // journal. Only do it when the pressure is not a one-off sample AND
        // no multi-step flow is in flight.
        criticalStreak++;
        const flowInProgress = watchState.active;
        if (assess(sample) === "critical"
            && listTabs().filter((t) => !t.hibernated).length <= 1
            && criticalStreak >= 2
            && !flowInProgress) {
          try { await stopBrowser("oom-guard"); } catch {}
          criticalStreak = 0;
          note += `${note ? "; " : ""}browser stopped at peak ${peak} (oom-guard, twice) — journal saved, next call resurrects`;
        } else if (flowInProgress) {
          note += `${note ? "; " : ""}oom-guard held: browser_watch is recording`;
        }
      } else {
        criticalStreak = 0;
      }
      if (result && Array.isArray(result.content)) {
        result.content.push({ type: "text", text: resourceFooter(sample, note, { guest: Boolean(attached || (cfg.drishti && dctx)) }) });
        // Last, so it is the freshest thing the model reads: the human may have
        // changed their mind while this very call was running.
        const steering = await notesForThisCall();
        if (steering) result.content.push({ type: "text", text: steering });
      }
    } catch {}
    return result;
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
