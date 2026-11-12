import test from "node:test";
import assert from "node:assert/strict";
import { clickWarning } from "../lib/snapshot.mjs";

// The rule this replaces fired on every ref click: it compared `link "IANA"`
// (a role descriptor) with `a` (a tag) and concluded the element was covered
// while the click had plainly landed. A warning that always fires is noise, and
// noise is how a real obstruction gets ignored.

test("a click that hit its element says nothing", () => {
  assert.equal(clickWarning({ hit: true, landedOn: "a" }), null);
});

test("a click that landed on a child of the target says nothing", () => {
  // contains() is what makes this a success: the span is inside the link.
  assert.equal(clickWarning({ hit: true, landedOn: "span" }), null);
});

test("a click that missed says so, once", () => {
  const warning = clickWarning({ hit: false, landedOn: "div#overlay" });
  assert.match(warning, /covered or off-screen/);
});

test("no hit test (DOM fallback) is not a failure", () => {
  assert.equal(clickWarning({ hit: null, landedOn: null }), null);
  assert.equal(clickWarning(undefined), null);
});
