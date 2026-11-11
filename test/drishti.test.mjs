/**
 * Drishti mode tests.
 *
 * A real HTTP server stands in for the app (plus a WebSocket endpoint for the
 * CDP handshake), so these exercise the same code paths the phone would:
 * token store, cdpOpts/alterPath, pairing, takeover pause, site approval,
 * step reporting, and auto-detection.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, statSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import ws from "ws";
import CDP from "chrome-remote-interface";

import { parseArgs, resolveConfig } from "../lib/config.mjs";
import {
  readStore, writeStore, removeStore, maskToken, storePath,
  cdpOpts, withToken, resolveContext, openTab, DrishtiUnsupportedError,
  detectDrishti, applyDrishtiDefaults,
  runDrishtiAware, waitForHandback, waitForApproval,
  cdpErrorInfo, domainFromBlockError, humanStep, createStepReporter,
  pairFlow, generatePairCode, DrishtiPausedError, DEFAULT_PORT,
  clientId, leaseTab, listDrishtiTabs, releaseTab, closeDrishtiTab, doctor,
} from "../lib/drishti.mjs";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TOKEN = "0123456789abcdef0123456789abcdef";

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "bwb-drishti-"));
  const path = join(dir, "drishti.json");
  const previous = process.env.BWB_DRISHTI_STORE;
  process.env.BWB_DRISHTI_STORE = path;
  t.after(() => {
    if (previous === undefined) delete process.env.BWB_DRISHTI_STORE;
    else process.env.BWB_DRISHTI_STORE = previous;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return { dir, path };
}

/**
 * Mock drishti: control API + /json/* + a CDP WebSocket.
 * `state` may be a function so a test can change the answer per poll.
 */
async function mockDrishti(t, {
  state = () => ({ mode: "AGENT", help: null }),
  pair = null,
  tab = null,
  tabs = null,
  lease = null,
  wsServer = false,
} = {}) {
  const requests = [];
  const helps = [];
  let approvals = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      token: req.headers["x-bwb-token"] || null,
      client: req.headers["x-bwb-client"] || null,
    });
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (code, body) => {
      const text = JSON.stringify(body);
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    if (url.pathname === "/bwb/hello") {
      return send(200, { app: "drishti", name: "Drishti", version: "1.0.0", contract: 1, paired: false });
    }
    if (url.pathname === "/bwb/pair") {
      // Contract v1: the endpoint never waits. `pair(code)` returns
      // {status, json} so a test can drive 202 -> 200 -> 410 for one code.
      const answer = pair ? pair(url.searchParams.get("code")) : { status: 202, json: { status: "pending" } };
      return send(answer.status ?? 202, answer.json ?? {});
    }
    if (url.pathname === "/bwb/state") return send(200, state(url.searchParams.get("wait")));
    if (url.pathname === "/bwb/tab") {
      if (!tab) return send(501, { error: "tab creation is not wired in this build" });
      return send(200, tab);
    }
    if (url.pathname === "/bwb/tabs") {
      if (tabs === "unsupported") return send(404, { error: "not found" });
      return send(200, tabs ?? { tabs: [], max: 12 });
    }
    if (url.pathname === "/bwb/tab/lease") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const answer = lease ? lease(parsed) : { status: 200, json: { tab: { id: parsed.tab }, lease_sec: 120 } };
        send(answer.status ?? 200, answer.json ?? {});
      });
      return;
    }
    if (url.pathname === "/bwb/help") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        helps.push(parsed);
        if (parsed.allow) approvals = parsed.allow;
        send(200, { id: "help_test" });
      });
      return;
    }
    if (url.pathname === "/json/version") return send(200, { Browser: "Chrome/mock", "Android-Package": "com.bwb.browser.debug" });
    if (url.pathname === "/json/list") {
      const port = server.address().port;
      return send(200, [{
        id: "PAGE1",
        type: "page",
        title: "mock page",
        url: "https://example.com/",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/PAGE1`,
      }]);
    }
    send(404, { error: "not found" });
  });

  // Upgrades never reach the request handler, so log them separately: this is
  // how the test proves the token stayed out of the WebSocket pathname.
  server.on("upgrade", (req) => requests.push({ method: "UPGRADE", url: req.url }));

  let wss = null;
  if (wsServer) {
    wss = new ws.Server({ server });
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.method === "Runtime.evaluate") {
          socket.send(JSON.stringify({ id: msg.id, result: { result: { type: "string", value: "mock-ok" } } }));
        }
      });
    });
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if (wss) await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
  });
  return { port: server.address().port, requests, helps, setApprovals: (a) => { approvals = a; } };
}

/** A CRI-shaped protocol error, the way drishti's synthetic frame arrives. */
function cdpError(code, message) {
  const err = new Error(message);
  err.response = { code, message };
  return err;
}

// ─── D1: config precedence ───────────────────────────────────────────────────

test("D1 --drishti and --no-drishti parse as booleans; last one wins", () => {
  assert.equal(parseArgs(["--drishti"]).drishti, true);
  assert.equal(parseArgs(["--no-drishti"]).drishti, false);
  assert.equal(parseArgs(["--drishti", "--no-drishti"]).drishti, false);
});

test("D1 precedence CLI > env > default (null means auto)", () => {
  assert.equal(resolveConfig({}, {}, {}).drishti, null);
  assert.equal(resolveConfig({}, { BWB_MODE: "drishti" }, {}).drishti, true);
  assert.equal(resolveConfig({}, { BWB_DRISHTI: "0" }, {}).drishti, false);
  assert.equal(resolveConfig({}, { BWB_DRISHTI: "1" }, {}).drishti, true);
  // CLI beats env in both directions.
  assert.equal(resolveConfig({ drishti: false }, { BWB_MODE: "drishti" }, {}).drishti, false);
  assert.equal(resolveConfig({ drishti: true }, { BWB_DRISHTI: "0" }, {}).drishti, true);
  assert.equal(resolveConfig({}, { BWB_DRISHTI_PORT: "9333" }, {}).drishtiPort, 9333);
});

test("D1 drishti defaults: attach only, always browser, no caps, no journal", (t) => {
  tempStore(t);
  process.env.BWB_DRISHTI_TOKEN = TOKEN;
  t.after(() => { delete process.env.BWB_DRISHTI_TOKEN; });

  const cfg = { attachPort: 0, alwaysBrowser: false, tabMax: 3, idleMs: 300000, lean: true, journalFull: true };
  applyDrishtiDefaults(cfg);
  assert.equal(cfg.drishti, true);
  assert.equal(cfg.attachPort, DEFAULT_PORT);
  assert.equal(cfg.alwaysBrowser, true);
  assert.equal(cfg.tabMax, 0);
  assert.equal(cfg.idleMs, 0);
  assert.equal(cfg.lean, false);
  assert.equal(cfg.journalFull, false);
});

test("D1 --drishti without a paired token fails with a fixable message", (t) => {
  tempStore(t);
  delete process.env.BWB_DRISHTI_TOKEN;
  assert.throws(() => applyDrishtiDefaults({ attachPort: 0 }), /bwb pair/);
});

// ─── D2: token store and CDP options ─────────────────────────────────────────

test("D2 the store is 0600 in a 0700 directory and round-trips", (t) => {
  const { path } = tempStore(t);
  writeStore({ token: TOKEN, port: 9222 }, process.env);
  const file = statSync(path);
  assert.equal(file.mode & 0o777, 0o600);
  const dirMode = statSync(path.replace(/\/[^/]+$/, "")).mode & 0o777;
  assert.equal(dirMode, 0o700);
  assert.equal(readStore().token, TOKEN);
  assert.equal(readStore().port, 9222);
  removeStore();
  assert.equal(readStore(), null);
  assert.equal(existsSync(path), false);
});

test("D2 maskToken never reveals the token", () => {
  const masked = maskToken(TOKEN);
  assert.notEqual(masked, TOKEN);
  assert.equal(masked.includes(TOKEN), false);
  assert.equal(maskToken(null), null);
});

test("D2 alterPath adds the token to /json* only — never to a WebSocket path", () => {
  assert.equal(withToken("/json/list", TOKEN), `/json/list?token=${TOKEN}`);
  assert.equal(withToken("/json/list?a=1", TOKEN), `/json/list?a=1&token=${TOKEN}`);
  assert.equal(withToken("/json/new?https://example.com", TOKEN), `/json/new?https://example.com&token=${TOKEN}`);
  // chrome-remote-interface passes the WS pathname through alterPath too.
  assert.equal(withToken("/devtools/page/PAGE1", TOKEN), "/devtools/page/PAGE1");
  assert.equal(withToken("/devtools/browser/abc", TOKEN), "/devtools/browser/abc");
  assert.equal(withToken("/bwb/hello", TOKEN), "/bwb/hello");
  // No token configured: a no-op, not a "?token=undefined".
  assert.equal(withToken("/json/list", null), "/json/list");
});

test("D2 cdpOpts carries the paired port and token", (t) => {
  tempStore(t);
  writeStore({ token: TOKEN, port: 9333 });
  const opts = cdpOpts();
  assert.equal(opts.port, 9333);
  assert.equal(opts.alterPath("/json/list"), `/json/list?token=${TOKEN}`);
  assert.equal(opts.alterPath("/devtools/page/PAGE1"), "/devtools/page/PAGE1");
});

test("D2 end-to-end: CRI attaches with the token on HTTP and leaves the WS path alone", async (t) => {
  tempStore(t);
  const mock = await mockDrishti(t, { wsServer: true });
  writeStore({ token: TOKEN, port: mock.port });

  const opts = cdpOpts();
  // Same options bwb now hands to every CDP call.
  const cdp = await CDP({ ...opts, local: true });
  t.after(() => { try { cdp.close(); } catch {} });

  const response = await cdp.Runtime.evaluate({ expression: "1" });
  assert.equal(response.result.value, "mock-ok");

  const list = mock.requests.find((r) => r.url.startsWith("/json/list"));
  assert.ok(list, "CRI fetched /json/list");
  assert.match(list.url, /token=/);

  const upgrade = mock.requests.find((r) => r.url.startsWith("/devtools/page/"));
  assert.ok(upgrade, "the WebSocket handshake was made");
  assert.equal(upgrade.url.includes("token="), false, "the WS pathname must not carry a token");
});

// ─── D1/D3: auto-detect and pairing ──────────────────────────────────────────

test("D3 auto-detect needs both a paired store and a hello that says drishti", async (t) => {
  tempStore(t);
  assert.equal((await detectDrishti()).enabled, false, "no store at all");

  const mock = await mockDrishti(t, {});
  writeStore({ token: TOKEN, port: mock.port });
  const detected = await detectDrishti({ timeoutMs: 1000 });
  assert.equal(detected.enabled, true);

  // A store pointing at nothing must not throw — auto mode cannot block startup.
  writeStore({ token: TOKEN, port: 1 });
  const dead = await detectDrishti({ timeoutMs: 300 });
  assert.equal(dead.enabled, false);
  assert.ok(dead.reason);
});

test("D3 pairFlow announces the code and stores the token it gets back", async (t) => {
  const { path } = tempStore(t);
  const mock = await mockDrishti(t, {
    pair: () => ({ status: 200, json: { status: "approved", token: TOKEN } }),
  });
  let announced = null;

  const result = await pairFlow({
    port: mock.port,
    timeoutMs: 2000,
    intervalMs: 20,
    am: async (code) => { announced = code; return { ok: true }; },
  });
  assert.equal(result.token, TOKEN);
  assert.match(announced, /^[0-9A-Z]{8}$/);
  assert.equal(result.code, announced);

  writeStore({ token: result.token, port: mock.port });
  const text = readFileSync(path, "utf8");
  assert.equal(text.includes(TOKEN), true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("D3 pairFlow times out with a fixable message", async (t) => {
  const mock = await mockDrishti(t, { pair: () => ({ status: 202, json: { status: "pending" } }) });
  await assert.rejects(
    pairFlow({ port: mock.port, timeoutMs: 120, intervalMs: 20, am: async () => ({ ok: false, error: "no activity" }) }),
    /Pairing timed out.*(approve|tap)/is,
  );
});

test("D3 pair codes are 8 Crockford chars and not repeated", () => {
  const a = generatePairCode();
  const b = generatePairCode();
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.notEqual(a, b);
});

// ─── D4: takeover and approval ───────────────────────────────────────────────

test("D4 the exact USER-mode errors are classified", () => {
  const takeover = cdpError(-32000, "Action rejected: User has taken control of the browser (USER mode active).");
  assert.equal(cdpErrorInfo(takeover).kind, "user_takeover");
  const failClosed = cdpError(-32000, "Action rejected: In USER mode unparsed commands fail closed.");
  assert.equal(cdpErrorInfo(failClosed).kind, "user_takeover");
  const blocked = cdpError(-32001, "Domain permission denied: Navigation to 'https://demoqa.com/x' requires user approval in the app.");
  assert.equal(cdpErrorInfo(blocked).kind, "domain_blocked");
  assert.equal(domainFromBlockError(blocked.message), "demoqa.com");
  assert.equal(cdpErrorInfo(new Error("ordinary failure")).kind, null);
});

test("D4 takeover pauses, waits for hand-back, then resumes the same step", async (t) => {
  tempStore(t);
  const mock = await mockDrishti(t, {
    // first poll: still user; second: handed back
    state: (() => { let n = 0; return () => ({ mode: n++ === 0 ? "USER" : "AGENT", help: null }); })(),
  });
  writeStore({ token: TOKEN, port: mock.port });

  let attempts = 0;
  const out = await runDrishtiAware(async () => {
    attempts++;
    if (attempts === 1) throw cdpError(-32000, "Action rejected: User has taken control of the browser (USER mode active).");
    return "resumed";
  }, resolveContext(), { pollMs: 10, handbackTimeoutMs: 2000 });

  assert.equal(out, "resumed");
  assert.equal(attempts, 2);
  assert.ok(mock.requests.some((r) => r.url.startsWith("/bwb/state?wait=")), "long-polled instead of hot-looping");
});

test("D4 takeover that never hands back is a pause, not a hang or a crash", async (t) => {
  tempStore(t);
  const mock = await mockDrishti(t, {
    state: () => ({ mode: "USER", help: { id: "h1", kind: "help", reason: "Log in", status: "pending" } }),
  });
  writeStore({ token: TOKEN, port: mock.port });

  await assert.rejects(
    runDrishtiAware(async () => { throw cdpError(-32000, "Action rejected: User has taken control of the browser (USER mode active)."); },
      resolveContext(), { pollMs: 10, handbackTimeoutMs: 50 }),
    (err) => err instanceof DrishtiPausedError && err.drishti.kind === "user_takeover" && /Hand back/.test(err.message),
  );
});

test("D4 a blocked site asks the app, waits for approval, then retries once", async (t) => {
  tempStore(t);
  const mock = await mockDrishti(t, {
    state: () => ({
      mode: mock?.helps.length ? "AGENT" : "USER",
      help: mock?.helps.length
        ? { id: "h2", kind: "site", reason: "Approve blocked.example?", domain: "blocked.example", status: "resolved", approved: true }
        : { id: "h2", kind: "site", reason: "Approve blocked.example?", domain: "blocked.example", status: "pending" },
    }),
  });
  writeStore({ token: TOKEN, port: mock.port });

  let attempts = 0;
  const out = await runDrishtiAware(async () => {
    attempts++;
    if (attempts === 1) {
      throw cdpError(-32001, "Domain permission denied: Navigation to 'https://blocked.example/page' requires user approval in the app.");
    }
    return "loaded";
  }, resolveContext(), {
    pollMs: 10,
    approvalTimeoutMs: 2000,
    ask: async (request) => { mock.helps.push(request); },
  });

  assert.equal(out, "loaded");
  assert.equal(attempts, 2);
  assert.equal(mock.helps.length, 1);
  assert.equal(mock.helps[0].reason, "Approve blocked.example?");
  assert.equal(mock.helps[0].kind, "site");
  assert.equal(mock.helps[0].domain, "blocked.example");
});

test("D4 approval that never comes is a pause with the domain named", async (t) => {
  tempStore(t);
  const mock = await mockDrishti(t, {
    state: () => ({
      mode: "USER",
      help: { id: "h3", kind: "site", reason: "Approve blocked.example?", domain: "blocked.example", status: "pending" },
    }),
  });
  writeStore({ token: TOKEN, port: mock.port });

  await assert.rejects(
    runDrishtiAware(async () => {
      throw cdpError(-32001, "Domain permission denied: Navigation to 'https://blocked.example/' requires user approval in the app.");
    }, resolveContext(), {
      pollMs: 10,
      approvalTimeoutMs: 60,
      ask: async () => {},
    }),
    (err) => err instanceof DrishtiPausedError
      && err.drishti.kind === "domain_blocked"
      && /blocked\.example/.test(err.message),
  );
});

test("D4 unrelated errors pass straight through — no pause, no retry", async () => {
  let attempts = 0;
  await assert.rejects(
    runDrishtiAware(async () => { attempts++; throw new Error("selector not found"); }, resolveContext(), {}),
    /selector not found/,
  );
  assert.equal(attempts, 1);
});

test("D4 waitForHandback treats a flaky state endpoint as 'keep waiting'", async () => {
  let calls = 0;
  const result = await waitForHandback({
    timeoutMs: 500,
    intervalMs: 5,
    get: async () => {
      calls++;
      if (calls === 1) throw new Error("connection reset");
      return { mode: "AGENT", help: null };
    },
  });
  assert.equal(result.handedBack, true);
  assert.equal(calls, 2);
});

test("D4 waitForApproval resolves on a resolved help, and reports a denial", async () => {
  const help = (patch) => ({
    id: "h9", kind: "site", reason: "Approve blocked.example?", domain: "blocked.example", ...patch,
  });

  const approved = await waitForApproval({
    domain: "blocked.example",
    timeoutMs: 300,
    intervalMs: 5,
    get: (() => {
      let n = 0;
      return async () => ({
        mode: n++ === 0 ? "USER" : "AGENT",
        help: n === 1 ? help({ status: "pending" }) : help({ status: "resolved", approved: true }),
      });
    })(),
  });
  assert.equal(approved.approved, true);
  assert.equal(approved.denied, false);

  const denied = await waitForApproval({
    domain: "blocked.example",
    timeoutMs: 300,
    intervalMs: 5,
    get: async () => ({ mode: "AGENT", help: help({ status: "resolved", approved: false }) }),
  });
  assert.equal(denied.approved, false);
  assert.equal(denied.denied, true);
});

test("D5 silence is not consent: no help and no decision is a timeout, never an approval", async () => {
  const res = await waitForApproval({
    domain: "blocked.example",
    timeoutMs: 60,
    intervalMs: 5,
    get: async () => ({ mode: "AGENT", help: null }),
  });
  assert.equal(res.approved, false, "a clean AGENT state used to be read as approval");
  assert.equal(res.denied, false);
  assert.equal(res.timedOut, true);
});

test("D5 a denial survives the app clearing `help` — last_help is the record", async () => {
  // This is the exact shape after the human taps Deny: help goes null, mode
  // returns to AGENT, and only last_help remembers what happened.
  const res = await waitForApproval({
    domain: "blocked.example",
    timeoutMs: 300,
    intervalMs: 5,
    get: async () => ({
      mode: "AGENT",
      help: null,
      last_help: {
        id: "h10", kind: "site", reason: "Approve blocked.example?",
        domain: "blocked.example", status: "resolved", approved: false,
      },
    }),
  });
  assert.equal(res.approved, false);
  assert.equal(res.denied, true);
  assert.equal(res.timedOut, false);
});

test("D5 an approval also survives the clear, and is scoped to its domain", async () => {
  const lastFor = (domain) => ({
    id: "h11", kind: "site", reason: `Approve ${domain}?`,
    domain, status: "resolved", approved: true,
  });

  const mine = await waitForApproval({
    domain: "allowed.example",
    timeoutMs: 200,
    intervalMs: 5,
    get: async () => ({ mode: "AGENT", help: null, last_help: lastFor("allowed.example") }),
  });
  assert.equal(mine.approved, true);

  // A decision for a different site must not authorise this one.
  const other = await waitForApproval({
    domain: "blocked.example",
    timeoutMs: 60,
    intervalMs: 5,
    get: async () => ({ mode: "AGENT", help: null, last_help: lastFor("somewhere-else.example") }),
  });
  assert.equal(other.approved, false);
  assert.equal(other.timedOut, true);
});

test("D5 a failed help POST does not become permission to retry", async () => {
  let ran = 0;
  // The shape drishti uses for a blocked site: CDP error -32001.
  const err = Object.assign(new Error("domain permission denied"), { code: -32001 });
  await assert.rejects(
    () => runDrishtiAware(async () => { ran++; throw err; }, { port: 1, token: "t" }, {
      approvalTimeoutMs: 60,
      pollMs: 5,
      ask: async () => { throw new Error("app already raised its own dialog"); },
      get: async () => ({ mode: "USER", help: null }),
    }),
    (e) => e instanceof DrishtiPausedError,
  );
  assert.equal(ran, 1, "the step must not be retried without a decision");
});

test("D7 the doctor reports the tab registry, and names a v1 build honestly", async (t) => {
  tempStore(t);
  const mock = await mockDrishti(t, {
    tabs: {
      tabs: [
        { id: "aaaaaaaa-1", title: "One", url: "https://a.test", active: true, leased: true, owner: "bwb-a1b2c3", lease_expires_in_sec: 90 },
        { id: "bbbbbbbb-2", title: "Two", url: "https://b.test", active: false, leased: false, owner: null, lease_expires_in_sec: 0 },
      ],
      max: 12,
    },
  });
  writeStore({ token: TOKEN, port: mock.port });

  const report = await doctor({ ctx: { port: mock.port, token: TOKEN } });
  const leases = report.checks.find((c) => c.name === "leases");
  assert.ok(leases, "the doctor must check the registry");
  assert.equal(leases.ok, true);
  assert.match(leases.detail, /2\/12 tabs, 1 leased/);
  assert.match(leases.detail, /bwb-a1b2c3/, "a lease names its holder");
});

test("D7 the doctor says 'pre-v2 build' instead of failing silently", async (t) => {
  tempStore(t);
  const mock = await mockDrishti(t, { tabs: "unsupported" });
  writeStore({ token: TOKEN, port: mock.port });

  const report = await doctor({ ctx: { port: mock.port, token: TOKEN } });
  const leases = report.checks.find((c) => c.name === "leases");
  assert.equal(leases.ok, false);
  assert.match(leases.detail, /pre-contract v2/);
});

// ─── D8: target discovery (the app cannot answer with a target id) ───────────

test("D8 the tab bwb asked for is the target that appeared, and only that one", async () => {
  const { pickNewTarget } = await import("../lib/tabs.mjs");
  const before = [{ id: "A", type: "page", url: "https://a.test/" }];
  const after = [
    { id: "A", type: "page", url: "https://a.test/" },
    { id: "B", type: "page", url: "https://example.com/" },
  ];
  assert.equal(pickNewTarget(before, after, "https://example.com").id, "B");
});

test("D8 two tabs appearing at once are disambiguated by url, and never guessed", async () => {
  const { pickNewTarget } = await import("../lib/tabs.mjs");
  const before = [{ id: "A", type: "page", url: "https://a.test/" }];
  const after = [
    { id: "A", type: "page", url: "https://a.test/" },
    { id: "HUMAN", type: "page", url: "https://news.test/" },
    { id: "OURS", type: "page", url: "https://example.com/" },
  ];
  assert.equal(pickNewTarget(before, after, "https://example.com").id, "OURS");
  // Nothing to match on: refusing beats attaching to the human's tab.
  assert.equal(pickNewTarget(before, after, null), null);
  assert.equal(pickNewTarget(before, after, "https://elsewhere.test"), null);
});

test("D8 a create that produced no new target is reported, not attached to the wrong tab", async () => {
  const { pickNewTarget } = await import("../lib/tabs.mjs");
  const before = [{ id: "A", type: "page", url: "https://a.test/" }];
  assert.equal(pickNewTarget(before, before, "https://example.com"), null);
  // Non-page targets (workers, iframes) are not tabs.
  assert.equal(pickNewTarget([], [{ id: "W", type: "worker", url: "" }], "https://example.com"), null);
});

// ─── D5: step reporting ──────────────────────────────────────────────────────

test("D5 humanStep never includes the typed value or the script", () => {
  const step = humanStep("browser_fill", { selector: "#password", text: "hunter2" });
  assert.equal(step, "Typing in #password");
  assert.equal(step.includes("hunter2"), false);
  const evalStep = humanStep("browser_eval", { expression: "document.cookie" });
  assert.equal(evalStep.includes("cookie"), false);
  assert.equal(humanStep("browser_goto", { url: "https://demoqa.com/automation-practice-form" }), "Opening demoqa.com");
});

test("D5 the reporter debounces bursts and keeps the newest step", async () => {
  const posted = [];
  const reporter = createStepReporter({
    port: 1,
    token: TOKEN,
    minIntervalMs: 20,
    post: async (item) => { posted.push(item); },
  });
  reporter.report("Opening a.com", "browser_goto");
  reporter.report("Opening b.com", "browser_goto");
  reporter.report("Opening c.com", "browser_goto");
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(posted.length, 2, "one immediate + one coalesced");
  assert.equal(posted[0].step, "Opening a.com");
  assert.equal(posted[1].step, "Opening c.com");
});

test("D5 a dead status endpoint never throws", async () => {
  const reporter = createStepReporter({
    port: 1,
    token: TOKEN,
    minIntervalMs: 0,
    post: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.doesNotThrow(() => reporter.report("Opening a.com", "browser_goto"));
  await new Promise((r) => setTimeout(r, 20));
  reporter.stop();
});

// ─── store path sanity ───────────────────────────────────────────────────────

test("storePath defaults to ~/.config/bwb/drishti.json", () => {
  const fakeEnv = { ...process.env };
  delete fakeEnv.BWB_DRISHTI_STORE;
  assert.match(storePath(fakeEnv), /\.config\/bwb\/drishti\.json$/);
});

test("writeStore refuses a tokenless payload", () => {
  assert.throws(() => writeStore({ port: 9222 }, { ...process.env, BWB_DRISHTI_STORE: join(tmpdir(), "x", "y.json") }), /without a token/);
});

test("D6 POST /bwb/tab is the only tab creator, and its absence is named", async (t) => {
  tempStore(t);
  const mock = await mockDrishti(t, {});
  writeStore({ token: TOKEN, port: mock.port });

  // 404 today (WebView has no /json/new, the app has no /bwb/tab yet).
  await assert.rejects(openTab({ url: "https://example.com" }), (err) => {
    assert.ok(err instanceof DrishtiUnsupportedError);
    assert.match(err.message, /Part B|POST \/bwb\/tab/);
    return true;
  });
});

test("D6 a tab created by the app comes back with the target id, over an authenticated call", async (t) => {
  tempStore(t);
  const mock = await mockDrishti(t, { tab: { id: "NEWTAB", title: "", url: "https://example.com" } });
  writeStore({ token: TOKEN, port: mock.port });

  const info = await openTab({ url: "https://example.com" });
  assert.equal(info.id, "NEWTAB");

  const post = mock.requests.find((r) => r.url === "/bwb/tab");
  assert.ok(post, "POST /bwb/tab was made");
  assert.equal(post.method, "POST");
  assert.equal(post.token, TOKEN, "the token travels in a header, not the URL");
  assert.equal(post.url.includes(TOKEN), false, "the token never appears in the request line");
});

// ─── D7: tabs and leases (contract v2) ───────────────────────────────────────

test("D7 creating a tab carries this client's identity and reports the lease", async (t) => {
  tempStore(t);
  const mock = await mockDrishti(t, {
    tab: { tab: { id: "T1", title: "One", url: "https://example.com" }, leased: true },
  });
  writeStore({ token: TOKEN, port: mock.port });

  const info = await openTab({ url: "https://example.com" });
  assert.equal(info.tabId, "T1");
  assert.equal(info.leased, true);

  const post = mock.requests.find((r) => r.url === "/bwb/tab");
  assert.match(post.client, /^bwb-[0-9a-f]{6,}$/, "identity must travel as X-BWB-Client");
});

test("D7 the client id is stable across calls and survives a restart", async (t) => {
  tempStore(t);
  writeStore({ token: TOKEN, port: 1 });

  const first = clientId();
  assert.equal(clientId(), first, "same process, same identity");
  assert.equal(readStore()?.clientId, first, "persisted with the pairing, so a restart keeps its leases");
});

test("D7 a locked tab is a busy answer, not an exception", async (t) => {
  tempStore(t);
  const mock = await mockDrishti(t, {
    lease: () => ({ status: 409, json: { error: "tab_locked", held_by: "agent-a" } }),
  });
  writeStore({ token: TOKEN, port: mock.port });

  const res = await leaseTab({ tab: "T1" });
  assert.equal(res.leased, false);
  assert.equal(res.heldBy, "agent-a");
});

test("D7 a granted lease reports its deadline", async (t) => {
  tempStore(t);
  const mock = await mockDrishti(t, {
    lease: () => ({ status: 200, json: { tab: { id: "T1" }, lease_sec: 120 } }),
  });
  writeStore({ token: TOKEN, port: mock.port });

  const res = await leaseTab({ tab: "T1" });
  assert.equal(res.leased, true);
  assert.equal(res.leaseSec, 120);
  const sent = mock.requests.find((r) => r.url === "/bwb/tab/lease");
  assert.ok(sent.client, "a lease without an identity would be ungrantable");
});
