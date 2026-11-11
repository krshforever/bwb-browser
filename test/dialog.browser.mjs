/**
 * Dialogs, against a real browser.
 *
 * A dialog that nobody answers blocks the renderer: every later evaluate fails
 * with "Page has a JavaScript dialog open". That is the failure these checks
 * exist to prevent.
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
if (!BROWSER) console.log("# no Chrome/Chromium found — skipping the dialog checks");

const PAGE = `<!doctype html><html><head><title>Dialogs</title></head><body>
<button id="alert" onclick="alert('just so you know')">Alert</button>
<button id="confirm" onclick="document.title = 'answer:' + confirm('really?')">Confirm</button>
<button id="prompt" onclick="document.title = 'typed:' + prompt('name?', 'default')">Prompt</button>
</body></html>`;

let server, client, base, profileDir;

async function boot() {
  profileDir = mkdtempSync(join(tmpdir(), "bwb-dlg-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.mjs", "--user-data-dir", profileDir],
    cwd: process.cwd(),
    env: { ...process.env, BWB_ALLOW_PRIVATE: "1" },
    stderr: "pipe",
  });
  client = new Client({ name: "bwb-dialog", version: "1.0.0" });
  await client.connect(transport);
}

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text || "").join("\n");
  try { return JSON.parse(text.split("\n[bwb resources]")[0]); } catch { return text; }
};

const title = async () => String(await call("browser_eval", { expression: "document.title" }));

function refFor(tree, needle) {
  const line = tree.split("\n").find((l) => l.includes(needle) && l.includes("[ref="));
  assert.ok(line, `no ref line for ${needle} in:\n${tree}`);
  return line.match(/\[ref=(e\d+)\]/)[1];
}

const tree = async () => {
  const out = await call("browser_snapshot", { interactiveOnly: true });
  return typeof out === "string" ? out : out.tree || JSON.stringify(out);
};

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
  await call("browser_waitFor", { selector: "#confirm", timeout: 15000 });
});

test.after(async () => {
  try { await client?.close(); } catch {}
  server?.closeAllConnections?.();
  server?.close();
  if (profileDir) { try { rmSync(profileDir, { recursive: true, force: true }); } catch {} }
});

suite("D1 no policy by default — dialogs belong to the page", async () => {
  const out = await call("browser_dialog", { action: "status" });
  assert.equal(out.mode, "off");
  assert.match(out.note || "", /No policy set/);
});

suite("D2 confirm is dismissed when the policy says dismiss", async () => {
  await call("browser_dialog", { action: "set", mode: "dismiss" });
  const ref = refFor(await tree(), "Confirm");
  await call("browser_click", { ref });
  await new Promise((r) => setTimeout(r, 400));
  assert.match(await title(), /answer:false/);
});

suite("D3 confirm is accepted when the policy says accept", async () => {
  await call("browser_dialog", { action: "set", mode: "accept" });
  const ref = refFor(await tree(), "Confirm");
  await call("browser_click", { ref });
  await new Promise((r) => setTimeout(r, 400));
  assert.match(await title(), /answer:true/);
});

suite("D4 prompt returns the text the policy supplied", async () => {
  await call("browser_dialog", { action: "set", mode: "accept", promptText: "Ada" });
  const ref = refFor(await tree(), "Prompt");
  await call("browser_click", { ref });
  await new Promise((r) => setTimeout(r, 400));
  assert.match(await title(), /typed:Ada/);
});

suite("D5 the last dialog is recorded, with what was done about it", async () => {
  const out = await call("browser_dialog", { action: "status" });
  assert.equal(out.last.type, "prompt");
  assert.equal(out.last.answered, "accept");
  assert.match(out.last.message, /name\?/);
});

suite("D6 an alert cannot block the page when a policy is active", async () => {
  await call("browser_dialog", { action: "set", mode: "accept" });
  const ref = refFor(await tree(), "Alert");
  await call("browser_click", { ref });
  await new Promise((r) => setTimeout(r, 400));
  // If the dialog were still open this evaluate would fail instead.
  const ok = await call("browser_eval", { expression: "1 + 1" });
  assert.match(JSON.stringify(ok), /2/);
});

suite("D7 answering when nothing is open says so, and says how to see the page", async () => {
  const r = await client.callTool({
    name: "browser_dialog",
    arguments: { action: "answer", accept: true },
  }).catch((e) => e);
  const text = r?.content?.map((c) => c.text || "").join("\n") || String(r);
  assert.match(text, /No dialog is open/, `got: ${text}`);
  assert.match(text, /browser_snapshot|browser_screenshot/);
});
