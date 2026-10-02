import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNavigable, assertHttpUrl, assertOutbound, assertDomainAllowed, isPrivateHost,
} from "../lib/urlpolicy.mjs";

// ─── schemes ─────────────────────────────────────────────────────────────────

test("blocked schemes are refused by name", () => {
  for (const url of [
    "file:///etc/passwd",
    "chrome://settings",
    "devtools://devtools/bundled/inspector.html",
    "javascript:alert(1)",
    "view-source:https://example.com",
    "data:text/html,<h1>x</h1>",
    "file:///home/user/.bwb/sessions/gmail.json",
  ]) {
    assert.throws(() => assertNavigable(url), /scheme/i, `${url} must be refused`);
  }
});

test("http, https and about: navigate", () => {
  assert.equal(assertNavigable("https://example.com").protocol, "https:");
  assert.equal(assertNavigable("http://example.com/a?b=1#c").search, "?b=1");
  assert.equal(assertNavigable("about:blank").protocol, "about:");
});

test("junk is refused", () => {
  for (const bad of ["", "   ", "not a url", "http://", null, undefined, 42]) {
    assert.throws(() => assertNavigable(bad));
  }
});

test("assertHttpUrl rejects about:", () => {
  assert.throws(() => assertHttpUrl("about:blank"), /http/i);
});

// ─── private ranges ──────────────────────────────────────────────────────────

test("private and loopback ranges are detected", () => {
  for (const host of [
    "127.0.0.1", "127.1.2.3", "10.0.0.1", "10.255.255.255",
    "172.16.0.1", "172.31.255.255", "192.168.0.1",
    "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1",
    "::1", "fd00::1", "fe80::1", "localhost", "app.localhost",
    "metadata.google.internal", "myservice.internal",
  ]) {
    assert.equal(isPrivateHost(host), true, `${host} is private`);
  }
});

test("public addresses are not private", () => {
  for (const host of [
    "example.com", "www.example.com", "8.8.8.8", "1.1.1.1",
    "172.32.0.1", "192.169.0.1", "11.0.0.1",
  ]) {
    assert.equal(isPrivateHost(host), false, `${host} is public`);
  }
});

test("assertOutbound refuses private targets by default", async () => {
  await assert.rejects(() => assertOutbound("http://127.0.0.1/x"), /private|loopback/i);
  await assert.rejects(() => assertOutbound("http://169.254.169.254/"), /private|loopback/i);
});

test("assertOutbound allows public targets", async () => {
  const u = await assertOutbound("https://example.com/a");
  assert.equal(u.hostname, "example.com");
});

test("assertOutbound honours an explicit hostname allowlist for dev", async () => {
  await assertOutbound("http://127.0.0.1:3000/", { allowPrivate: ["127.0.0.1"] });
  await assert.rejects(
    () => assertOutbound("http://192.168.0.5/", { allowPrivate: ["127.0.0.1"] }),
    /private|loopback/i
  );
});

// ─── domain allowlist (agent safety) ─────────────────────────────────────────

test("domain allowlist matches subdomains", () => {
  assert.equal(assertDomainAllowed("example.com", ["example.com"]), true);
  assert.equal(assertDomainAllowed("www.example.com", ["example.com"]), true);
  assert.throws(() => assertDomainAllowed("evil.com", ["example.com"]), /not allowed/i);
  assert.throws(() => assertDomainAllowed("example.com.evil.com", ["example.com"]), /not allowed/i);
});

test("an empty allowlist allows everything", () => {
  assert.equal(assertDomainAllowed("anything.test", []), true);
});

test("navigation honours the domain allowlist", () => {
  assertNavigable("https://example.com/x", { allowDomains: ["example.com"] });
  assert.throws(
    () => assertNavigable("https://other.com/x", { allowDomains: ["example.com"] }),
    /not allowed/i
  );
});