import test from "node:test";
import assert from "node:assert/strict";
import { parseKey, urlMatcher } from "../lib/interact.mjs";

test("K1 a plain key maps to key, code and virtual key code together", () => {
  const { key, modifiers } = parseKey("Enter");
  assert.equal(key.key, "Enter");
  assert.equal(key.code, "Enter");
  assert.equal(key.vk, 13);
  assert.equal(modifiers, 0);
});

test("K2 chords set the modifier bits CDP expects", () => {
  const { key, modifiers } = parseKey("Control+Shift+a");
  assert.equal(modifiers, 2 | 8);
  assert.equal(key.code, "KeyA");
  assert.equal(key.vk, 65);
  assert.equal(key.text, "A", "shift produces the capital");
});

test("K3 aliases mean the same thing", () => {
  assert.equal(parseKey("Ctrl+b").modifiers, parseKey("Control+b").modifiers);
  assert.equal(parseKey("Cmd+b").modifiers, parseKey("Meta+b").modifiers);
});

test("K4 digits and named keys", () => {
  assert.equal(parseKey("7").key.code, "Digit7");
  assert.equal(parseKey("7").key.vk, 55);
  assert.equal(parseKey("escape").key.key, "Escape");
  assert.equal(parseKey("ArrowDown").key.vk, 40);
  assert.equal(parseKey(" ").key.key, " ");
  assert.equal(parseKey("Space").key.code, "Space");
});

test("K5 an unknown modifier or key is refused with the alternatives", () => {
  assert.throws(() => parseKey("Hyper+a"), /Unknown modifier "Hyper".*Control, Alt, Shift or Meta/);
  assert.throws(() => parseKey("Nonesuch"), /Unknown key "Nonesuch"/);
  assert.throws(() => parseKey(""), /needs a key/);
});

test("K6 url matcher treats a star as anything and escapes the rest", () => {
  assert.ok(urlMatcher("https://x.com/a/*/b").test("https://x.com/a/1/b"));
  assert.ok(urlMatcher("http://127.0.0.1:*").test("http://127.0.0.1:8080"));
  assert.ok(!urlMatcher("https://x.com/a/*/b").test("https://x.com/a/1/b/c"));
  // dots must not become wildcards
  assert.ok(!urlMatcher("https://a.com").test("https://axcom"));
});
