/**
 * bwb-browser — console and network, always on.
 *
 * browser_watch was opt-in: start it, do the thing, poll it, stop it. An agent
 * that forgets the first step learns nothing, and the errors that matter are
 * the ones on the way to the page, before anyone thought to record.
 *
 * This is the opposite: every CDP client that gets used is attached once, and
 * the last few hundred console lines and requests stay in a ring buffer. Ask
 * for them whenever you like; nobody has to remember to start recording.
 *
 * Cost is bounded on purpose — 300 console entries, 400 requests, and only the
 * metadata of a request, never its body. The phone has 1 GB.
 */

const MAX_CONSOLE = 300;
const MAX_NETWORK = 400;

const consoleLog = [];
const networkLog = new Map(); // requestId → entry, insertion-ordered
const attached = new WeakSet();
const pending = new WeakMap();
let startedAt = Date.now();
/** Why instrumentation last failed, if it did. Never silent. */
export let lastError = null;

/** RemoteObject → one readable line, without ever inventing a value. */
function stringifyArg(arg) {
  if (!arg) return "";
  if (arg.type === "string") return arg.value;
  if (arg.type === "undefined") return "undefined";
  if (arg.subtype === "null") return "null";
  if (arg.type === "object" || arg.type === "function") {
    if (arg.preview?.properties?.length) {
      const props = arg.preview.properties
        .slice(0, 8)
        .map((p) => `${p.name}: ${p.value === undefined ? p.type : p.value}`);
      return `${arg.preview.subtype === "array" ? "[" : "{"}${props.join(", ")}${arg.preview.subtype === "array" ? "]" : "}"}`;
    }
    return arg.description || arg.className || `[${arg.subtype || arg.type}]`;
  }
  return arg.unserializableValue || String(arg.value ?? arg.description ?? "");
}

function trim(text, max = 500) {
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function pushConsole(entry) {
  consoleLog.push({ at: Date.now(), ...entry, text: trim(entry.text) });
  if (consoleLog.length > MAX_CONSOLE) consoleLog.splice(0, consoleLog.length - MAX_CONSOLE);
}

function pushNetwork(entry) {
  networkLog.set(entry.id, entry);
  while (networkLog.size > MAX_NETWORK) {
    const oldest = networkLog.keys().next().value;
    networkLog.delete(oldest);
  }
}

/**
 * Attach once per client. Safe to call on every tool call — the WeakSet makes
 * the second call a no-op, and the promise stops two calls racing each other.
 */
export function attachTelemetry(cdp) {
  if (!cdp || typeof cdp !== "object") return Promise.resolve();
  if (attached.has(cdp)) return pending.get(cdp) || Promise.resolve();
  if (pending.has(cdp)) return pending.get(cdp);

  const p = (async () => {
    // Runtime is the one domain that must work: without it there is no console
    // and no way to evaluate a wait condition. If it fails we record why and
    // leave the client unattached, so a later call can try again.
    try {
      await cdp.Runtime.enable();
    } catch (err) {
      lastError = `Runtime.enable failed: ${err?.message || err}`;
      pending.delete(cdp);
      return;
    }
    await cdp.Log.enable().catch(() => {});
    await cdp.Network.enable({ maxTotalBufferSize: 2_000_000, maxResourceBufferSize: 200_000 }).catch(() => {});
    await cdp.Page.enable().catch(() => {});

    cdp.Runtime.consoleAPICalled(({ type, args, stackTrace, timestamp }) => {
      pushConsole({
        kind: "console",
        level: type === "warning" ? "warn" : type, // log|debug|info|error|warn|dir|…
        text: (args || []).map(stringifyArg).join(" "),
        url: stackTrace?.callFrames?.[0]?.url || "",
        line: stackTrace?.callFrames?.[0]?.lineNumber,
        pageAt: timestamp ? Math.round(timestamp) : undefined,
      });
    });

    cdp.Runtime.exceptionThrown(({ exceptionDetails, timestamp }) => {
      const ex = exceptionDetails?.exception;
      pushConsole({
        kind: "exception",
        level: "error",
        text: ex ? stringifyArg(ex) : exceptionDetails?.text || "Uncaught exception",
        url: exceptionDetails?.url || "",
        line: exceptionDetails?.lineNumber,
        stack: (exceptionDetails?.stackTrace?.callFrames || [])
          .slice(0, 4)
          .map((f) => `${f.functionName || "(anonymous)"} @ ${f.url || "?"}:${f.lineNumber}`)
          .join(" ← "),
        pageAt: timestamp ? Math.round(timestamp) : undefined,
      });
    });

    // Network failures the renderer reports as console errors ("Failed to load
    // resource") are already covered above; Log covers CSP and deprecations.
    cdp.Log.entryAdded(({ entry }) => {
      if (!entry) return;
      pushConsole({
        kind: "log",
        level: entry.level === "verbose" ? "debug" : entry.level,
        text: entry.text || "",
        url: entry.url || "",
        line: entry.lineNumber,
        pageAt: entry.timestamp ? Math.round(entry.timestamp) : undefined,
      });
    });

    cdp.Network.requestWillBeSent(({ requestId, request, type, timestamp }) => {
      pushNetwork({
        id: requestId,
        method: request?.method || "GET",
        url: request?.url || "",
        type: type || "Other",
        status: null,
        mimeType: "",
        bytes: 0,
        at: timestamp ? Math.round(timestamp * 1000) : Date.now(),
        ms: null,
        failed: null,
      });
    });

    cdp.Network.responseReceived(({ requestId, response, type }) => {
      const entry = networkLog.get(requestId);
      if (!entry) return;
      entry.status = response?.status ?? null;
      entry.mimeType = response?.mimeType || "";
      entry.type = type || entry.type;
    });

    cdp.Network.loadingFinished(({ requestId, timestamp, encodedDataLength }) => {
      const entry = networkLog.get(requestId);
      if (!entry) return;
      if (timestamp && entry.at) entry.ms = Math.max(0, Math.round(timestamp * 1000 - entry.at));
      if (typeof encodedDataLength === "number") entry.bytes = encodedDataLength;
    });

    cdp.Network.loadingFailed(({ requestId, errorText, blockedReason }) => {
      const entry = networkLog.get(requestId);
      if (!entry) return;
      entry.failed = blockedReason ? `${errorText} (${blockedReason})` : errorText || "failed";
    });
  })();

  p.then(() => {
    if (!lastError?.startsWith("Runtime.enable")) { attached.add(cdp); lastError = null; }
  }).catch((err) => { lastError = err?.message || String(err); });
  pending.set(cdp, p);
  return p;
}

/** Console entries, newest last. `since` is a millisecond timestamp. */
export function readConsole({ level, since = 0, limit = 100, clear = false } = {}) {
  let items = consoleLog.filter((e) => (e.at || 0) >= since);
  if (level) {
    const wanted = level === "warning" ? "warn" : level;
    items = items.filter((e) => e.level === wanted);
  }
  items = items.slice(-Math.max(1, Math.min(limit, MAX_CONSOLE)));
  if (clear) consoleLog.length = 0;
  return {
    count: items.length,
    total: consoleLog.length,
    since,
    entries: items.map(({ pageAt, ...rest }) => rest),
  };
}

/** Requests, newest last. Filter by type, status class, or failures only. */
export function readNetwork({ type, filter, since = 0, limit = 100, clear = false } = {}) {
  let items = [...networkLog.values()].filter((e) => (e.at || 0) >= since);
  if (type) {
    const wanted = type.toLowerCase();
    items = items.filter((e) => (e.type || "").toLowerCase() === wanted);
  }
  if (filter === "failed") items = items.filter((e) => e.failed);
  else if (filter === "http-error") items = items.filter((e) => e.status >= 400);
  else if (filter === "xhr") items = items.filter((e) => ["XHR", "Fetch"].includes(e.type));

  items = items.slice(-Math.max(1, Math.min(limit, MAX_NETWORK)));
  const out = {
    count: items.length,
    total: networkLog.size,
    since,
    requests: items.map((e) => ({
      method: e.method, url: trim(e.url, 300), type: e.type,
      status: e.status, mimeType: e.mimeType,
      bytes: e.bytes || undefined, ms: e.ms ?? undefined,
      failed: e.failed || undefined,
    })),
  };
  if (clear) networkLog.clear();
  return out;
}

/** True when the page has nothing in flight — the honest definition of idle. */
export function inflight() {
  let n = 0;
  for (const e of networkLog.values()) {
    if (e.status == null && e.failed == null) n++;
  }
  return n;
}

/** True when a client is instrumented; used by tools to say why a buffer is empty. */
export const isAttached = (cdp) => attached.has(cdp);

export function resetTelemetry() {
  consoleLog.length = 0;
  networkLog.clear();
  startedAt = Date.now();
}

export const telemetryStats = () => ({
  console: consoleLog.length,
  requests: networkLog.size,
  since: startedAt,
  ...(lastError ? { error: lastError } : {}),
});
