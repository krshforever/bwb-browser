import test from "node:test";
import assert from "node:assert/strict";
import { statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// session.mjs resolves its directory at import time from os.homedir().
process.env.HOME = process.env.HOME || homedir();
const { saveSession, loadSession, listSessions } = await import("../lib/session.mjs");

const SESSION_DIR = join(homedir(), ".bwb", "sessions");
const NAME = "bwb-test-session";

function fakeProtocol(cookies) {
  const set = [];
  return {
    Network: {
      getAllCookies: async () => ({ cookies }),
      setCookies: async ({ cookies: c }) => { set.push(...c); return {}; },
    },
    __set: set,
  };
}

const cookies = [
  { name: "sid", value: "abc", domain: "example.com", path: "/", secure: true },
  { name: "other", value: "xyz", domain: ".elsewhere.test", path: "/" },
];

test("F09 session files are owner-only (0600) inside an owner-only dir (0700)", async () => {
  const p = await saveSession(NAME, fakeProtocol(cookies));
  const fileMode = statSync(p.savedTo).mode & 0o777;
  const dirMode = statSync(SESSION_DIR).mode & 0o777;
  assert.equal(fileMode, 0o600, `expected 0600, got 0${fileMode.toString(8)}`);
  assert.equal(dirMode, 0o700, `expected 0700, got 0${dirMode.toString(8)}`);
});

test("saveSession warns that the file holds credentials", async () => {
  const r = await saveSession(NAME, fakeProtocol(cookies));
  assert.match(r.warning, /credential|password/i);
});

test("domains filters what is stored", async () => {
  const r = await saveSession(NAME, fakeProtocol(cookies), { domains: ["example.com"] });
  assert.equal(r.cookieCount, 1);
  const loaded = JSON.parse(readFileSync(r.savedTo, "utf8"));
  assert.deepEqual(loaded.cookies.map((c) => c.domain), ["example.com"]);
});

test("session names cannot escape the session directory", async () => {
  const r = await saveSession("../../etc/evil", fakeProtocol(cookies));
  assert.equal(r.name, "______etc_evil", "dots and slashes are sanitized");
  assert.ok(r.savedTo.startsWith(SESSION_DIR));
  assert.ok(!r.savedTo.includes(".."));
});

test("loadSession restores cookies and reports the count", async () => {
  await saveSession(NAME, fakeProtocol(cookies));
  const proto = fakeProtocol(cookies);
  const r = await loadSession(NAME, proto);
  assert.equal(r.cookieCount, 2);
  assert.equal(proto.__set.length, 2);
});

test("loadSession on a missing file lists what is available", async () => {
  await assert.rejects(() => loadSession("no-such-session-xyz", fakeProtocol([])), /not found/i);
});

test("listSessions finds the saved file", async () => {
  await saveSession(NAME, fakeProtocol(cookies));
  const list = listSessions();
  assert.ok(list.some((s) => s.name === NAME && s.cookieCount === 2));
});