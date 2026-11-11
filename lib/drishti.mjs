/**
 * bwb-browser — Drishti mode
 *
 * Everything drishti-specific lives here so no other module has to know what
 * drishti is: the HTTP client for the app's /bwb/* control API, the paired-token
 * store, the CDP options helper, and the two behaviours that only make sense
 * against a browser a human is also holding (takeover pause, site approval).
 *
 * Design rules:
 *  - The token never leaves this process except in an x-bwb-token request
 *    header. It is never put in a URL, a log line, an error message or a tool
 *    result — everything user-visible goes through maskToken().
 *  - cdpOpts().alterPath only ever touches /json* paths. chrome-remote-interface
 *    also passes WebSocket pathnames through alterPath; a "?" there gets
 *    URL-encoded and breaks the handshake. Drishti's own WebSocket URLs already
 *    carry their token.
 *  - Control calls are fire-and-forget where the spec says so: a dead status
 *    endpoint must never break a browser tool.
 */

import { execFile } from "child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import { connect } from "net";
import { request as httpRequest } from "http";
import CDP from "chrome-remote-interface";

export const DEFAULT_PORT = 9222;
export const DEFAULT_HANDBACK_TIMEOUT_MS = 300_000; // 5 min — a human login, not an eternity
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
export const DEFAULT_POLL_MS = 1_500;

// ─── Errors ──────────────────────────────────────────────────────────────────

/** The app answered, but not with 2xx. Carries the status for 404 handling. */
export class DrishtiHttpError extends Error {
  constructor(message, { status = null, path = "", body = "" } = {}) {
    super(message);
    this.name = "DrishtiHttpError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/** Raised when drishti is asked to do something the installed app cannot do. */
export class DrishtiUnsupportedError extends Error {
  constructor(message, feature = "") {
    super(message);
    this.name = "DrishtiUnsupportedError";
    this.feature = feature;
  }
}

/** A drishti pause that ended on a timeout, not on success. */
export class DrishtiPausedError extends Error {
  constructor(message, { kind = "unknown", waitedMs = 0 } = {}) {
    super(message);
    this.name = "DrishtiPausedError";
    this.drishti = { kind, waitedMs };
  }
}

// ─── Token store (~/.config/bwb/drishti.json, 0600) ──────────────────────────

export function storePath(env = process.env) {
  return env.BWB_DRISHTI_STORE || join(homedir(), ".config", "bwb", "drishti.json");
}

/** Read the paired store. Returns null when absent, corrupt, or tokenless. */
export function readStore(env = process.env) {
  try {
    const data = JSON.parse(readFileSync(storePath(env), "utf8"));
    if (!data || typeof data.token !== "string" || !data.token.trim()) return null;
    const port = Number(data.port);
    return {
      token: data.token.trim(),
      port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT,
      app: typeof data.app === "string" ? data.app : null,
      pairedAt: typeof data.pairedAt === "string" ? data.pairedAt : null,
      // Contract v2: identity for tab leases. Surviving a restart is the whole
      // point — an id that changes every run fights its own expiring leases.
      clientId: typeof data.clientId === "string" && data.clientId ? data.clientId : null,
    };
  } catch {
    return null;
  }
}

/** Write the store with 0700 dir / 0600 file. Returns the path written. */
export function writeStore(data, env = process.env) {
  if (!data || typeof data.token !== "string" || !data.token.trim()) {
    throw new Error("Refusing to write a drishti store without a token");
  }
  const path = storePath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const payload = {
    token: data.token.trim(),
    port: Number.isInteger(data.port) && data.port > 0 ? data.port : DEFAULT_PORT,
    app: data.app || "drishti",
    pairedAt: data.pairedAt || new Date().toISOString(),
  };
  if (typeof data.clientId === "string" && data.clientId) payload.clientId = data.clientId;
  writeFileSync(path, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort on Android */ }
  return path;
}

export function removeStore(env = process.env) {
  try { rmSync(storePath(env), { force: true }); return true; } catch { return false; }
}

/** Never print a token. Enough to tell two tokens apart, not enough to use one. */
export function maskToken(token) {
  if (!token) return null;
  const s = String(token);
  return s.length <= 8 ? "set" : `set (…${s.slice(-4)})`;
}

// ─── Resolved context ────────────────────────────────────────────────────────

export function resolvePort({ env = process.env, store } = {}) {
  const fromEnv = Number(env.BWB_DRISHTI_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  const s = store === undefined ? readStore(env) : store;
  return s?.port || DEFAULT_PORT;
}

export function resolveToken({ env = process.env, store } = {}) {
  if (env.BWB_DRISHTI_TOKEN) return env.BWB_DRISHTI_TOKEN.trim();
  const s = store === undefined ? readStore(env) : store;
  return s?.token || null;
}

/** One object to pass to every control call: {port, token}. */
export function resolveContext({ env = process.env, store } = {}) {
  const s = store === undefined ? readStore(env) : store;
  return { port: resolvePort({ env, store: s }), token: resolveToken({ env, store: s }) };
}

// ─── HTTP client (loopback only, token in a header) ──────────────────────────

/**
 * Call the app's control API. Loopback only — drishti binds 127.0.0.1 and so do
 * we. The token travels in x-bwb-token, never in the URL, so it cannot end up in
 * a proxy log or a crash dump of the request line.
 */
function httpCall(method, path, { port = DEFAULT_PORT, token = null, body = null, timeoutMs = 5_000, extraHeaders = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers["x-bwb-token"] = token;
    if (extraHeaders) Object.assign(headers, extraHeaders);
    // One request per TCP connection. The drishti relay forwards /json/* to the
    // WebView socket and pipes the connection both ways; a keep-alive client
    // would send its next request down that same socket and the WebView (not
    // the app) would answer it — /bwb/state came back as an empty 404 that way.
    headers["connection"] = "close";
    let payload = null;
    if (body !== null && body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    const route = String(path).split("?")[0];
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method, headers, timeout: timeoutMs, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try { data = text ? JSON.parse(text) : null; } catch { data = null; }
          resolve({ status: res.statusCode, json: data, text });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`drishti did not answer ${route} within ${timeoutMs}ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function routeOf(path) {
  return String(path).split("?")[0];
}

/** Throwing form: any non-2xx is an error. Used by everything but pairing. */
export async function httpJson(method, path, opts = {}) {
  const res = await httpCall(method, path, opts);
  if (res.status >= 200 && res.status < 300) return res.json ?? {};
  throw new DrishtiHttpError(`${method} ${routeOf(path)} → HTTP ${res.status}`, {
    status: res.status,
    path: routeOf(path),
    body: String(res.text || "").slice(0, 200),
  });
}

/**
 * Non-throwing form: {status, json, text} for every HTTP answer. Pairing needs
 * the 202 / 200 / 403 / 410 distinction — those are the protocol, not failures.
 */
export function httpJsonStatus(method, path, opts = {}) {
  return httpCall(method, path, opts);
}

// ─── Control API ─────────────────────────────────────────────────────────────

/**
 * GET /bwb/hello — {app: "drishti", version, name}.
 * Sent with the token when we have one: the app may serve it publicly (as
 * specified) or behind the same auth gate as everything else. Either way it
 * answers the only question that matters — is this drishti?
 */
export function hello({ port, token, timeoutMs = 800 } = {}) {
  return httpJson("GET", "/bwb/hello", {
    port: port ?? resolvePort(),
    token: token === undefined ? resolveToken() : token,
    timeoutMs,
  });
}

/**
 * GET /bwb/pair?code=... — ONE non-blocking poll.
 * Returns {status, json}: 202 {status:"pending"}, 200 {status:"approved", token},
 * 403 {status:"denied"}, 410 {status:"expired"}. Nothing here waits.
 */
export function pairWithCode({ code, port, timeoutMs = 5_000 } = {}) {
  if (!code) throw new Error("pairWithCode needs a code");
  return httpJsonStatus("GET", `/bwb/pair?code=${encodeURIComponent(code)}`, {
    port: port ?? resolvePort(),
    timeoutMs,
  });
}

/**
 * GET /bwb/state[?wait=N] — {mode: "AGENT"|"USER", help: null|{id,kind,reason,
 * domain?,status,approved?}}. No waitSec answers immediately (the only form a UI
 * should use); waitSec holds until the mode or help changes, up to 30s.
 */
export function getState({ port, token, waitSec = 0, timeoutMs } = {}) {
  const ctx = { port: port ?? resolvePort(), token: token === undefined ? resolveToken() : token };
  const wait = Math.max(0, Math.min(30, Math.trunc(Number(waitSec) || 0)));
  const path = wait > 0 ? `/bwb/state?wait=${wait}` : "/bwb/state";
  return httpJson("GET", path, {
    ...ctx,
    // The server may hold the whole window; the socket has to outlive it.
    timeoutMs: timeoutMs ?? (wait > 0 ? wait * 1000 + 5_000 : 3_000),
  });
}

/** Can the next step run? mode AGENT and no unresolved help. */
export function isResumed(state) {
  const mode = String(state?.mode ?? "").toUpperCase();
  const help = state?.help ?? null;
  return mode === "AGENT" && (help === null || help?.status === "resolved");
}

/** POST /bwb/status — plain-human step text. Never values, never page content. */
export function postStatus({ port, token, step, tool, state = "working", timeoutMs = 1_500 } = {}) {
  const ctx = { port: port ?? resolvePort(), token: token === undefined ? resolveToken() : token };
  return httpJson("POST", "/bwb/status", { ...ctx, body: { step, tool, state }, timeoutMs });
}

/**
 * POST /bwb/help — {kind:"help"|"site", reason, domain?} -> {id}.
 * Sets help pending, switches the app to USER, notifies the phone. The id is
 * also what GET /bwb/state reports until the human resolves it.
 */
export function askHelp({ port, token, kind = "help", reason, domain = null, timeoutMs = 8_000 } = {}) {
  const ctx = { port: port ?? resolvePort(), token: token === undefined ? resolveToken() : token };
  const body = { kind, reason };
  if (kind === "site" && domain) body.domain = domain;
  return httpJson("POST", "/bwb/help", { ...ctx, body, timeoutMs });
}

/**
 * Identity for this bwb process, sent as `X-BWB-Client` on every tab call.
 *
 * Stable across restarts on the same install (it lives in the paired store), so
 * a lease taken before a crash is still recognisably ours after it. Without a
 * stable id, every restart would have to fight an expiring lease for two
 * minutes because "someone else" held the tab.
 */
export function clientId({ env = process.env } = {}) {
  const forced = String(env.BWB_CLIENT_ID || "").trim();
  if (forced) return forced.slice(0, 64);

  const store = readStore(env);
  if (store?.clientId) return store.clientId;
  if (!store) return "bwb-" + randomBytes(6).toString("hex");

  const id = "bwb-" + randomBytes(6).toString("hex");
  try {
    writeStore({ ...store, clientId: id }, env);
  } catch {
    // A read-only config dir still leaves us a usable, if process-scoped, id.
  }
  return id;
}

/** POST /bwb/tab — the only way to open a tab on WebView (no /json/new). */
export async function openTab({ port, token, url = null, timeoutMs = 8_000, client = undefined } = {}) {
  const ctx = { port: port ?? resolvePort(), token: token === undefined ? resolveToken() : token };
  const who = client === undefined ? clientId() : client;
  try {
    const res = await httpJson("POST", "/bwb/tab", {
      ...ctx,
      body: { url },
      timeoutMs,
      extraHeaders: who ? { "x-bwb-client": who } : null,
    });
    // Older builds answer with the bare {id}; v2 answers {tab:{id},leased}.
    const tabId = res?.tab?.id ?? res?.id ?? null;
    return { ...res, tabId, leased: res?.leased === true };
  } catch (err) {
    if (err instanceof DrishtiHttpError && (err.status === 404 || err.status === 501)) {
      throw new DrishtiUnsupportedError(
        "This drishti build has no POST /bwb/tab endpoint, so bwb cannot open a tab. " +
        "WebView has no /json/new either. Update the app or use the tab the human already has open.",
        "tab",
      );
    }
    throw err;
  }
}

// ─── Tab leases (contract v2) ────────────────────────────────────────────────

function tabCtx({ port, token, client }) {
  return {
    port: port ?? resolvePort(),
    token: token === undefined ? resolveToken() : token,
    client: client === undefined ? clientId() : client,
  };
}

/** GET /bwb/tabs — metadata and lease state, readable without a lease. */
export async function listDrishtiTabs({ port, token, timeoutMs = 3_000 } = {}) {
  const ctx = tabCtx({ port, token, client: null });
  return httpJson("GET", "/bwb/tabs", { ...ctx, timeoutMs });
}

/**
 * POST /bwb/tab/lease — take the exclusive write lease.
 * Returns {leased:true, tab} or {leased:false, heldBy} instead of throwing:
 * a busy tab is a normal answer, not an exception.
 */
export async function leaseTab({ tab, port, token, client, timeoutMs = 3_000 } = {}) {
  if (!tab) throw new Error("leaseTab needs a tab id");
  const ctx = tabCtx({ port, token, client });
  try {
    const res = await httpJson("POST", "/bwb/tab/lease", {
      ...ctx,
      body: { tab },
      timeoutMs,
      extraHeaders: ctx.client ? { "x-bwb-client": ctx.client } : null,
    });
    return { leased: true, tab: res?.tab ?? null, leaseSec: res?.lease_sec ?? null };
  } catch (err) {
    if (err instanceof DrishtiHttpError && err.status === 409) {
      let heldBy = null;
      try { heldBy = JSON.parse(err.body)?.held_by ?? null; } catch {}
      return { leased: false, heldBy, code: "tab_locked" };
    }
    throw err;
  }
}

/** POST /bwb/tab/release · POST /bwb/tab/activate · POST /bwb/tab/close */
export function releaseTab({ tab, port, token, client, timeoutMs = 3_000 } = {}) {
  const ctx = tabCtx({ port, token, client });
  return httpJson("POST", "/bwb/tab/release", {
    ...ctx, body: { tab }, timeoutMs,
    extraHeaders: ctx.client ? { "x-bwb-client": ctx.client } : null,
  });
}

export function activateTab({ tab, port, token, timeoutMs = 3_000 } = {}) {
  const ctx = tabCtx({ port, token, client: null });
  return httpJson("POST", "/bwb/tab/activate", { ...ctx, body: { tab }, timeoutMs });
}

export function closeDrishtiTab({ tab, port, token, client, timeoutMs = 5_000 } = {}) {
  const ctx = tabCtx({ port, token, client });
  return httpJson("POST", "/bwb/tab/close", {
    ...ctx, body: { tab }, timeoutMs,
    extraHeaders: ctx.client ? { "x-bwb-client": ctx.client } : null,
  });
}

// ─── CDP options (port + token, token only on /json*) ────────────────────────

/**
 * Add the token to a DevTools HTTP path. Only /json* paths are touched: CRI
 * hands the WebSocket pathname to alterPath too, and a query string there is
 * percent-encoded into the pathname and kills the handshake.
 */
export function withToken(path, token) {
  if (!token || typeof path !== "string") return path;
  if (!path.startsWith("/json")) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}

/** Options for every CDP call: CDP(), List, New, Close, Activate. */
export function cdpOpts({ env = process.env, store } = {}) {
  const ctx = resolveContext({ env, store });
  return {
    port: ctx.port,
    token: ctx.token,
    alterPath: (path) => withToken(path, ctx.token),
  };
}

// ─── Mode plumbing ───────────────────────────────────────────────────────────

/**
 * Force the rules that make drishti mode safe: attach only, no static rung, no
 * tab cap, no mayfly, no journal, no hibernation. Mutates and returns cfg.
 */
export function applyDrishtiDefaults(cfg, { port } = {}) {
  const ctx = resolveContext();
  if (!ctx.token) {
    throw new Error(
      "drishti mode needs a paired token. Run `bwb pair` (one tap in the app), " +
      "or set BWB_DRISHTI_TOKEN.",
    );
  }
  cfg.drishti = true;
  cfg.attachPort = cfg.attachPort || cfg.drishtiPort || port || ctx.port;
  cfg.alwaysBrowser = true;   // static fetch would answer a different browser than the human sees
  cfg.tabMax = 0;             // never hibernate/close the human's tabs to save RAM
  cfg.idleMs = 0;             // the app owns its lifecycle — bwb is a guest
  cfg.journalFull = false;
  cfg.lean = false;           // nothing is spawned, so lean flags have no one to apply to
  return cfg;
}

/**
 * AUTO detection: a paired store plus GET /bwb/hello reporting app "drishti".
 * Any failure means "not drishti" — auto mode must never block startup.
 */
export async function detectDrishti({ env = process.env, timeoutMs = 800 } = {}) {
  const store = readStore(env);
  if (!store) return { enabled: false, reason: "no paired store" };
  try {
    const info = await hello({ port: resolvePort({ env, store }), token: store.token, timeoutMs });
    const app = String(info?.app || "").toLowerCase();
    if (app === "drishti") return { enabled: true, store, info };
    return { enabled: false, reason: `app says "${app || "unknown"}", not drishti` };
  } catch (err) {
    return { enabled: false, reason: err.message };
  }
}

// ─── Error classification (drishti's synthetic CDP errors) ───────────────────

/**
 * drishti answers blocked CDP commands with a real CDP error frame:
 *   code -32000, "Action rejected: User has taken control …"
 *   code -32001, "Domain permission denied: … requires user approval …"
 * CRI surfaces those as ProtocolError with .response = {code, message}.
 */
export function cdpErrorInfo(err) {
  const response = err?.response && typeof err.response === "object" ? err.response : null;
  const code = typeof response?.code === "number"
    ? response.code
    : (typeof err?.code === "number" ? err.code : null);
  const message = String(response?.message || err?.message || err || "");

  let kind = null;
  if (code === -32000 && /user has taken control|in USER mode/i.test(message)) {
    kind = "user_takeover";
  } else if (code === -32001 || /domain permission denied|requires user approval/i.test(message)) {
    kind = "domain_blocked";
  }
  return { kind, code, message };
}

export function isUserTakeover(err) {
  return cdpErrorInfo(err).kind === "user_takeover";
}

export function isDomainBlocked(err) {
  return cdpErrorInfo(err).kind === "domain_blocked";
}

/** Pull the host out of "Navigation to '<url>' requires user approval". */
export function domainFromBlockError(message) {
  const m = /(?:Navigation to|Interaction on)\s+'([^']+)'/.exec(String(message || ""));
  if (!m) return null;
  const raw = m[1];
  try {
    const host = new URL(raw).hostname;
    return host || null;
  } catch {
    const host = raw.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0];
    return host || null;
  }
}

// ─── Takeover / approval waits ───────────────────────────────────────────────

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the human hands control back (state.mode !== "user").
 * Returns {handedBack, waitedMs, error}. Never throws for a timeout: a timeout
 * is an answer, and the caller has to report it, not crash.
 */
export async function waitForHandback({
  port, token,
  timeoutMs = DEFAULT_HANDBACK_TIMEOUT_MS,
  intervalMs = DEFAULT_POLL_MS,
  get = getState,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const start = now();
  let lastError = null;
  let lastState = null;

  while (now() - start < timeoutMs) {
    // Ask the app to hold the request instead of re-asking every 1.5s: one
    // ?wait= call per change, not 200 polls against a phone.
    const remainingMs = timeoutMs - (now() - start);
    const waitSec = Math.max(1, Math.min(30, Math.ceil(remainingMs / 1000)));
    try {
      const state = await get({ port, token, waitSec });
      lastState = state;
      lastError = null;
      if (isResumed(state)) {
        return { handedBack: true, waitedMs: now() - start, state, error: null };
      }
    } catch (err) {
      // App restarting mid-handback (or a build with no ?wait=): retry shortly.
      lastError = err;
      await sleep(Math.min(intervalMs, 1_000));
    }
  }
  return { handedBack: false, waitedMs: now() - start, state: lastState, error: lastError };
}

/**
 * The human's decision, from whichever field the app is currently reporting.
 *
 * `help` is the live request and clears once resolved; `last_help` (contract
 * v2) keeps the decision after the clear. Checking both is what makes a denial
 * terminal: the old code treated "no pending help" as approval, so a human who
 * tapped Deny was indistinguishable from one who tapped Allow (D5).
 */
function decisionOf(state) {
  const live = state?.help ?? null;
  if (live && live.status === "resolved") return live;
  const last = state?.last_help ?? null;
  if (last && last.status === "resolved") return last;
  return null;
}

/**
 * Wait until the human decides, or time out. Never assumes approval.
 * Returns {approved, denied, timedOut, waitedMs}.
 */
export async function waitForApproval({
  domain, port, token,
  timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
  intervalMs = DEFAULT_POLL_MS,
  get = getState,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const start = now();
  let lastState = null;
  let lastError = null;

  while (now() - start < timeoutMs) {
    const remainingMs = timeoutMs - (now() - start);
    const waitSec = Math.max(1, Math.min(30, Math.ceil(remainingMs / 1000)));
    try {
      const state = await get({ port, token, waitSec });
      lastState = state;
      lastError = null;

      const decision = decisionOf(state);
      if (decision) {
        const sameDomain = !domain || !decision.domain ||
          String(decision.domain).toLowerCase() === String(domain).toLowerCase();
        if (sameDomain) {
          return {
            approved: decision.approved === true,
            denied: decision.approved === false,
            timedOut: false,
            waitedMs: now() - start,
            state,
          };
        }
      }
    } catch (err) {
      lastError = err;
      await sleep(Math.min(intervalMs, 1_000));
    }
  }
  // Silence is not consent.
  return {
    approved: false,
    denied: false,
    timedOut: true,
    waitedMs: now() - start,
    state: lastState,
    error: lastError,
  };
}

/**
 * Run one step; if drishti pushes back, pause and resume instead of failing.
 *
 *  - USER mode  → wait for handback, then run the same step again.
 *  - blocked site → ask the app to approve the domain, wait, retry once.
 *
 * `fn` must be idempotent enough to repeat: drishti only rejects a command
 * before it reaches WebView, so the first attempt never happened.
 */
export async function runDrishtiAware(fn, ctx, {
  handbackTimeoutMs = Number(process.env.BWB_HANDBACK_TIMEOUT_MS) || DEFAULT_HANDBACK_TIMEOUT_MS,
  approvalTimeoutMs = Number(process.env.BWB_APPROVAL_TIMEOUT_MS) || DEFAULT_APPROVAL_TIMEOUT_MS,
  pollMs = Number(process.env.BWB_DRISHTI_POLL_MS) || DEFAULT_POLL_MS,
  ask = askHelp,
  get = getState,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  try {
    return await fn();
  } catch (err) {
    const info = cdpErrorInfo(err);

    if (info.kind === "user_takeover") {
      const res = await waitForHandback({ port: ctx.port, token: ctx.token, timeoutMs: handbackTimeoutMs, intervalMs: pollMs, get, sleep, now });
      if (!res.handedBack) {
        throw new DrishtiPausedError(
          `The human is still in control after ${Math.round(handbackTimeoutMs / 1000)}s. ` +
          "Nothing was changed. Ask them to tap Hand back, then run the step again.",
          { kind: "user_takeover", waitedMs: res.waitedMs },
        );
      }
      return await fn(); // resume the same step
    }

    if (info.kind === "domain_blocked") {
      const domain = domainFromBlockError(info.message);
      const reason = domain ? `Approve ${domain}?` : "Approve this site?";
      let asked = true;
      try {
        await ask({
          port: ctx.port,
          token: ctx.token,
          kind: domain ? "site" : "help",
          reason,
          domain,
        });
      } catch {
        // The app may have raised its own approval dialog. That is not
        // permission to proceed — it is still a question waiting on a human.
        asked = false;
      }
      const res = await waitForApproval({
        domain, port: ctx.port, token: ctx.token,
        timeoutMs: approvalTimeoutMs, intervalMs: pollMs, get, sleep, now,
      });
      if (!res.approved) {
        const why = res.denied
          ? `${domain || "The site"} was denied by the human.`
          : `Nobody answered the ${domain || "site"} approval within ${Math.round(approvalTimeoutMs / 1000)}s` +
            (asked ? "." : " (the app did not accept a help request either).");
        throw new DrishtiPausedError(
          `${why} Nothing was changed. Do not retry a denial; ask the human in chat.`,
          { kind: res.denied ? "domain_denied" : "domain_blocked", waitedMs: res.waitedMs },
        );
      }
      return await fn(); // retry exactly once
    }

    throw err;
  }
}

// ─── Step reporting (fire-and-forget) ────────────────────────────────────────

const HOST_OF = (url) => {
  try { return new URL(String(url)).host || String(url); } catch { return String(url || ""); }
};

/**
 * Human step text for the app's status line. Never includes typed values, JS
 * expressions, or page content — those can be passwords.
 */
export function humanStep(tool, args = {}) {
  switch (tool) {
    case "browser_goto": return `Opening ${HOST_OF(args.url)}`;
    case "browser_back": return "Going back";
    case "browser_click": return `Clicking ${args.selector || "an element"}`;
    case "browser_fill": return `Typing in ${args.selector || "a field"}`;
    case "browser_act": return "Working with the page";
    case "browser_eval": return "Running a script on the page";
    case "browser_screenshot": return "Capturing the screen";
    case "browser_text":
    case "browser_html": return "Reading the page";
    case "browser_elements": return "Looking for elements";
    case "browser_waitForSelector": return `Waiting for ${args.selector || "content"}`;
    case "browser_newTab": return `Opening a tab${args.url ? ` to ${HOST_OF(args.url)}` : ""}`;
    case "browser_switchTab": return "Switching tabs";
    case "browser_closeTab": return "Closing a tab";
    case "browser_saveCookies": return "Saving the session";
    case "browser_loadCookies": return "Restoring the session";
    case "browser_download": return "Downloading";
    case "browser_restart": return "Restarting the browser";
    default: return String(tool || "").replace(/^browser_/, "").replace(/([A-Z])/g, " $1").toLowerCase().trim() || "Working";
  }
}

/**
 * Debounced status poster. Coalesces bursts into one request, keeps the latest
 * step, and swallows every failure: a dead /bwb/status must never fail a tool.
 */
export function createStepReporter({ port, token, post = postStatus, minIntervalMs = 400, now = Date.now } = {}) {
  let lastSentAt = 0;
  let timer = null;
  let queued = null;
  let lastKey = null;

  const send = (item) => {
    lastSentAt = now();
    try {
      const p = post(item);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch { /* fire-and-forget, always */ }
  };

  const flush = () => {
    timer = null;
    if (!queued) return;
    const item = queued;
    queued = null;
    send(item);
  };

  return {
    report(step, tool, state = "running") {
      const key = `${state}\u0000${step}`;
      if (key === lastKey && state === "running") return; // identical consecutive step
      lastKey = key;
      const item = { port, token, step, tool, state };
      const wait = minIntervalMs - (now() - lastSentAt);
      if (wait <= 0) { send(item); return; }
      queued = item;
      if (!timer) {
        timer = setTimeout(flush, wait);
        if (timer.unref) timer.unref();
      }
    },
    pending() { return queued; },
    stop() { if (timer) { clearTimeout(timer); timer = null; } queued = null; },
  };
}

// ─── Pairing ─────────────────────────────────────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 8 chars, 40 bits — read aloud from the phone, single use, short-lived. */
export function generatePairCode(bytes = randomBytes(5)) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.slice(0, 8);
}

/** `am start -a com.bwb.browser.PAIR --es code <code>` — execFile, no shell. */
export function announcePairCode(code) {
  return new Promise((resolve) => {
    execFile("am", ["start", "-a", "com.bwb.drishti.PAIR", "--es", "code", code], { timeout: 10_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, error: err ? String((stderr || stdout || err.message)).trim().slice(0, 300) : null });
    });
  });
}

/**
 * Pair: announce the code to the app, then poll until the human taps approve.
 * Resolves {token, app, amError}; throws with a fixable message on timeout.
 */
export async function pairFlow({
  code = generatePairCode(),
  port,
  timeoutMs = 60_000,
  intervalMs = 1_000,
  am = announcePairCode,
  get = pairWithCode,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const targetPort = port ?? resolvePort();
  let amError = null;
  let lastError = null;
  let lastStatus = 0;

  try {
    const announced = await am(code);
    if (announced && announced.ok === false) amError = announced.error;
  } catch (err) {
    amError = err.message;
  }

  const start = now();
  while (now() - start < timeoutMs) {
    let res = null;
    try {
      res = await get({ code, port: targetPort });
      lastError = null;
    } catch (err) {
      // A dead relay or a build without /bwb/pair: keep polling until the
      // window closes, then report the last real error.
      lastError = err;
      await sleep(intervalMs);
      continue;
    }

    const status = Number(res?.status ?? 0);
    const body = res?.json ?? {};
    lastStatus = status;

    if (status === 200 && body.status === "approved") {
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token) throw new Error("drishti approved the code but returned no token");
      return { code, token, port: targetPort, app: "drishti", amError };
    }
    if (status === 403) {
      throw new Error(
        `Pairing denied on the phone (code ${code}). Run \`bwb pair\` again and tap Allow.`,
      );
    }
    if (status === 410) {
      throw new Error(
        `Pairing code ${code} expired after 60s. Run \`bwb pair\` again` +
        (amError ? ` (announce failed: ${amError}).` : "."),
      );
    }
    if (status === 400) {
      throw new Error(
        `The app rejected the pairing request: ${body.error || "missing code"}. ` +
        "This build may predate contract v1 — update the drishti app.",
      );
    }
    // 202 pending, or 404/501 from an older build: poll again.
    await sleep(intervalMs);
  }

  const hint = amError
    ? ` Could not announce the code to the app (${amError}). Open drishti and tap "Pair bwb" instead.`
    : " Open drishti and tap Allow for the code shown.";
  throw new Error(
    `Pairing timed out after ${Math.round(timeoutMs / 1000)}s (code ${code}, last status ${lastStatus || "none"}).${hint}` +
    (lastError ? ` Last error: ${lastError.message}` : ""),
  );
}

// ─── Doctor (bwb drishti) ────────────────────────────────────────────────────

/**
 * Check every link in the chain and say how to fix each failure.
 * Returns {ok, checks: [{name, ok, detail, fix?}]}.
 */
export async function doctor({ env = process.env, ctx } = {}) {
  const context = ctx || resolveContext({ env });
  const checks = [];

  const store = readStore(env);
  checks.push({
    name: "paired",
    ok: Boolean(store),
    detail: store ? `token ${maskToken(store.token)} on port ${store.port}` : `no store at ${storePath(env)}`,
    fix: store ? undefined : "bwb pair",
  });
  if (!store) return { ok: false, checks };

  const relay = await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: context.port });
    const done = (ok, detail) => { try { socket.destroy(); } catch {} resolve({ ok, detail }); };
    socket.setTimeout(1_500);
    socket.once("connect", () => done(true, `relay listening on 127.0.0.1:${context.port}`));
    socket.once("timeout", () => done(false, "no answer within 1.5s"));
    socket.once("error", (err) => done(false, err.code || err.message));
  });
  checks.push({
    name: "relay",
    ok: relay.ok,
    detail: relay.detail,
    fix: relay.ok ? undefined : "Open drishti and switch the relay on (the app must be in the foreground at least once).",
  });

  try {
    const info = await hello({ port: context.port, token: context.token, timeoutMs: 1_500 });
    const ok = String(info?.app || "").toLowerCase() === "drishti";
    checks.push({
      name: "app",
      ok,
      detail: ok ? `${info.name || "drishti"} ${info.version || ""}`.trim() : `hello says app="${info?.app}"`,
      fix: ok ? undefined : "Install/launch drishti; the installed build may predate /bwb/hello (contract v1).",
    });

    if (ok) {
      const contract = Number(info?.contract) || 0;
      const caps = Array.isArray(info?.capabilities) ? info.capabilities : [];
      checks.push({
        name: "contract",
        ok: contract >= 1,
        detail: contract
          ? `v${contract}${contract >= 2 ? " (tab leases, last_help)" : ""}` +
            (caps.length ? ` · ${caps.length} capabilities` : "")
          : "no contract field (pre-v1 build)",
        fix: contract >= 1
          ? undefined
          : "Update the drishti app: this build predates BWB control contract v1 (docs/DRISHTI-CONTRACT.md).",
      });
    }
  } catch (err) {
    const missing = err.status === 401 || err.status === 404;
    checks.push({
      name: "app",
      ok: false,
      detail: err.message,
      fix: missing
        ? "This drishti build has no /bwb/hello yet (pre contract v1). The relay and token still work — use --drishti, not auto-detect."
        : "Open drishti and turn the relay on, then `am start -n com.bwb.drishti.debug/com.bwb.drishti.MainActivity`.",
    });
  }

  try {
    const version = await httpJson("GET", "/json/version", { port: context.port, token: context.token, timeoutMs: 2_000 });
    checks.push({
      name: "token",
      ok: true,
      detail: `${version?.Browser || "devtools"} (${version?.["Android-Package"] || "unknown app"})`,
    });
  } catch (err) {
    checks.push({
      name: "token",
      ok: false,
      detail: err.message,
      fix: err.status === 401 ? "Token rejected — regenerate it in the app, then `bwb pair` again." : "Is the relay on?",
    });
  }

  try {
    const list = await httpJson("GET", "/json/list", { port: context.port, token: context.token, timeoutMs: 2_000 });
    const pages = Array.isArray(list) ? list.filter((t) => t.type === "page") : [];
    checks.push({
      name: "tabs",
      ok: pages.length > 0,
      detail: `${pages.length} page target(s)`,
      fix: pages.length ? undefined : "Open a tab in drishti.",
    });
  } catch (err) {
    checks.push({ name: "tabs", ok: false, detail: err.message, fix: "See the token check." });
  }

  // The tab registry is the v2 answer to "what is actually open, and who is
  // driving it". /json/list proves the CDP pipe; this proves the shared model.
  try {
    const registry = await listDrishtiTabs({ port: context.port, token: context.token, timeoutMs: 2_000 });
    const tabs = Array.isArray(registry?.tabs) ? registry.tabs : [];
    const leased = tabs.filter((t) => t.leased);
    const detail = tabs.length
      ? `${tabs.length}/${registry?.max ?? "?"} tabs, ${leased.length} leased` +
        (leased.length
          ? ` (${leased.map((t) => `${t.id.slice(0, 8)}→${t.owner}`).join(", ")})`
          : "")
      : "no tabs in the registry";
    checks.push({ name: "leases", ok: true, detail });
  } catch (err) {
    const missing = err.status === 403 || err.status === 404 || err.status === 501;
    checks.push({
      name: "leases",
      ok: false,
      detail: missing ? "this build has no tab registry (pre-contract v2)" : err.message,
      fix: missing
        ? "Update the drishti app for tab leases, or drive one tab without them."
        : "See the token check.",
    });
  }

  try {
    const state = await getState({ port: context.port, token: context.token, timeoutMs: 2_000 });
    const last = state?.last_help;
    const decision = last?.status === "resolved"
      ? `last decision: ${last.approved ? "approved" : "denied"} ${last.domain || last.kind}`
      : "no decisions yet";
    checks.push({
      name: "control",
      ok: true,
      detail: `mode=${state?.mode ?? "unknown"}${
        state?.help?.status === "pending" ? `, help pending: ${state.help.reason || state.help.kind}` : ""
      } · ${decision}`,
      fix: undefined,
    });
  } catch (err) {
    checks.push({
      name: "control",
      ok: false,
      detail: err.message,
      fix: "GET /bwb/state is missing — this build predates the control API (Part B).",
    });
  }

  // The accessibility tree is what browser_snapshot reads. If the WebView does
  // not expose one, snapshot is still usable — it says so and points at
  // browser_extract — but the caller should know that before blaming the page.
  try {
    const list = await httpJson("GET", "/json/list", { port: context.port, token: context.token, timeoutMs: 2_000 });
    const page = (Array.isArray(list) ? list : []).find((t) => t.type === "page");
    if (!page) throw new Error("no page target to inspect");
    const cdp = await CDP({ ...cdpOpts({ env }), target: page.id });
    try {
      await cdp.Accessibility.enable();
      const { nodes } = await cdp.Accessibility.getFullAXTree();
      const actionable = (nodes || []).filter((n) =>
        !n.ignored && n.backendDOMNodeId && n.role?.value &&
        !["none", "generic", "StaticText", "InlineTextBox"].includes(n.role.value)).length;
      checks.push({
        name: "snapshot",
        ok: actionable > 0,
        detail: `${(nodes || []).length} AX nodes, ${actionable} addressable — ${
          actionable > 0 ? "browser_snapshot works on this build" : "no tree exposed"}`,
        fix: actionable > 0
          ? undefined
          : "This WebView exposes no accessibility tree, so browser_snapshot has nothing to read. " +
            "browser_extract, browser_elements and browser_text still work on the same page.",
      });
    } finally {
      await cdp.close().catch(() => {});
    }
  } catch (err) {
    checks.push({
      name: "snapshot",
      ok: false,
      detail: err.message,
      fix: "Could not attach to the page target — check the token and that a tab is open.",
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

// ─── Misc ────────────────────────────────────────────────────────────────────

export function isAndroid() {
  return Boolean(process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux") || existsSync("/system/build.prop"));
}
