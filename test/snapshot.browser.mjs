/**
 * Snapshot + refs, against a real browser.
 *
 * The point of a ref is that acting on one cannot silently hit the wrong node:
 * either the node it was taken from is still there, or the call fails and says
 * to re-snapshot. These tests exist to keep that property, not the text format.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findBrowserPath } from "../lib/browser.mjs";

const BROWSER = findBrowserPath();
const suite = BROWSER ? test : test.skip;

if (!BROWSER) console.log("# no Chrome/Chromium found — skipping the snapshot checks");

const PAGE = `<!doctype html><html><head><title>Snapshot fixture</title></head><body>
<nav><a href="/one">One</a><a href="/two">Two</a></nav>
<main>
  <h1>Checkout</h1>
  <label for="email">Email</label>
  <input id="email" name="email" value="old@example.com">
  <label for="pw">Password</label>
  <input id="pw" type="password" value="hunter2">
  <button id="pay" onclick="document.title='PAID'">Pay now</button>
  <button id="ghost" style="position:absolute;left:-9999px">Hidden</button>
</main>
<div aria-hidden="true">decorative</div>
</body></html>`;

let server;
let client;
let base;
let profileDir;

async function boot() {
  profileDir = mkdtempSync(join(tmpdir(), "bwb-snap-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.mjs", "--user-data-dir", profileDir],
    cwd: process.cwd(),
    env: { ...process.env, BWB_ALLOW_PRIVATE: "1" },
    stderr: "pipe",
  });
  client = new Client({ name: "bwb-snapshot", version: "1.0.0" });
  await client.connect(transport);
}

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text || "").join("\n");
  try { return JSON.parse(text.split("\n[bwb resources]")[0]); } catch { return text; }
};

const snap = async (args = {}) => call("browser_snapshot", args);

/** Find the ref whose line mentions a name. */
function refFor(tree, needle) {
  const line = tree.split("\n").find((l) => l.includes(needle) && l.includes("[ref="));
  assert.ok(line, `no ref line for ${needle} in:\n${tree}`);
  return line.match(/\[ref=(e\d+)\]/)[1];
}

test.before(async () => {
  if (!BROWSER) return;
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  await boot();
  await call("browser_goto", { url: base, mode: "browser" });
  await call("browser_waitForSelector", { selector: "h1", timeout: 15000 });
});

test.after(async () => {
  try { await client?.close(); } catch {}
  server?.closeAllConnections?.();
  server?.close();
  if (profileDir) { try { rmSync(profileDir, { recursive: true, force: true }); } catch {} }
});

suite("S1 the tree names what a person sees, and refs only what they can act on", async () => {
  const out = await snap();
  const tree = typeof out === "string" ? out : out.text || JSON.stringify(out);
  assert.match(tree, /- heading "Checkout"/);
  assert.match(tree, /- button "Pay now" \[ref=e\d+\]/);
  assert.match(tree, /- link "One" \[ref=e\d+\]/);
  assert.match(tree, /- textbox "Email" \[ref=e\d+\]/, "a labelled input is a textbox");
  assert.match(tree, /- navigation/, "landmarks are structure, not refs");
  assert.doesNotMatch(tree, /decorative/, "aria-hidden content is not in the tree");
  // The heading is structure; it must never be given a ref.
  const headingLine = tree.split("\n").find((l) => l.includes("heading"));
  assert.doesNotMatch(headingLine, /\[ref=/);
});

suite("S2 typed values never enter the tree", async () => {
  const out = await snap();
  const tree = typeof out === "string" ? out : out.text || JSON.stringify(out);
  assert.doesNotMatch(tree, /hunter2/, "a password value must never be context");
  assert.doesNotMatch(tree, /old@example\.com/, "a prefilled email is not context either");
});

suite("S3 click by ref hits the node the ref was taken from", async () => {
  const out = await snap();
  const tree = typeof out === "string" ? out : out.text || JSON.stringify(out);
  const ref = refFor(tree, "Pay now");
  const res = await call("browser_click", { ref });
  assert.equal(res.clicked, ref);
  assert.equal(res.via, "mouse", "a real click, not element.click()");
  const title = await call("browser_eval", { expression: "document.title" });
  assert.match(JSON.stringify(title), /PAID/);
});

suite("S4 fill by ref replaces instead of appending", async () => {
  const out = await snap();
  const tree = typeof out === "string" ? out : out.text || JSON.stringify(out);
  const ref = refFor(tree, "Email");
  const res = await call("browser_fill", { ref, text: "new@example.com" });
  assert.equal(res.length, 15);
  assert.equal(res.redacted, undefined);
  const value = await call("browser_eval", { expression: "document.querySelector('#email').value" });
  assert.match(JSON.stringify(value), /new@example\.com/);
});

suite("S5 a ref from an older snapshot is refused, not guessed", async () => {
  await call("browser_goto", { url: `${base}/second`, mode: "browser" });
  await call("browser_waitForSelector", { selector: "h1", timeout: 15000 });
  const fresh = await snap();
  const tree = typeof fresh === "string" ? fresh : fresh.text || JSON.stringify(fresh);
  const ref = refFor(tree, "Pay now");

  await call("browser_goto", { url: `${base}/third`, mode: "browser" });
  await call("browser_waitForSelector", { selector: "h1", timeout: 15000 });
  const r = await client.callTool({ name: "browser_click", arguments: { ref } }).catch((e) => e);
  const text = r?.content?.map((c) => c.text || "").join("\n") || String(r);
  assert.match(text, /snapshot|stale|not usable|no longer/i,
    `a stale ref must name its reason, got: ${text}`);
});

suite("S6 interactiveOnly drops structure and keeps actions", async () => {
  const out = await snap({ interactiveOnly: true });
  const tree = typeof out === "string" ? out : out.text || JSON.stringify(out);
  assert.match(tree, /Pay now/);
  assert.doesNotMatch(tree, /heading/);
});
