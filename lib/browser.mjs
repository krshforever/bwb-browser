/**
 * bwb-browser — Browser lifecycle management
 *
 * Handles Chrome/Chromium process spawning, CDP connection, browser detection,
 * restart, orphan cleanup, and screenshot persistence.
 */

import { spawn, execSync } from "child_process";
import { homedir, platform } from "os";
import { existsSync, mkdirSync, writeFileSync } from "fs";
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
};

// ─── Kill Orphaned Chrome (Termux-safe) ────────────────────────────────────────

// `fuser -k` and `lsof` can't read /proc/net/tcp on Termux/Android (permission denied).
// Instead, kill by PID from `ps` — works on every platform.
// Only kills bwb's headless Chrome instances (marked by `remote-debugging-port` flag),
// NOT the user's normal Chrome browser.
export function killOrphanedChrome() {
  try {
    // Only touch Chromes using OUR user-data-dir — never another agent's browser.
    const scopedMatch = cfg.userDataDir
      ? `grep "remote-debugging-port" | grep "${String(cfg.userDataDir).replace(/["\\]/g, "\\$&")}" | grep -v grep`
      : `grep "remote-debugging-port" | grep -v grep`;
    // SIGTERM first for clean shutdown
    execSync(
      `ps aux | ${scopedMatch} | awk '{print $2}' | xargs -r kill -15 2>/dev/null; true`,
      { encoding: "utf8", timeout: 5000 }
    );
    // Give them a moment to exit cleanly, then SIGKILL survivors
    execSync(
      `sleep 1 && ps aux | ${scopedMatch} | awk '{print $2}' | xargs -r kill -9 2>/dev/null; true`,
      { encoding: "utf8", timeout: 5000 }
    );
  } catch {}
}

// ─── Browser Detection ────────────────────────────────────────────────────────

export function findBrowserPath(cliPath) {
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
    if (bin.startsWith("/") || bin.startsWith("C:\\") || bin.startsWith("\\")) {
      if (existsSync(bin)) return bin;
      continue;
    }
    try {
      const path = execSync(`which "${bin}" 2>/dev/null || echo "no"`, { encoding: "utf8", timeout: 3000 }).trim();
      if (path && path !== "no") return path;
    } catch { /* try next */ }
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

  (async () => {
    try {
      const browserPath = assertBrowserExists(cfg.browserPath);
      killOrphanedChrome();
      await new Promise(r => setTimeout(r, 500));

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
              startResolve(cdp);
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

// ─── Restart ──────────────────────────────────────────────────────────────────

export async function restartBrowser() {
  if (cleaningUp) return;
  cleaningUp = true;

  try {
    if (protocol) {
      try { await protocol.close(); } catch {}
      protocol = null;
    }
    if (browser) {
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

// ─── Screenshot Helper ────────────────────────────────────────────────────────

export function saveScreenshot(base64Data) {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `bwb-${timestamp}.jpeg`;
  const filepath = join(cfg.screenshotsDir, filename);
  try {
    mkdirSync(cfg.screenshotsDir, { recursive: true });
    writeFileSync(filepath, Buffer.from(base64Data, "base64"));
    return filepath;
  } catch {
    return null;
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

function cleanupSync() {
  if (cleaningUp) return;
  cleaningUp = true;
  try {
    if (browser) {
      browser.kill("SIGTERM");
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
