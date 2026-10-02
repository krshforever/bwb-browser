import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { staticFetch, capText } from "../lib/fetch.mjs";

// The test server lives on 127.0.0.1, which the URL policy blocks by default.
const OPTS = { allowPrivate: true };

const hindi = "भारत एक विशाल देश है। ".repeat(120);
const page = (b) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>टेस्ट</title></head>` +
  `<body><article><h1>शीर्षक</h1><p>${b}</p></article></body></html>`;

function serve(handler) {
  return new Promise((res) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => res(s));
  });
}
const base = (s) => `http://127.0.0.1:${s.address().port}`;

// ─── F03: multibyte text must survive arbitrary chunk boundaries ─────────────

test("F03 multibyte text survives arbitrary chunking", async () => {
  const s = await serve((req, res) => {
    const buf = Buffer.from(page(hindi));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    let i = 0;
    const t = setInterval(() => {
      if (i >= buf.length) { clearInterval(t); return res.end(); }
      res.write(buf.subarray(i, (i += 7)));
    }, 0);
  });
  const r = await staticFetch(base(s) + "/", OPTS);
  s.close();
  assert.equal(r.mode, "static");
  assert.equal((r.text.match(/�/g) || []).length, 0, "no replacement characters");
  assert.ok(r.text.includes("भारत"));
});

test("F03 latin-1 declared charset is honoured", async () => {
  const body = Buffer.concat([
    Buffer.from("<html><head><title>x</title></head><body><article><p>", "utf8"),
    Buffer.from("café crème ".repeat(80), "latin1"),
    Buffer.from("</p></article></body></html>", "utf8"),
  ]);
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=iso-8859-1" });
    res.end(body);
  });
  const r = await staticFetch(base(s) + "/", OPTS);
  s.close();
  assert.equal((r.text.match(/�/g) || []).length, 0);
  assert.ok(r.text.toLowerCase().includes("caf"));
});

// ─── F18: the ladder must not spawn a browser for plain data ────────────────

test("F18 JSON is served statically", async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  const r = await staticFetch(base(s) + "/j", OPTS);
  s.close();
  assert.equal(r.mode, "static");
  assert.equal(r.text, '{"ok":true}');
});

test("F18 a 31-byte robots.txt is served statically", async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("User-agent: *\nDisallow: /admin");
  });
  const r = await staticFetch(base(s) + "/r", OPTS);
  s.close();
  assert.equal(r.mode, "static");
  assert.ok(r.text.includes("Disallow"));
});

test("F18 XML and CSV are served statically", async () => {
  const s = await serve((req, res) => {
    if (req.url === "/feed") {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end("<rss><channel><title>t</title></channel></rss>");
    } else {
      res.writeHead(200, { "content-type": "text/csv" });
      res.end("a,b\n1,2\n");
    }
  });
  assert.equal((await staticFetch(base(s) + "/feed", OPTS)).mode, "static");
  assert.equal((await staticFetch(base(s) + "/t.csv", OPTS)).mode, "static");
  s.close();
});

test("F18 a binary type still escalates", async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  const r = await staticFetch(base(s) + "/i.png", OPTS);
  s.close();
  assert.equal(r.mode, "escalate");
});

test("F18 a slow body respects the timeout", async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<html>");
    const t = setInterval(() => res.write("x"), 200);
    t.unref?.();
  });
  const t0 = Date.now();
  const r = await Promise.race([
    staticFetch(base(s) + "/", { ...OPTS, timeout: 1500 }),
    new Promise((r) => setTimeout(() => r("HUNG"), 6000)),
  ]);
  s.closeAllConnections?.();
  s.close();
  assert.notEqual(r, "HUNG", "the abort timer must cover the body, not just the headers");
  assert.ok(Date.now() - t0 < 5000);
});

// ─── F18: context budget ─────────────────────────────────────────────────────

test("F18 text is capped and reports how to continue", async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page("lorem ipsum dolor sit amet ".repeat(2000)));
  });
  const r = await staticFetch(base(s) + "/", { ...OPTS, maxChars: 500 });
  s.close();
  assert.equal(r.mode, "static");
  assert.ok(r.text.length <= 500);
  assert.equal(r.truncated, true);
  assert.equal(r.nextOffset, 500);
});

test("capText is a no-op below the cap", () => {
  assert.deepEqual(capText("hello", 10), { text: "hello", truncated: false });
});

test("F18 links are returned so the agent can navigate without a browser", async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body><article><p>${"word ".repeat(300)}</p>
      <a href="/one">One</a><a href="/two">Two</a></article></body></html>`);
  });
  const r = await staticFetch(base(s) + "/", OPTS);
  s.close();
  assert.ok(Array.isArray(r.links));
  assert.ok(r.links.some((l) => l.href.includes("/one")));
});

// ─── F05: URL policy ─────────────────────────────────────────────────────────

test("F05 file: URLs are refused outright", async () => {
  const r = await staticFetch("file:///etc/passwd");
  assert.equal(r.mode, "error");
  assert.match(r.error, /scheme/i);
});

test("F05 javascript: URLs are refused", async () => {
  const r = await staticFetch("javascript:alert(1)");
  assert.equal(r.mode, "error");
});

test("F05 private and loopback addresses are refused by default", async () => {
  for (const url of [
    "http://127.0.0.1:8080/secret",
    "http://localhost:3000/",
    "http://10.0.0.5/",
    "http://192.168.1.10/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]:8080/",
  ]) {
    const r = await staticFetch(url);
    assert.equal(r.mode, "error", `${url} must be refused`);
    assert.match(r.error, /private|loopback/i);
  }
});

test("F05 BWB_ALLOW_PRIVATE is opt-in, not silent", async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("local dev server");
  });
  const r = await staticFetch(base(s) + "/", { allowPrivate: true });
  s.close();
  assert.equal(r.mode, "static");
});

test("F05 a redirect to a private address is refused", async () => {
  const s = await serve((req, res) => {
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
    res.end();
  });
  // Only the loopback test server is allowed; the redirect target is not.
  const r = await staticFetch(base(s) + "/", { allowPrivate: ["127.0.0.1", "localhost"] });
  s.close();
  assert.equal(r.mode, "error");
  assert.match(r.error, /private|loopback/i);
});

test("F18 a 404 is an error, not a browser launch", async () => {
  const s = await serve((req, res) => {
    res.writeHead(404, { "content-type": "text/html" });
    res.end("nope");
  });
  const r = await staticFetch(base(s) + "/missing", OPTS);
  s.close();
  assert.equal(r.mode, "error");
  assert.match(r.error, /404/);
});

test("F18 a JS shell still escalates", async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<html><body><div id="root"></div><script>window.x=1</script></body></html>');
  });
  const r = await staticFetch(base(s) + "/app", OPTS);
  s.close();
  assert.equal(r.mode, "escalate");
});

test("raw:true skips Readability", async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page("hello world"));
  });
  const r = await staticFetch(base(s) + "/", { ...OPTS, raw: true });
  s.close();
  assert.equal(r.mode, "static");
  assert.ok(r.text.includes("<h1>"));
});