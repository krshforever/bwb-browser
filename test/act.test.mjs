import test from "node:test";
import assert from "node:assert/strict";
import { executeInstruction, normalizeUrl, redactIfSecret } from "../lib/act.mjs";
import { makeProtocol } from "./helpers/domProtocol.mjs";

// Tests do not need the human-facing settle delays after a click/navigation.
const act = (protocol, instruction, opts = {}) =>
  executeInstruction(protocol, instruction, { settleMs: 0, ...opts });

// ─── F01: captured text keeps its case ───────────────────────────────────────

test("F01 fill types the text exactly, including capitals and symbols", async () => {
  const { protocol, log } = makeProtocol('<input id="pw" type="password" placeholder="Password">');
  await act(protocol, "fill password with MyS3cretPass");
  assert.deepEqual(log.typed, ["MyS3cretPass"]);
});

test("F01 fill keeps spacing and punctuation", async () => {
  const { protocol, log } = makeProtocol('<input name="note" placeholder="Note">');
  await act(protocol, "fill note with Hello  World! $42 (ok)");
  assert.deepEqual(log.typed, ["Hello  World! $42 (ok)"]);
});

test("F01 go-to preserves URL path case", async () => {
  const { protocol, log } = makeProtocol("<body></body>");
  await act(protocol, "go to GitHub.com/Krish/Repo");
  assert.equal(log.navigated[0], "https://GitHub.com/Krish/Repo");
});

test("F01 'type X in Y' keeps the text's case", async () => {
  const { protocol, log } = makeProtocol('<input name="q" placeholder="Search">');
  await act(protocol, "type Cheap Flights in search");
  assert.deepEqual(log.typed, ["Cheap Flights"]);
});

test("F28 a secret is never echoed back", async () => {
  const { protocol } = makeProtocol('<input id="pw" type="password" placeholder="Password">');
  const r = await act(protocol, "fill password with MyS3cretPass");
  assert.equal(r.text, undefined);
  assert.equal(r.redacted, true);
  assert.equal(r.length, "MyS3cretPass".length);
});

test("redactIfSecret only redacts secret-looking targets", () => {
  assert.deepEqual(redactIfSecret("email", "a@b.c"), { text: "a@b.c", redacted: false });
  assert.deepEqual(redactIfSecret("password", "hunter2"), { length: 7, redacted: true });
});

// ─── F02: the located element is the element that gets clicked ───────────────

test("F02 click targets the right link among identically-shaped siblings", async () => {
  const { protocol, log, document } = makeProtocol(
    '<a href="/h">Home</a><a href="/a">About</a><a href="/p">Pricing</a>');
  const r = await act(protocol, "click the Pricing link");
  const pricing = [...document.querySelectorAll("a")].find((a) => a.textContent === "Pricing");
  const rect = pricing.getBoundingClientRect();
  assert.equal(r.action, "click");
  assert.equal(r.clicked, "Pricing");
  assert.equal(log.mouse[0].x, Math.round(rect.x + rect.width / 2));
  assert.equal(log.mouse[0].y, Math.round(rect.y + rect.height / 2));
});

test("F02 an element with no id/class is still clicked precisely", async () => {
  const { protocol, log, document } = makeProtocol(
    "<button>Save draft</button><button>Delete account</button>");
  await act(protocol, "click Save draft");
  const save = [...document.querySelectorAll("button")][0];
  const rect = save.getBoundingClientRect();
  assert.equal(log.mouse[0].y, Math.round(rect.y + rect.height / 2));
});

test("F02 data-testid buttons are found (a checkout button is destructive)", async () => {
  const { protocol } = makeProtocol('<button data-testid="checkout-btn">Checkout</button>');
  const guarded = await act(protocol, "click checkout");
  assert.equal(guarded.action, "needs_confirmation", "buy/checkout needs confirmation");
  const r = await act(protocol, "click checkout", { force: true });
  assert.equal(r.action, "click");
});

test("F02 a click reports where it actually landed", async () => {
  const { protocol } = makeProtocol('<a href="/p">Pricing</a>');
  const r = await act(protocol, "click Pricing");
  assert.equal(r.tag, "a");
  assert.equal(r.hit, undefined, "no warning when the element was hit-testable");
});

// ─── F14: search must not type into an unrelated field ───────────────────────

test("F14 search refuses to type into an unrelated input", async () => {
  const { protocol, log } = makeProtocol('<input id="newsletter" placeholder="Your email">');
  const r = await act(protocol, "search for cheap flights");
  assert.deepEqual(log.typed, []);
  assert.equal(r.action, "search_error");
  assert.ok(r.candidates.length, "the agent is told which inputs exist");
});

test("F14 search finds a real search box", async () => {
  const { protocol, log } = makeProtocol(
    '<input name="q" placeholder="Your email"><input type="search" placeholder="Search products">');
  const r = await act(protocol, "search for cheap flights");
  assert.equal(r.action, "search");
  assert.deepEqual(log.typed, ["cheap flights"]);
});

test("F14 search submits with Enter", async () => {
  const { protocol, log } = makeProtocol('<input type="search" placeholder="Search">');
  await act(protocol, "search for laptops");
  assert.ok(log.keys.includes("Enter"));
});

test("F14 fill clears the field instead of appending", async () => {
  const { protocol, document } = makeProtocol(
    '<input name="email" value="OLD@example.com">');
  await act(protocol, "fill email with new@example.com");
  const el = document.querySelector("input");
  // Existing content must be SELECTED, so insertText replaces it. A bare
  // focus() would leave "OLD@example.comnew@example.com".
  assert.equal(el.selectionStart, 0);
  assert.equal(el.selectionEnd, "OLD@example.com".length);
});

test("F14 an unknown field name reports candidates", async () => {
  const { protocol } = makeProtocol('<input name="zip"><input name="city">');
  const r = await act(protocol, "fill nickname with zzz");
  assert.equal(r.action, "fill_error");
  assert.ok(r.candidates.some((c) => c.name === "zip"));
});

// ─── F15: matching is honest about ambiguity ─────────────────────────────────

test("F15 extract never returns the whole document", async () => {
  const { protocol } = makeProtocol(
    "<html><head><title>S</title></head><body>" +
    "<header>Welcome to the best shop in the world</header><p>Price: $19.99</p></body></html>");
  const r = await act(protocol, "extract the prices");
  assert.ok(!String(r.content || "").includes("Welcome to the best shop"));
});

test("F15 'what's on this page' is understood", async () => {
  const { protocol } = makeProtocol("<h1>Hi</h1><p>Body text</p><a href='/x'>Link</a>");
  const r = await act(protocol, "what's on this page");
  assert.equal(r.action, "extract");
  assert.ok(Array.isArray(r.headings));
});

test("F15 'what is on this page' is understood", async () => {
  const { protocol } = makeProtocol("<h1>Hi</h1>");
  const r = await act(protocol, "what is on this page");
  assert.notEqual(r.action, "unknown");
});

test("F15 extract returns the smallest matching element", async () => {
  const { protocol } = makeProtocol(
    "<div id='wrap'><section><p>Refurbished laptops from $299</p></section></div>");
  const r = await act(protocol, "extract refurbished laptops");
  assert.equal(r.content, "Refurbished laptops from $299");
});

test("F15 an exact label beats a link that merely starts with it", async () => {
  const { protocol, log, document } = makeProtocol(
    "<a href='/g'>Login with Google</a><a href='/b'>Login</a>");
  const r = await act(protocol, "click login");
  assert.equal(r.action, "click");
  assert.equal(r.clicked, "Login");
  const login = [...document.querySelectorAll("a")][1];
  const rect = login.getBoundingClientRect();
  assert.equal(log.mouse[0].y, Math.round(rect.y + rect.height / 2));
});

test("F15 genuinely ambiguous clicks return candidates instead of guessing", async () => {
  const { protocol, log } = makeProtocol(
    "<a href='/g'>Sign in with Google</a><a href='/gh'>Sign in with GitHub</a>");
  const r = await act(protocol, "click sign in");
  assert.equal(r.action, "click_error");
  assert.equal(log.mouse.length, 0);
  assert.ok(r.candidates.length >= 2);
});

// ─── F16: URL handling ───────────────────────────────────────────────────────

test("F16 keeps an explicit http scheme", async () => {
  const { protocol, log } = makeProtocol("<body></body>");
  await act(protocol, "go to http://192.168.1.10/admin");
  assert.equal(log.navigated[0], "http://192.168.1.10/admin");
});

test("F16 accepts localhost with a port", async () => {
  const { protocol, log } = makeProtocol("<body></body>");
  await act(protocol, "go to http://localhost:3000");
  assert.equal(log.navigated[0], "http://localhost:3000/");
});

test("F16 keeps www", () => {
  assert.equal(normalizeUrl("www.example.com"), "https://www.example.com");
});

test("F16 non-URLs are not URLs", () => {
  assert.equal(normalizeUrl("cheap flights"), null);
  assert.equal(normalizeUrl("how to bake bread"), null);
});

test("F05 navigate refuses non-http schemes", async () => {
  const { protocol, log } = makeProtocol("<body></body>");
  const r = await act(protocol, "go to file:///etc/passwd");
  assert.equal(r.action, "navigate_error");
  assert.deepEqual(log.navigated, []);
});

// ─── scroll + fallback ───────────────────────────────────────────────────────

test("scroll down and up work", async () => {
  const { protocol } = makeProtocol("<body></body>");
  assert.equal((await act(protocol, "scroll down")).direction, "down");
  assert.equal((await act(protocol, "scroll up")).direction, "up");
});

test("an unrecognised instruction is reported as unknown, not guessed", async () => {
  const { protocol } = makeProtocol("<h1>Hi</h1>");
  const r = await act(protocol, "make me a sandwich");
  assert.equal(r.action, "unknown");
  assert.ok(r.tip);
});

// ─── F27: destructive clicks need confirmation ───────────────────────────────

test("F27 a destructive click is refused without force", async () => {
  const { protocol, log } = makeProtocol("<button>Delete account</button>");
  const r = await act(protocol, "click delete account");
  assert.equal(r.action, "needs_confirmation");
  assert.equal(log.mouse.length, 0);
});

test("F27 force:true clicks a destructive button", async () => {
  const { protocol, log } = makeProtocol("<button>Delete account</button>");
  const r = await act(protocol, "click delete account", { force: true });
  assert.equal(r.action, "click");
  assert.equal(log.mouse.length, 3, "moved + pressed + released");
});

test("F27 confirmDestructive:false disables the guard", async () => {
  const { protocol, log } = makeProtocol("<button>Delete account</button>");
  const r = await act(protocol, "click delete account", { confirmDestructive: false });
  assert.equal(r.action, "click");
  assert.ok(log.mouse.length > 0);
});