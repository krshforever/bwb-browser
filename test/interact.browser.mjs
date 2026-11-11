/**
 * The rest of the interaction surface, against a real browser.
 *
 * Each check exists because the naive implementation passes a unit test and
 * fails a page: a synthetic .click() that never fires :hover, a .value write
 * that fires no change event, a keydown with the wrong `code` so the page's own
 * handler ignores it.
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
if (!BROWSER) console.log("# no Chrome/Chromium found — skipping the interaction checks");

const PAGE = `<!doctype html><html><head><title>Interactions</title>
<style>
  body { height: 3000px; font: 14px sans-serif; margin: 0; padding: 8px; }
  #menu { display: none; }
  .wrap:hover #menu { display: block; }
  #drop { width: 220px; height: 90px; border: 2px dashed #999; margin-top: 12px; }
  #pill { display: inline-block; width: 80px; height: 30px; background: #ccd; }
  #late { min-height: 20px; }
</style></head><body>
<div class="wrap">
  <button id="hoverbtn">Hover me</button>
  <div id="menu">Menu is open</div>
</div>

<select id="pick"><option value="a">Alpha</option><option value="b">Bravo</option><option value="c">Charlie</option></select>

<div id="keys"></div>
<input id="note">

<div><span id="pill">drag</span></div>
<div id="drop">drop here</div>

<button id="boom" onclick="console.error('boom happened'); fetch('/missing')">Boom</button>
<div id="late"></div>

<script>
  const keys = document.getElementById('keys');
  window.addEventListener('keydown', (e) => {
    keys.textContent += (e.ctrlKey ? 'ctrl+' : '') + (e.shiftKey ? 'shift+' : '') + e.key + '|';
  });

  const pick = document.getElementById('pick');
  window.selected = [];
  pick.addEventListener('change', () => { window.selected.push(pick.value); });

  const drop = document.getElementById('drop');
  window.dropped = 0;
  for (const type of ['mouseup', 'pointerup', 'drop', 'dragend']) {
    drop.addEventListener(type, () => { window.dropped++; });
  }

  setTimeout(() => { document.getElementById('late').textContent = 'arrived'; }, 400);
</script>
</body></html>`;

let server, client, base, profileDir;

async function boot() {
  profileDir = mkdtempSync(join(tmpdir(), "bwb-int-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.mjs", "--user-data-dir", profileDir],
    cwd: process.cwd(),
    env: { ...process.env, BWB_ALLOW_PRIVATE: "1" },
    stderr: "pipe",
  });
  client = new Client({ name: "bwb-interact", version: "1.0.0" });
  await client.connect(transport);
}

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text || "").join("\n");
  try { return JSON.parse(text.split("\n[bwb resources]")[0]); } catch { return text; }
};

const evalJs = async (expression) => {
  const r = await call("browser_eval", { expression });
  return typeof r === "string" ? r : r?.result ?? r;
};

const tree = async () => {
  const out = await call("browser_snapshot");
  return typeof out === "string" ? out : out.tree || JSON.stringify(out);
};

function refFor(text, needle) {
  const line = text.split("\n").find((l) => l.includes(needle) && l.includes("[ref="));
  assert.ok(line, `no ref line for ${needle} in:\n${text}`);
  return line.match(/\[ref=(e\d+)\]/)[1];
}

test.before(async () => {
  if (!BROWSER) return;
  server = createServer((req, res) => {
    if (req.url === "/missing") { res.writeHead(404); res.end("no"); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  await boot();
  await call("browser_goto", { url: base, mode: "browser" });
  await call("browser_waitFor", { selector: "#hoverbtn", timeout: 15000 });
});

test.after(async () => {
  try { await client?.close(); } catch {}
  server?.closeAllConnections?.();
  server?.close();
  if (profileDir) { try { rmSync(profileDir, { recursive: true, force: true }); } catch {} }
});

suite("I1 hover is a pointer move the page can see", async () => {
  const ref = refFor(await tree(), "Hover me");
  const res = await call("browser_hover", { ref });
  assert.equal(res.hovered, ref);
  assert.match(String(await evalJs("document.querySelector('#menu').innerText")), /Menu is open/);
  const shown = await evalJs("getComputedStyle(document.querySelector('#menu')).display");
  assert.match(JSON.stringify(shown), /block/, "the CSS :hover rule actually applied");
});

suite("I2 select chooses by label and fires change", async () => {
  const text = await tree();
  const selectLine = text.split("\n").find((l) => /- (combobox|listbox|popupbutton)/.test(l) && l.includes("[ref="));
  assert.ok(selectLine, `no select ref in:\n${text}`);
  const use = selectLine.match(/\[ref=(e\d+)\]/)[1];

  const res = await call("browser_select", { ref: use, values: ["Bravo"] });
  assert.deepEqual(res.values, ["b"]);
  assert.match(JSON.stringify(await evalJs("window.selected")), /b/, "change event reached the page");
});

suite("I3 a chord arrives as one chord, with the right code", async () => {
  await call("browser_press", { key: "Control+Shift+a" });
  const seen = String(await evalJs("document.getElementById('keys').textContent"));
  assert.match(seen, /ctrl\+shift\+A\|/, `page saw: ${seen}`);
});

suite("I4 wheel scroll moves the document", async () => {
  const before = Number(await evalJs("Math.round(window.scrollY)"));
  const res = await call("browser_scroll", { deltaY: 900 });
  assert.ok(res.y > before, `scrollY ${before} → ${res.y}`);
});

suite("I5 drag lands on the drop target", async () => {
  await call("browser_scroll", { toTop: true });
  // Plain divs carry no role, so they are not in the accessibility tree: this
  // is the escape hatch in action — a selector names what a ref cannot.
  const res = await call("browser_drag", { from: "#pill", to: "#drop", steps: 8 });
  assert.equal(res.onto, "#drop");
  const dropped = Number(await evalJs("window.dropped"));
  assert.ok(dropped > 0, "the drop target received the release");
});

suite("I6 console errors are recorded without being asked for first", async () => {
  const text = await tree();
  const boom = refFor(text, "Boom");
  await call("browser_click", { ref: boom });
  await new Promise((r) => setTimeout(r, 300));

  const out = await call("browser_console", { level: "error", limit: 20 });
  const dump = JSON.stringify(out);
  assert.match(dump, /boom happened/, `the page's own console.error is in the buffer — got ${dump}`);
});

suite("I7 a failed request is visible as a failure", async () => {
  await new Promise((r) => setTimeout(r, 300));
  const out = await call("browser_network", { filter: "http-error", limit: 50 });
  assert.ok(out.count >= 1, `at least one HTTP error recorded — got ${JSON.stringify(out)}`);
  assert.match(JSON.stringify(out), /\/missing/);
  assert.match(JSON.stringify(out), /404/);
});

suite("I8 waitFor returns on the condition, not on the clock", async () => {
  const started = Date.now();
  const res = await call("browser_waitFor", { text: "arrived", timeout: 5000 });
  assert.equal(res.matched, "text");
  assert.ok(Date.now() - started < 4000, "returned as soon as the text appeared");
});

suite("I9 waitFor times out with a reason that names what it saw", async () => {
  const r = await client.callTool({
    name: "browser_waitFor",
    arguments: { text: "never going to be here", timeout: 600 },
  }).catch((e) => e);
  const text = r?.content?.map((c) => c.text || "").join("\n") || String(r);
  assert.match(text, /Timed out/, `got: ${text}`);
  assert.match(text, /browser_snapshot/, "the error says how to recover");
});
