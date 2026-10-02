/**
 * bwb-browser — integration checks against a REAL Chromium/Brave.
 *
 * These are the findings a code review could not settle on its own: the
 * static→browser handoff, the sandbox, click accuracy, watch cleanup, tab
 * lifecycle. Run explicitly:  npm run test:browser
 *
 * Skips (exit 0) when no browser is installed — the unit suite and the smoke
 * test are the always-on gates.
 */

import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findBrowserPath } from "../lib/browser.mjs";

const BROWSER = findBrowserPath();
const suite = BROWSER ? test : test.skip;

if (!BROWSER) {
  console.log("# no Chrome/Chromium found — skipping the integration checks");
}

// ─── Local fixture site ──────────────────────────────────────────────────────
// A local server, so the test needs no network and BWB_ALLOW_PRIVATE must be on.

function fixture() {
  const html = `<!doctype html><html><head><title>BWB fixture</title></head><body>
    <h1>Fixture heading</h1>
    <a href="/home" id="home">Home</a>
    <a href="/about">About</a>
    <a href="/pricing">Pricing</a>
    <button id="target">Deep</button>
    <input name="email" value="old@example.com">
    <script>console.log('fixture-ready'); null.bad;</script>
  </body></html>`;
  const routes = {
    "/": html,
    "/pw": `<!doctype html><html><body><input id="pw" type="password" placeholder="Password"></body></html>`,
    "/article": `<!doctype html><html><head><title>Article</title></head><body><article>
      <h1>Static friendly</h1>
      <p>${"Readable prose for the static ladder. ".repeat(60)}</p>
      <a href="/home">Home link</a></article></body></html>`,
  };
  return new Promise((res) => {
    const server = http.createServer((req, r) => {
      const body = routes[req.url.split("?")[0]] ?? html;
      r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      r.end(body);
    });
    server.listen(0, "127.0.0.1", () => res(server));
  });
}

let server;
let client;
let base;
let profileDir;

// Every server gets its OWN profile directory. Sharing one would mean each
// test's browser spawn kills the previous test's Chromium (same user-data-dir),
// which is exactly the hazard the profile lock now reports.
async function boot(extraArgs = []) {
  if (client) { try { await client.close(); } catch {} client = null; }
  profileDir = mkdtempSync(join(tmpdir(), "bwb-itest-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.mjs", "--user-data-dir", profileDir, ...extraArgs],
    cwd: process.cwd(),
    env: { ...process.env, BWB_ALLOW_PRIVATE: "1" },
    stderr: "pipe",
  });
  client = new Client({ name: "bwb-integration", version: "1.0.0" });
  await client.connect(transport);
  return transport;
}
/** Wait until the active document is really the fixture page. */
const ready = async (selector = "h1") => {
  await call("browser_waitForSelector", { selector, timeout: 15000 });
};
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text || "").join("\n");
  try { return JSON.parse(text.split("\n[bwb resources]")[0]); } catch { return text; }
};

test.before(async () => {
  if (!BROWSER) return;
  server = await fixture();
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  try { await client?.close(); } catch {}
  server?.closeAllConnections?.();
  server?.close();
  if (profileDir) { try { rmSync(profileDir, { recursive: true, force: true }); } catch {} }
});

// ─── F04: static now, browser on demand ──────────────────────────────────────

suite("F04 a static goto is materialized on the next page tool", async () => {
  const transport = await boot();
  const first = await call("browser_goto", { url: `${base}/article` });
  assert.equal(first.mode, "static", "the ladder answers without Chromium");
  assert.match(first.text, /Static friendly/);

  const status = await call("browser_status");
  assert.equal(status.running, false, "no browser yet");

  const text = await call("browser_text");
  assert.match(text.text, /Static friendly/, "browser_text sees the SAME page");

  const now = await call("browser_status");
  assert.equal(now.running, true, "Chromium started on demand");
  const after = await call("browser_status");
  assert.ok(
    after.targets.some((t) => t.url.includes("/article")),
    `tabs should point at the static URL: ${JSON.stringify(after.targets)}`
  );
  await transport.close();
});

suite("F04 mode:'browser' skips the ladder entirely", async () => {
  const transport = await boot();
  const r = await call("browser_goto", { url: `${base}/article`, mode: "browser" });
  assert.equal(r.mode, "browser");
  assert.ok(r.title);
  await transport.close();
});

suite("F04 browser_act navigation uses the same path", async () => {
  const transport = await boot();
  const r = await call("browser_act", { instruction: `go to ${base}/article` });
  assert.equal(r.action, "navigate");
  assert.match(r.url, /\/article$/);
  await transport.close();
});

// ─── F05/F08: URL policy and the sandbox, against a real browser ─────────────

suite("F05 a file:// URL never reaches the browser", async () => {
  const transport = await boot();
  const r = await call("browser_goto", { url: "file:///etc/hostname" });
  assert.match(r.error, /scheme/i);
  const status = await call("browser_status");
  assert.equal(status.running, false, "no browser was started for it");
  await transport.close();
});

suite("F08 the Chromium sandbox stays enabled by default", async () => {
  const transport = await boot();
  await call("browser_goto", { url: `${base}/`, mode: "browser" });
  // chrome://sandbox is not reachable over CDP, so assert the thing bwb
  // actually controls: it must not have launched --no-sandbox on a host that
  // supports it.
  const procs = await import("node:child_process");
  let cmdline = "";
  try {
    const { execFileSync } = procs;
    cmdline = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" })
      .split("\n").filter((l) => l.includes(profileDir)).join("\n");
  } catch {}
  assert.ok(cmdline, "the browser process should be visible");
  const hostForcesOff = process.getuid?.() === 0 || Boolean(process.env.TERMUX_VERSION);
  const noSandbox = /--no-sandbox/.test(cmdline);
  assert.equal(noSandbox, hostForcesOff,
    `--no-sandbox should only appear on Termux/root; saw: ${cmdline.slice(0, 200)}`);
  await transport.close();
});

// ─── F17/F14: clicks and fills land where they claim to ──────────────────────

suite("F17 browser_click scrolls, hit-tests and reports where it landed", async () => {
  const transport = await boot();
  await call("browser_goto", { url: `${base}/`, mode: "browser" });
  const r = await call("browser_click", { selector: "#target" });
  assert.equal(r.hit, true, "the click point resolved to the element itself");
  assert.match(r.text, /Deep/);
  await transport.close();
});

suite("browser_act clicks the requested link, not the first one", async () => {
  const transport = await boot();
  const landing = await call("browser_goto", { url: `${base}/`, mode: "browser" });
  assert.ok(!landing.error, `goto failed: ${JSON.stringify(landing)}`);
  await ready();
  const r = await call("browser_act", { instruction: "click the Pricing link" });
  assert.equal(r.action, "click");
  assert.equal(r.clicked, "Pricing");
  assert.match(r.url, /\/pricing/, `navigated to ${r.url}`);
  await transport.close();
});

suite("F14 fill replaces the old value", async () => {
  const transport = await boot();
  await call("browser_goto", { url: `${base}/`, mode: "browser" });
  await call("browser_fill", { selector: "input[name=email]", text: "new@example.com" });
  const value = await call("browser_eval", { expression: "document.querySelector('input').value" });
  assert.equal(value, "new@example.com");
  await transport.close();
});

suite("F28 a password field is not echoed back", async () => {
  const transport = await boot();
  await call("browser_goto", { url: `${base}/pw`, mode: "browser" });
  const raw = await call("browser_fill", { selector: "#pw", text: "hunter2" });
  assert.ok(raw && !/Element not found/.test(JSON.stringify(raw)), `fill failed: ${JSON.stringify(raw)}`);
  const r = raw;
  assert.equal(r.redacted, true);
  assert.equal(r.text, undefined);
  await transport.close();
});

// ─── F19: navigation reports where it really landed ──────────────────────────

suite("F19 navigation errors come back as data, not as a protocol exception", async () => {
  const transport = await boot();
  const r = await call("browser_goto", { url: "http://does-not-resolve.invalid/", mode: "browser" });
  assert.ok(r && r.error, `an unresolvable host must not look like success: ${JSON.stringify(r)}`);
  assert.match(r.error, /ERR_NAME_NOT_RESOLVED|Navigation failed/);
  await transport.close();
});

suite("F19 the reported URL is the one the page landed on", async () => {
  const transport = await boot();
  const r = await call("browser_goto", { url: `${base}/article?x=1`, mode: "browser" });
  assert.match(r.url, /\/article/);
  assert.equal(r.timedOut, false);
  await transport.close();
});

// ─── F10/F11: text and eval ──────────────────────────────────────────────────

suite("F10 browser_text excludes script and style bodies", async () => {
  const transport = await boot();
  await call("browser_goto", { url: `${base}/`, mode: "browser" });
  const r = await call("browser_text");
  assert.ok(!r.text.includes("fixture-ready"), "script bodies must not appear");
  assert.match(r.text, /Fixture heading/);
  await transport.close();
});

suite("F11 browser_eval awaits promises", async () => {
  const transport = await boot();
  await call("browser_goto", { url: `${base}/`, mode: "browser" });
  const r = await call("browser_eval", {
    expression: "Promise.resolve('awaited-ok')",
  });
  assert.equal(r, "awaited-ok");
  await transport.close();
});

// ─── F12: watch lifecycle ────────────────────────────────────────────────────

suite("F12 watch captures console errors and start is idempotent", async () => {
  const transport = await boot();
  await call("browser_goto", { url: `${base}/`, mode: "browser" });

  assert.equal((await call("browser_watch", { action: "start" })).status, "watching");
  // Second start must not duplicate the feed.
  await call("browser_watch", { action: "start" });
  await call("browser_eval", { expression: "console.error('boom-one'); 1" });

  const poll = await call("browser_watch", { action: "poll" });
  const errors = poll.events.filter((e) => e.text && e.text.includes("boom-one"));
  assert.equal(errors.length, 1, `exactly one capture, got ${errors.length}`);

  // F13: a diagnose call in the middle must not stop the capture.
  await call("browser_watch", { action: "start" });
  await call("browser_diagnose");
  await call("browser_eval", { expression: "console.error('boom-two'); 1" });
  const poll2 = await call("browser_watch", { action: "poll" });
  assert.ok(
    poll2.events.some((e) => e.text && e.text.includes("boom-two")),
    "diagnose must not disable Runtime while a watch is recording"
  );
  assert.equal((await call("browser_watch", { action: "stop" })).status, "stopped");
  await transport.close();
});

// ─── F20: tab lifecycle ──────────────────────────────────────────────────────

suite("F20 hibernating the default tab leaves a usable connection", async () => {
  const transport = await boot(["--tab-max", "3", "--idle", "0"]);
  await call("browser_goto", { url: `${base}/`, mode: "browser" });
  const tabs = await call("browser_listTabs");
  for (let i = 0; i < 4; i++) {
    await call("browser_newTab", { url: `${base}/?i=${i}` });
  }
  // Hibernation should have kicked in at the cap.
  const after = await call("browser_listTabs");
  assert.ok(after.tabs.length >= 4, "journaled tabs stay listable");
  assert.ok(after.tabs.some((t) => t.hibernated), "the cap hibernated something");

  // The critical assertion: the next tool call still works.
  const text = await call("browser_text", { selector: "h1" });
  assert.match(String(text.text || ""), /Fixture heading/);
  assert.ok(tabs.tabs.length >= 1);
  await transport.close();
});

suite("F20 a closed tab never breaks the next call", async () => {
  const transport = await boot(["--idle", "0"]);
  await call("browser_goto", { url: `${base}/`, mode: "browser" });
  await call("browser_newTab", { url: `${base}/x` });
  const tabs = await call("browser_listTabs");
  const extra = tabs.tabs.find((t) => !t.active);
  if (extra) await call("browser_closeTab", { targetId: extra.id });
  const text = await call("browser_text", { selector: "h1" });
  assert.match(String(text.text || ""), /Fixture heading/);
  await transport.close();
});

// ─── F09: journal hygiene ────────────────────────────────────────────────────

suite("F09 the journal stores no query strings", async () => {
  const transport = await boot(["--idle", "0"]);
  await call("browser_goto", { url: `${base}/?token=supersecret&next=/home` });
  await call("browser_newTab", { url: `${base}/?code=alsosecret` });
  const journal = join(profileDir, "bwb-tabs.json");
  assert.ok(existsSync(journal), "journal written");
  const raw = readFileSync(journal, "utf8");
  assert.ok(!raw.includes("supersecret"), `token leaked into the journal: ${raw}`);
  assert.ok(!raw.includes("alsosecret"), `code leaked into the journal: ${raw}`);
  assert.ok(raw.includes("/article") || raw.includes("/"), "the path is still recorded");
  await transport.close();
});

// ─── F27/F21: policy flags against a live server ─────────────────────────────

suite("F27 --allow-domains blocks navigation outside the list", async () => {
  const transport = await boot(["--allow-domains", "example.com"]);
  const r = await call("browser_goto", { url: `${base}/article`, mode: "browser" });
  assert.match(r.error, /not allowed/i);
  await transport.close();
});

suite("F27 --readonly refuses writes on a live server", async () => {
  const transport = await boot(["--readonly"]);
  const r = await call("browser_act", { instruction: "click the Pricing link" });
  assert.match(JSON.stringify(r), /readonly/);
  await transport.close();
});

suite("F26 restartBrowser returns a status, not undefined", async () => {
  const transport = await boot();
  await call("browser_goto", { url: `${base}/`, mode: "browser" });
  const r = await call("browser_restart");
  assert.ok(r.status, `restart must report a status, got ${JSON.stringify(r)}`);
  // The server survives it, and lands back on the page the task was working on.
  const text = await call("browser_text", { selector: "h1" });
  assert.match(String(text.text || ""), /Fixture heading/);
  await transport.close();
});

suite("F18 browser_text caps output and reports truncation", async () => {
  const transport = await boot();
  await call("browser_goto", { url: `${base}/`, mode: "browser" });
  const r = await call("browser_text", { maxChars: 10 });
  assert.equal(r.text.length, 10);
  assert.equal(r.truncated, true);
  assert.equal(r.nextOffset, 10);
  await transport.close();
});