/**
 * bwb-browser — Persistent Browser Sessions
 *
 * Save and load browser cookies to/from disk, enabling authenticated sessions
 * to persist across agent restarts. "Login once, agent works for days."
 *
 * Sessions are stored as JSON files in ~/.bwb/sessions/
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const SESSION_DIR = join(homedir(), ".bwb", "sessions");

// These files hold live login cookies for every domain the browser has visited.
// They were written with the default umask (0644 = world-readable) inside a
// 0755 directory. 600/700, and chmod pre-existing files on read too.
function ensureDir() {
  mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(SESSION_DIR, 0o700); } catch {}
}

function writeSecure(path, data) {
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** True when a cookie belongs to one of the requested domains. */
function inDomains(cookie, domains) {
  if (!domains || !domains.length) return true;
  const host = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
  return domains.some((d) => host === d || host.endsWith("." + d));
}

/**
 * Save all cookies from the current browser session to a named session file.
 * @param {object} [opts] {domains} — restrict to specific domains
 */
export async function saveSession(name, protocol, { domains } = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("Session name is required");
  }
  // Sanitize name to avoid path traversal
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  ensureDir();

  const { cookies } = await protocol.Network.getAllCookies();
  const wanted = domains?.length
    ? cookies.filter((c) => inDomains(c, domains.map((d) => String(d).toLowerCase())))
    : cookies;
  const path = join(SESSION_DIR, `${safeName}.json`);
  writeSecure(path, JSON.stringify({
    name: safeName,
    cookieCount: wanted.length,
    domains: domains || null,
    savedAt: Date.now(),
    cookies: wanted,
  }, null, 2));

  return {
    savedTo: path,
    cookieCount: wanted.length,
    name: safeName,
    ...(domains?.length ? { domains } : {}),
    warning: "This file contains live login credentials (mode 600). Treat it like a password.",
  };
}

/**
 * Load cookies from a named session file into the browser.
 */
export async function loadSession(name, protocol) {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = join(SESSION_DIR, `${safeName}.json`);

  if (!existsSync(path)) {
    throw new Error(`Session not found: "${name}". Available sessions: ${listSessions().map(s => s.name).join(", ") || "none"}`);
  }

  const data = JSON.parse(readFileSync(path, "utf8"));

  if (!data.cookies || !Array.isArray(data.cookies)) {
    throw new Error(`Invalid session file: ${path}`);
  }

  // Set all cookies in the browser
  await protocol.Network.setCookies({ cookies: data.cookies });

  return {
    loaded: safeName,
    cookieCount: data.cookies.length,
    savedAt: new Date(data.savedAt).toISOString(),
  };
}

/**
 * List all saved sessions.
 */
export function listSessions() {
  ensureDir();
  const files = readdirSync(SESSION_DIR).filter(f => f.endsWith(".json"));
  return files.map(f => {
    try {
      const data = JSON.parse(readFileSync(join(SESSION_DIR, f), "utf8"));
      return {
        name: data.name || f.replace(".json", ""),
        cookieCount: data.cookies?.length || 0,
        savedAt: data.savedAt ? new Date(data.savedAt).toISOString() : "unknown",
      };
    } catch {
      return { name: f.replace(".json", ""), cookieCount: 0, savedAt: "unknown" };
    }
  });
}
