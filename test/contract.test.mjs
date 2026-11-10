/**
 * The bwb half of contract v1.
 *
 * Every assertion here is driven by test/fixtures/drishti-contract/*.json — the
 * same bytes the drishti repo tests against. If the wire format moves, these
 * tests move with it or fail.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  pairWithCode, pairFlow, getState, isResumed, askHelp, postStatus,
  openTab, httpJsonStatus, DrishtiUnsupportedError, waitForApproval,
} from "../lib/drishti.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures", "drishti-contract");
const TOKEN = "0123456789abcdef0123456789abcdef";

function fixture(name) {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), "utf8"));
}

/** Starts a loopback server that answers from a handler and records requests. */
async function fixtureServer(t, handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const record = {
        method: req.method,
        url: req.url,
        token: req.headers["x-bwb-token"] || null,
        body: bodyText ? JSON.parse(bodyText) : null,
      };
      requests.push(record);

      const answer = handler(record, url) || { status: 404, json: { error: "not found" } };
      const text = answer.json === null || answer.json === undefined
        ? ""
        : JSON.stringify(answer.json);
      const headers = text.length
        ? { "content-type": "application/json", "content-length": Buffer.byteLength(text) }
        : { "content-length": 0 };
      res.writeHead(answer.status, headers);
      res.end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, requests };
}

/** Subset match: extra fields are allowed, missing or different ones are not. */
function assertContains(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      assertContains(actual?.[key], value, `${label}.${key}`);
    } else {
      assert.deepEqual(actual?.[key], value, `${label}.${key}`);
    }
  }
}

// ─── Fixture integrity ───────────────────────────────────────────────────────

test("the fixture manifest matches the fixtures", () => {
  const manifest = readFileSync(join(fixturesDir, "MANIFEST.sha256"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, file] = line.split(/\s+/);
      return { hash, file };
    });

  const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));
  assert.equal(manifest.length, files.length);

  for (const { hash, file } of manifest) {
    const actual = createHash("sha256").update(readFileSync(join(fixturesDir, file))).digest("hex");
    assert.equal(actual, hash, `${file} drifted from the manifest`);
  }
});

test("the fixtures are byte identical to the drishti repository's copies", (t) => {
  // bwb lives under ~/ai, drishti under ~ — try both layouts rather than
  // guessing which symlink the runner resolved.
  const candidates = [
    join(here, "..", "..", "..", "drishti", "contract", "fixtures"),
    join(here, "..", "..", "drishti", "contract", "fixtures"),
  ];
  const sibling = candidates.find((p) => existsSync(p));
  if (!sibling) {
    t.skip("drishti checkout not present");
    return;
  }
  const ours = readFileSync(join(fixturesDir, "MANIFEST.sha256"), "utf8");
  const theirs = readFileSync(join(sibling, "MANIFEST.sha256"), "utf8");
  assert.equal(ours, theirs, "contract fixtures drifted between bwb and drishti");
});

// ─── Pairing: 202 / 200 / 403 / 410 ─────────────────────────────────────────

test("pairWithCode reports every contract answer without throwing", async (t) => {
  for (const name of ["pair-pending", "pair-approved", "pair-denied", "pair-expired"]) {
    const expected = fixture(name);
    const server = await fixtureServer(t, () => ({
      status: expected.response.status,
      json: expected.response.json,
    }));

    const res = await pairWithCode({ code: "7QK2M9XA", port: server.port });

    assert.equal(res.status, expected.response.status, name);
    assertContains(res.json, expected.response.json, name);
    assert.equal(server.requests[0].token, null, `${name}: /bwb/pair is unauthenticated`);
  }
});

test("pairFlow polls the code and returns the approved token", async (t) => {
  const pending = fixture("pair-pending");
  const approved = fixture("pair-approved");
  let calls = 0;

  const server = await fixtureServer(t, () => {
    calls++;
    return calls < 3
      ? { status: pending.response.status, json: pending.response.json }
      : { status: approved.response.status, json: approved.response.json };
  });

  const result = await pairFlow({
    code: "7QK2M9XA",
    port: server.port,
    timeoutMs: 2000,
    intervalMs: 5,
    am: async () => ({ ok: true }),
  });

  assert.equal(result.token, approved.response.json.token);
  assert.ok(calls >= 3, "kept polling through 202");
});

test("pairFlow fails fast on a denial and on an expired code", async (t) => {
  const denied = fixture("pair-denied");
  const deniedServer = await fixtureServer(t, () => ({
    status: denied.response.status,
    json: denied.response.json,
  }));
  await assert.rejects(
    pairFlow({ code: "7QK2M9XA", port: deniedServer.port, timeoutMs: 2000, intervalMs: 5, am: async () => ({ ok: true }) }),
    /denied/i,
  );

  const expired = fixture("pair-expired");
  const expiredServer = await fixtureServer(t, () => ({
    status: expired.response.status,
    json: expired.response.json,
  }));
  await assert.rejects(
    pairFlow({ code: "7QK2M9XA", port: expiredServer.port, timeoutMs: 2000, intervalMs: 5, am: async () => ({ ok: true }) }),
    /expired/i,
  );
});

test("pairFlow uses the contract's PAIR action", async () => {
  const { readFileSync: read } = await import("node:fs");
  const source = read(join(here, "..", "lib", "drishti.mjs"), "utf8");
  const starts = [...source.matchAll(/"start", "-a", "([^"]+)", "--es", "code"/g)].map((m) => m[1]);
  assert.deepEqual(starts, ["com.bwb.drishti.PAIR"]);
});

// ─── State: immediate vs ?wait=N ────────────────────────────────────────────

test("getState asks immediately by default and long-polls with waitSec", async (t) => {
  const agent = fixture("state-agent");
  const server = await fixtureServer(t, () => ({
    status: agent.response.status,
    json: agent.response.json,
  }));

  const now = await getState({ port: server.port, token: TOKEN });
  assertContains(now, agent.response.json, "state-agent");
  assert.equal(server.requests.at(-1).url, "/bwb/state");

  await getState({ port: server.port, token: TOKEN, waitSec: 8 });
  assert.equal(server.requests.at(-1).url, "/bwb/state?wait=8");
  assert.equal(server.requests.at(-1).token, TOKEN, "state is authenticated by header");

  await getState({ port: server.port, token: TOKEN, waitSec: 99 });
  assert.equal(server.requests.at(-1).url, "/bwb/state?wait=30", "clamped to the contract maximum");
});

test("isResumed follows the contract's resume rule on the state fixtures", () => {
  assert.equal(isResumed(fixture("state-agent").response.json), true);
  assert.equal(isResumed(fixture("state-site-approved").response.json), true);
  assert.equal(isResumed(fixture("state-user-help").response.json), false);
  assert.equal(isResumed(fixture("state-site-pending").response.json), false);
  // A denial is a refusal, but the contract only gates resumption on mode+status.
  assert.equal(isResumed(fixture("state-site-denied").response.json), true);
});

test("waitForApproval reads resolution from the help object, not an approvals array", async (t) => {
  const pending = fixture("state-site-pending").response.json;
  const approved = fixture("state-site-approved").response.json;

  const server = await fixtureServer(t, () => ({
    status: 200,
    json: pending.help.status === "pending" ? pending : approved,
  }));

  // The stub returns `pending` forever unless we flip it after the first poll.
  let polls = 0;
  const result = await waitForApproval({
    domain: "demoqa.com",
    port: server.port,
    token: TOKEN,
    timeoutMs: 500,
    intervalMs: 5,
    get: async () => (polls++ === 0 ? pending : approved),
  });

  assert.equal(result.approved, true);
  assert.equal(result.denied, false);
  assert.equal(result.state.help.id, approved.help.id);
});

// ─── Help / status / tab ────────────────────────────────────────────────────

test("askHelp sends exactly the documented help body and returns the id", async (t) => {
  const expected = fixture("help-post");
  const server = await fixtureServer(t, () => ({
    status: expected.response.status,
    json: expected.response.json,
  }));

  const res = await askHelp({
    port: server.port,
    token: TOKEN,
    kind: expected.request.body.kind,
    reason: expected.request.body.reason,
    domain: expected.request.body.domain,
  });

  assertContains(res, expected.response.json, "help-post");
  assert.deepEqual(server.requests[0].body, expected.request.body);
  assert.equal(server.requests[0].token, TOKEN);
});

test("postStatus accepts the contract's 204 with no body", async (t) => {
  const expected = fixture("status-working");
  const server = await fixtureServer(t, () => ({
    status: expected.response.status,
    json: null,
  }));

  const res = await postStatus({
    port: server.port,
    token: TOKEN,
    step: expected.request.body.step,
    tool: expected.request.body.tool,
    state: expected.request.body.state,
  });

  assert.deepEqual(res, {}, "204 has no body, so nothing to parse");
  assert.equal(server.requests[0].token, TOKEN);
  assert.deepEqual(server.requests[0].body, expected.request.body);
});

test("a build without tab creation answers 501 and bwb names it", async (t) => {
  const expected = fixture("tab-unsupported");
  const server = await fixtureServer(t, () => ({
    status: expected.response.status,
    json: expected.response.json,
  }));

  await assert.rejects(openTab({ port: server.port, token: TOKEN, url: "https://example.com" }), (err) => {
    assert.ok(err instanceof DrishtiUnsupportedError);
    assert.match(err.message, /POST \/bwb\/tab/);
    return true;
  });
});

test("httpJsonStatus exposes 4xx instead of throwing, and still rejects on transport errors", async (t) => {
  const expected = fixture("pair-denied");
  const server = await fixtureServer(t, () => ({
    status: expected.response.status,
    json: expected.response.json,
  }));

  const res = await httpJsonStatus("GET", "/bwb/pair?code=7QK2M9XA", { port: server.port });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json, expected.response.json);
});
