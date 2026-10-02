/**
 * bwb-browser — Browser lifecycle management
 *
 * Handles Chrome/Chromium process spawning, CDP connection, browser detection,
 * restart, orphan cleanup, and screenshot persistence.
 */

import { spawn, execSync, execFileSync } from "child_process";
import { homedir, platform } from "os";
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import CDP from "chrome-remote-interface";

// ─── Shared State ──────────────────────────────────────────────────────────────

/** @type {import("child_process").ChildProcess|null} */
export let browser = null;
/** @type {import("chrome-remote-interface").Protocol|null} */
export let protocol = null;
/** @type {Promise<import("chrome-remote-interface").Protocol>|null} */
let browserStartup = null;
export let browserExited = false;
export let actualCdpPort = null;
export let cleaningUp = false;

/** Runtime config — set by server.mjs after parseArgs */
export const cfg = {
  port: 0,
  headless: true,
  userDataDir: "",
  screenshotsDir: "",
  navTimeout: 30000,
  browserPath: null,
  lean: null, // null = auto (Termux/1GB heuristics); true/false forces
  nuclear: false, // --single-process: max RAM saving, min stability. Opt-in only.
  idleMs: null, // null = auto (5min lean, off desktop); 0 = never teardown
  tabMax: null, // null = auto (3 lean, unlimited desktop); 0 = unlimited
  attachPort: 0, // 0 = off (spawn own browser). N = attach to existing
                 // browser's CDP port (e.g. 9222) — never spawns, never kills.
  noSandbox: false, // disable the Chromium sandbox (auto on Termux / as root)
  allowPrivate: false, // allow static fetches to loopback/private addresses
  allowDomains: null, // optional host allowlist for navigation
  readonly: false, // refuse every state-changing tool
  confirmDestructive: true, // act-clicks on destructive labels need confirmation
  alwaysBrowser: false, // skip the static rung entirely
  journalFull: false, // journal full URLs (with query strings) and auto-restore
  shotKeep: 50, // screenshots retained on disk
};

// True when connected to a foreign (user-owned) browser via --attach-port.
// Attached browsers are never spawned, killed, or journal-restored —
// bwb is a guest there. Tab hibernation still works but closes REAL tabs.
export let attached = false;

// ─── Environment ─────────────────────────────────────────────────────────────

export function isTermux() {
  return Boolean(
    process.env.TERMUX_VERSION ||
    process.env.PREFIX?.includes("com.termux") ||
    process.env.HOME?.includes("com.termux")
  );
}

// ─── Idle Mayfly (auto-teardown) ─────────────────────────────────────────────

let idleTimer = null;
let idleSuppressed = false; // true while browser_watch is recording

export function setIdleSuppressed(suppressed) {
  idleSuppressed = suppressed;
  if (suppressed) disarmIdle();
  else pokeActivity();
}

export function disarmIdle() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

/** Reset the mayfly timer. Called after every tool call via the server wrapper. */
export function pokeActivity() {
  disarmIdle();
  if (!cfg.idleMs || idleSuppressed || !browser || browserExited) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!idleSuppressed) stopBrowser("idle-timeout").catch(() => {});
  }, cfg.idleMs);
  if (idleTimer.unref) idleTimer.unref(); // never hold the MCP process open
}

// ─── Kill Orphaned Chrome (Termux-safe) ────────────────────────────────────────

// `fuser -k` and `lsof` can't read /proc/net/tcp on Termux/Android (permission denied).
// Instead, kill by PID from `ps` — works on every platform.
// Only kills bwb's own headless Chrome instances (marked by remote-debugging-port
// AND our user-data-dir), NOT the user's normal Chrome browser.
//
// The process list is read with execFile and filtered in JS: the previous
// `ps aux | grep … | xargs kill` pipeline put cfg.userDataDir into a shell
// string with only `"` and `\` escaped, and it does not exist on Windows.
export function killOrphanedChrome() {
  if (platform() === "win32") return; // no ps/grep/awk/xargs; use the CDP port instead
  let out;
  try {
    out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 5000 });
  } catch {
    return;
  }
  const scope = cfg.userDataDir ? String(cfg.userDataDir) : null;
  const pids = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, args] = m;
    if (!args.includes("remote-debugging-port")) continue;
    if (args.includes("--type=")) continue; // renderers/zygotes die with the parent
    if (scope && !args.includes(scope)) continue;
    pids.push(Number(pid));
  }
  if (!pids.length) return;
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
}

// ─── Profile Lock (two agents, one profile) ───────────────────────────────────
// Chrome locks its user-data-dir, but bwb's killOrphanedChrome runs first and
// would SIGTERM the OTHER agent's browser. A tiny owner file turns that from
// "one agent silently kills the other mid-task" into a clear error.

function ownerLockPath() {
  return cfg.userDataDir ? join(cfg.userDataDir, "bwb-owner.json") : null;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function checkProfileLock() {
  const path = ownerLockPath();
  if (!path) return;
  try {
    const owner = JSON.parse(readFileSync(path, "utf8"));
    if (owner.pid && owner.pid !== process.pid && processAlive(owner.pid)) {
      throw new Error(
        `Another bwb process (pid ${owner.pid}) is already using ${cfg.userDataDir}. ` +
        `Sharing a profile makes them kill each other's browser. Use a different ` +
        `--user-data-dir or --port, or stop that process.`
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Another bwb process")) throw err;
    // No lock, or unreadable/corrupt: not an error.
  }
}

function writeProfileLock() {
  const path = ownerLockPath();
  if (!path) return;
  try {
    mkdirSync(cfg.userDataDir, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ pid: process.pid, port: cfg.port, startedAt: Date.now() }), { mode: 0o600 });
  } catch {}
}

function clearProfileLock() {
  const path = ownerLockPath();
  if (!path) return;
  try {
    const owner = JSON.parse(readFileSync(path, "utf8"));
    if (owner.pid === process.pid) unlinkSync(path);
  } catch {}
}

// ─── Browser Detection ────────────────────────────────────────────────────────

export function findBrowserPath(cliPath) {
  if (cliPath) return cliPath;
  const envPath = process.env.BWB_CHROME_PATH;
  if (envPath) return envPath;

  const os = platform();
  const home = homedir();
  const lookup = platform() === "win32" ? "where" : "which";

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
      "brave-browser",
      "brave",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/brave-browser",
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
    if (bin.startsWith("/") || bin.startsWith("C:\\") || bin.startsWith("\\")) {
      if (existsSync(bin)) return bin;
      continue;
    }
    try {
      // No shell: the candidate list is data, never a command string.
      const out = execFileSync(lookup, [bin], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
      const path = String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
      if (path) return path;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Does Chromium's setuid/namespace sandbox work here?
 *
 * It does NOT on Termux (no user namespaces) and not when running as root or
 * inside most Docker images — and there bwb genuinely cannot start without
 * --no-sandbox. Everywhere else the sandbox is the main containment for a
 * browser that an LLM is pointing at pages chosen by untrusted content, so it
 * stays on. BWB_NO_SANDBOX=1 forces it off.
 */
function needsNoSandbox() {
  if (cfg.noSandbox) return true;
  if (isTermux()) return true;
  if (process.platform === "win32") return false;
  return typeof process.getuid === "function" && process.getuid() === 0;
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

export async function ensureBrowser() {
  if (protocol && !browserExited) return protocol;
  if (browserStartup) return browserStartup;

  if (protocol) {
    try { await protocol.close(); } catch {}
    protocol = null;
  }
  browserExited = false;
  actualCdpPort = null;

  let startResolve, startReject;
  browserStartup = new Promise((res, rej) => { startResolve = res; startReject = rej; });
  browserStartup.catch(() => { browserStartup = null; });

  // ─── Attach mode: guest on someone else's browser ──────────────────────
  // No spawn, no orphan-kill, no journal restore (never navigate a user's
  // tabs on connect). ensureDefaultTab() registers whatever is already open.
  if (cfg.attachPort) {
    (async () => {
      try {
        const port = cfg.attachPort;
        const cdp = await CDP({ port });
        protocol = cdp;
        browser = null;
        attached = true;
        actualCdpPort = port;
        startResolve(cdp);
        pokeActivity();
      } catch (err) {
        browserStartup = null;
        browserExited = true;
        attached = false;
        startReject(new Error(
          `Attach failed: no browser listening on CDP port ${cfg.attachPort} (${err.message}). ` +
          `Launch one with --remote-debugging-port=${cfg.attachPort} first.`
        ));
      }
    })();
    return browserStartup;
  }
  attached = false;

  (async () => {
    try {
      const browserPath = assertBrowserExists(cfg.browserPath);
      checkProfileLock();
      writeProfileLock();
      killOrphanedChrome();
      await new Promise(r => setTimeout(r, 500));

      const debugPort = cfg.port || 0;
      const noSandbox = needsNoSandbox();
      const args = [
        "--headless",
        ...(noSandbox ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-software-rasterizer",
        "--remote-debugging-port=" + debugPort,
        "--user-data-dir=" + cfg.userDataDir,
        ...leanArgs(),
      ];

      if (!cfg.headless) args.shift();

      browser = spawn(browserPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group: a Ctrl-C or an ungraceful exit must take the
        // renderer tree with it, not leave orphans behind.
        detached: true,
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
      });

      let resolved = false;

      browser.on("exit", (code, signal) => {
        browserExited = true;
        if (!resolved) {
          clearTimeout(startTimeout);
          startReject(new Error(`Browser exited with code ${code} (signal ${signal}) before CDP connected`));
        }
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

      browser.stderr.on("data", (data) => {
        const msg = data.toString();
        const portMatch = msg.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
        if (portMatch) {
          actualCdpPort = parseInt(portMatch[1], 10);
          clearTimeout(startTimeout);
          resolved = true;
          CDP({ port: actualCdpPort })
            .then((cdp) => {
              protocol = cdp;
              // Awaited, not fire-and-forget: callers must see the restored
              // working set, not a blank tab that later jumps. Capped + fast.
              (async () => {
                try { await restoreJournalTabs(); } catch {}
                startResolve(cdp);
                pokeActivity();
              })();
            })
            .catch((err) => {
              try { browser.kill("SIGKILL"); } catch {}
              browserExited = true;
              startReject(new Error(`CDP connection failed: ${err.message}`));
            });
        }
      });
    } catch (err) {
      browserStartup = null;
      browserExited = true;
      startReject(err);
    }
  })();

  return browserStartup;
}

// ─── Lean Flags (v4 survival profile) ─────────────────────────────────────────
// Compat flags above make Chromium RUN on Termux. These make it SURVIVE:
// capped renderers, silenced background services, bounded cache + JS heap.
// --single-process stays behind --nuclear: biggest saving, weakest stability.

function leanArgs() {
  if (!cfg.lean) return [];
  const flags = [
    "--renderer-process-limit=1",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--mute-audio",
    "--disable-features=Translate",
    "--disk-cache-size=67108864",
    "--js-flags=--max-old-space-size=256",
  ];
  if (cfg.nuclear) flags.push("--single-process", "--no-zygote");
  return flags;
}

// ─── Stop (graceful mayfly teardown — journal keeps the working set) ─────────

export async function stopBrowser(reason = "manual") {
  if (cleaningUp) return { status: "busy" };
  cleaningUp = true;
  disarmIdle();
  try {
    if (protocol) {
      try { await protocol.close(); } catch {}
      protocol = null;
    }
    // Attached browsers are foreign — disconnect only, never kill.
    if (browser && !attached) {
      try { browser.kill("SIGTERM"); } catch {}
      await new Promise(r => setTimeout(r, 1500));
      try { browser.kill("SIGKILL"); } catch {}
      browser = null;
    }
  } catch {}
  browserExited = true; // next ensureBrowser() respawns fresh + restores journal
  actualCdpPort = null;
  attached = false;
  browserStartup = null;
  cleaningUp = false;
  try {
    const { clearTabs } = await import("./tabs.mjs");
    clearTabs();
  } catch {}
  return { status: "stopped", reason };
}

// ─── Restart ──────────────────────────────────────────────────────────────────

export async function restartBrowser() {
  if (cleaningUp) return { status: "busy" };
  cleaningUp = true;

  try {
    if (protocol) {
      try { await protocol.close(); } catch {}
      protocol = null;
    }
    // Attached browsers are foreign — disconnect only, never kill.
    // Next ensureBrowser() re-attaches (no journal restore in attach mode).
    if (browser && !attached) {
      browser.kill("SIGTERM");
      await new Promise(r => setTimeout(r, 2000));
      try { browser.kill("SIGKILL"); } catch {}
      browser = null;
    }
  } catch {}

  browserExited = false;
  actualCdpPort = null;
  browserStartup = null;
  cleaningUp = false;

  // Next ensureBrowser call will start fresh
  return { status: "restarted" };
}

// ─── Journal Restore (post-kill resurrection — lazy, capped) ─────────────────
// Reopens the journaled working set after a fresh spawn (LMK kill, mayfly
// teardown, restart). First entry navigates now; the rest become placeholders
// woken on switchTab. Never re-spikes memory at startup to "restore".

async function restoreJournalTabs() {
  try {
    const tabs = await import("./tabs.mjs");
    await tabs.restoreJournal();
  } catch {}
}

// ─── Screenshot Helper ────────────────────────────────────────────────────────

/**
 * Write a screenshot to disk. The filename carried second-level precision, so
 * two shots in the same second overwrote each other; and nothing ever cleaned
 * up (on Termux this is the public Download folder — a long agent loop fills
 * storage). Now: millisecond + random suffix, and the newest BWB_SHOT_KEEP
 * files are kept.
 */
export function saveScreenshot(base64Data) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
  const rand = Math.random().toString(36).slice(2, 6);
  const filename = `bwb-${stamp}-${rand}.jpeg`;
  const filepath = join(cfg.screenshotsDir, filename);
  try {
    mkdirSync(cfg.screenshotsDir, { recursive: true });
    writeFileSync(filepath, Buffer.from(base64Data, "base64"));
    pruneScreenshots(cfg.screenshotsDir, cfg.shotKeep);
    return filepath;
  } catch {
    return null;
  }
}

function pruneScreenshots(dir, keep = 50) {
  if (!keep || keep < 1) return;
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("bwb-") && f.endsWith(".jpeg"))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) {
      try { unlinkSync(join(dir, f)); } catch {}
    }
  } catch {}
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

function cleanupSync() {
  if (cleaningUp) return;
  cleaningUp = true;
  clearProfileLock();
  try {
    if (browser) {
      const child = browser;
      child.kill("SIGTERM");
      // The old code armed a 3s SIGKILL timer and then the signal handler
      // called process.exit(0) — so the timer never fired and a Chromium that
      // ignored SIGTERM was orphaned. Kill the whole process group instead,
      // synchronously, using the detached spawn above.
      const pid = child.pid;
      try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
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
