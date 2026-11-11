/**
 * Page data, storage, frames and upload — against a real browser.
 *
 * The rule these tests defend: names and shapes come back, values do not.
 * A cookie's value is a credential, and a model's context is not a safe place
 * for one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findBrowserPath } from "../lib/browser.mjs";

const BROWSER = findBrowserPath();
const suite = BROWSER ? test : test.skip;
if (!BROWSER) console.log("# no Chrome/Chromium found — skipping the extraction checks");

const FRAME = `<!doctype html><html><body><h1>Inside the frame</h1>
<button onclick="document.title='frame-clicked'">Frame button</button></body></html>`;

const PAGE = `<!doctype html><html lang="en"><head><title>Structures</title>
<meta name="description" content="A page about structures">
<meta name="og:title" content="Structures OG">
<script type="application/ld+json">{"@type":"Product","name":"Widget","price":"9.99"}</script>
</head><body>
<main>
  <h1>Structures</h1>
  <h2>Links</h2>
  <a href="/one">First link</a>
  <a href="https://example.com/two">Second link</a>
  <table>
    <caption>Prices</caption>
    <thead><tr><th>Item</th><th>Cost</th></tr></thead>
    <tbody><tr><td>Widget</td><td>9.99</td></tr><tr><td>Gadget</td><td>19.99</td></tr></tbody>
  </table>
  <form action="/submit" method="post">
    <label for="who">Name</label>
    <input id="who" name="who" required>
    <label for="note">Note</label>
    <textarea id="note" name="note"></textarea>
    <select name="size"><option>Small</option><option>Large</option></select>
    <input type="file" id="file" name="file">
    <button type="submit">Send</button>
  </form>
  <iframe src="/frame" title="Embedded"></iframe>
</main>
<script>
  localStorage.setItem('token', 'super-secret-value');
  localStorage.setItem('theme', 'dark');
  sessionStorage.setItem('cart', '3');
  document.cookie = 'sid=abc123; path=/';
</script>
</body></html>`;

let server, client, base, profileDir, tmpFile;

async function boot() {
  profileDir = mkdtempSync(join(tmpdir(), "bwb-ext-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.mjs", "--user-data-dir", profileDir],
    cwd: process.cwd(),
    env: { ...process.env, BWB_ALLOW_PRIVATE: "1" },
    stderr: "pipe",
  });
  client = new Client({ name: "bwb-extract", version: "1.0.0" });
  await client.connect(transport);
}

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text || "").join("\n");
  try { return JSON.parse(text.split("\n[bwb resources]")[0]); } catch { return text; }
};

test.before(async () => {
  if (!BROWSER) return;
  server = createServer((req, res) => {
    if (req.url === "/frame") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(FRAME);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  tmpFile = join(profileDir || tmpdir(), "upload.txt");
  await boot();
  writeFileSync(tmpFile, "hello from bwb\n");
  await call("browser_goto", { url: base, mode: "browser" });
  await call("browser_waitFor", { selector: "main", timeout: 15000 });
});

test.after(async () => {
  try { await client?.close(); } catch {}
  server?.closeAllConnections?.();
  server?.close();
  if (profileDir) { try { rmSync(profileDir, { recursive: true, force: true }); } catch {} }
});

suite("E1 links come back with text and absolute href", async () => {
  const out = await call("browser_extract", { kind: "links", selector: "main" });
  assert.equal(out.kind, "links");
  assert.ok(out.count >= 2);
  const first = out.items.find((i) => i.text === "First link");
  assert.equal(first.href, `${base}/one`);
  assert.equal(first.external, false);
  assert.equal(out.items.find((i) => i.text === "Second link").external, true);
});

suite("E2 tables come back with headers and rows, not as text", async () => {
  const out = await call("browser_extract", { kind: "tables" });
  assert.equal(out.count, 1);
  const t = out.tables[0];
  assert.deepEqual(t.headers, ["Item", "Cost"]);
  assert.deepEqual(t.rows, [["Widget", "9.99"], ["Gadget", "19.99"]]);
  assert.equal(t.caption, "Prices");
});

suite("E3 forms come back with field types, labels and required flags", async () => {
  const out = await call("browser_extract", { kind: "forms" });
  const f = out.forms[0];
  assert.equal(f.method, "post");
  const who = f.fields.find((x) => x.name === "who");
  assert.equal(who.label, "Name");
  assert.equal(who.required, true);
  assert.equal(f.fields.find((x) => x.name === "note").type, "textarea");
  assert.deepEqual(f.fields.find((x) => x.name === "size").options, ["Small", "Large"]);
  assert.equal(f.fields.find((x) => x.name === "file").type, "file");
});

suite("E4 structured data carries JSON-LD, meta and the heading outline", async () => {
  const out = await call("browser_extract", { kind: "structured" });
  assert.equal(out.title, "Structures");
  assert.equal(out.lang, "en");
  assert.match(JSON.stringify(out.jsonLd), /"Widget"/);
  assert.equal(out.meta.description, "A page about structures");
  assert.deepEqual(out.headings.slice(0, 2), [
    { level: 1, text: "Structures" },
    { level: 2, text: "Links" },
  ]);
});

suite("E5 storage lists keys and sizes but never a value", async () => {
  const out = await call("browser_storage", { target: "local", action: "get" });
  const dump = JSON.stringify(out);
  assert.match(dump, /token/);
  assert.doesNotMatch(dump, /super-secret-value/, "a stored token must not enter context");
  assert.ok(out.sizes > 0);

  const one = await call("browser_storage", { target: "local", action: "get-value", key: "theme" });
  assert.equal(one.value, "dark", "an explicit single-key read is allowed");

  await call("browser_storage", { target: "session", action: "set", key: "coupon", value: "FREE10" });
  const s = await call("browser_storage", { target: "session", action: "get" });
  assert.match(JSON.stringify(s.keys), /coupon/);
  await call("browser_storage", { target: "session", action: "remove", key: "coupon" });
  const s2 = await call("browser_storage", { target: "session", action: "get" });
  assert.doesNotMatch(JSON.stringify(s2.keys), /coupon/);
});

suite("E6 cookies list names and flags, never values", async () => {
  const out = await call("browser_storage", { target: "cookies", action: "get" });
  const dump = JSON.stringify(out);
  assert.match(dump, /sid/);
  assert.doesNotMatch(dump, /abc123/, "a cookie value is a credential");

  await call("browser_storage", { target: "cookies", action: "set", key: "added", value: "xyz" });
  const after = await call("browser_storage", { target: "cookies", action: "get" });
  assert.match(JSON.stringify(after.cookies.map((c) => c.name)), /added/);
  assert.doesNotMatch(JSON.stringify(after), /xyz/);
});

suite("E7 frames are listed with ids, and a frame snapshot reads inside", async () => {
  const out = await call("browser_frames");
  assert.ok(out.count >= 2, `expected the main frame and the iframe, got ${out.count}`);
  const child = out.frames.find((f) => !f.main && /frame/.test(f.url));
  assert.ok(child?.id, "the iframe has an id");

  const snap = await call("browser_snapshot", { frameId: child.id });
  const tree = typeof snap === "string" ? snap : snap.tree || JSON.stringify(snap);
  assert.match(tree, /Inside the frame/);
  assert.match(tree, /Frame button/);
});

suite("E8 upload puts a real file into the input", async () => {
  const snap = await call("browser_snapshot", { interactiveOnly: true });
  const tree = typeof snap === "string" ? snap : snap.tree || JSON.stringify(snap);
  // The input has no accessible name; address it by selector instead.
  const out = await call("browser_upload", { ref: "#file", files: [tmpFile] });
  assert.equal(out.accepted, 1, `upload result: ${JSON.stringify(out)}`);
  assert.deepEqual(out.files, ["upload.txt"]);
  const value = await call("browser_eval", {
    expression: "document.querySelector('#file').files[0].name",
  });
  assert.match(JSON.stringify(value), /upload\.txt/);
});

suite("E9 a non-file input is refused with the reason", async () => {
  const r = await client.callTool({
    name: "browser_upload",
    arguments: { ref: "#who", files: [tmpFile] },
  }).catch((e) => e);
  const text = r?.content?.map((c) => c.text || "").join("\n") || String(r);
  assert.match(text, /not a file input/, `got: ${text}`);
});
