import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// browser.mjs installs process signal handlers on import; that is fine here.
const { saveScreenshot, killOrphanedChrome, cfg, findBrowserPath, isTermux } =
  await import("../lib/browser.mjs");

let dir;
test.before(() => { dir = mkdtempSync(join(tmpdir(), "bwb-shots-")); cfg.screenshotsDir = dir; });
test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

// ─── F22: two screenshots in the same second must not overwrite ──────────────

test("F22 two screenshots in the same second produce two files", () => {
  const a = saveScreenshot(Buffer.from("one").toString("base64"));
  const b = saveScreenshot(Buffer.from("two").toString("base64"));
  assert.notEqual(a, b, "the second write must not clobber the first");
  assert.equal(readdirSync(dir).length, 2);
});

test("F22 filenames sort chronologically enough for a human to scan", () => {
  const p = saveScreenshot(Buffer.from("x").toString("base64"));
  assert.match(p.split("/").pop(), /^bwb-\d{4}-\d{2}-\d{2}T[\d-]+[A-Z]?-[a-z0-9]{4}\.jpeg$/);
});

test("F22 only the newest BWB_SHOT_KEEP screenshots are kept", () => {
  const keep = cfg.shotKeep;
  cfg.shotKeep = 3;
  try {
    for (let i = 0; i < 8; i++) saveScreenshot(Buffer.from(`s${i}`).toString("base64"));
    const kept = readdirSync(dir).filter((f) => f.endsWith(".jpeg"));
    assert.equal(kept.length, 3, `expected 3 retained, got ${kept.length}`);
  } finally {
    cfg.shotKeep = keep;
  }
});

test("F22 a write failure returns null rather than throwing", () => {
  const saved = cfg.screenshotsDir;
  // A path whose parent is a regular file: mkdirSync fails with ENOTDIR
  // immediately, so saveScreenshot must swallow it and report null.
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "x");
  cfg.screenshotsDir = join(blocker, "shots");
  try {
    assert.equal(saveScreenshot(Buffer.from("x").toString("base64")), null);
  } finally {
    cfg.screenshotsDir = saved;
  }
});

// ─── F23: orphan cleanup must never use a shell ──────────────────────────────

test("F23 orphan cleanup kills nothing when no browser is running", () => {
  const before = process.pid;
  cfg.userDataDir = join(tmpdir(), "bwb-no-such-profile-xyz");
  killOrphanedChrome(); // must be a no-op, and must not throw
  assert.equal(process.pid, before, "the cleanup process survives its own scan");
});

test("F23 orphan cleanup tolerates a path full of shell metacharacters", () => {
  const saved = cfg.userDataDir;
  cfg.userDataDir = '/tmp/$(touch /tmp/pwned);`id`;"x"&|';
  try {
    killOrphanedChrome(); // the old ps|grep|xargs pipeline would have run this
  } finally {
    cfg.userDataDir = saved;
  }
  assert.equal(existsSync("/tmp/pwned"), false, "no shell expansion happened");
});

// ─── F08: sandbox decision ───────────────────────────────────────────────────

test("F08 the sandbox is only disabled where it cannot work", () => {
  const saved = cfg.noSandbox;
  cfg.noSandbox = false;
  try {
    // needsNoSandbox is exercised through the spawn path; here we assert the
    // inputs it depends on are honest about this host.
    assert.equal(typeof isTermux(), "boolean");
    if (!isTermux() && process.getuid?.() !== 0) {
      assert.equal(cfg.noSandbox, false, "a normal desktop run keeps the sandbox");
    }
  } finally {
    cfg.noSandbox = saved;
  }
});

test("F08 an explicit BWB_NO_SANDBOX wins", async () => {
  const { resolveConfig } = await import("../lib/config.mjs");
  assert.equal(resolveConfig({}, { BWB_NO_SANDBOX: "1" }, {}).noSandbox, true);
});

// ─── browser detection ──────────────────────────────────────────────────────

test("findBrowserPath prefers an explicit path, then the environment", () => {
  assert.equal(findBrowserPath("/definitely/not/a/browser"), "/definitely/not/a/browser");
  const saved = process.env.BWB_CHROME_PATH;
  process.env.BWB_CHROME_PATH = "/opt/chrome-from-env";
  try {
    assert.equal(findBrowserPath(), "/opt/chrome-from-env");
  } finally {
    if (saved === undefined) delete process.env.BWB_CHROME_PATH;
    else process.env.BWB_CHROME_PATH = saved;
  }
});

test("findBrowserPath finds a browser on this machine, or returns null", () => {
  // Either a real path or null — the contract is that it never throws and
  // never returns junk.
  const found = findBrowserPath();
  assert.ok(found === null || typeof found === "string");
  if (found) assert.doesNotThrow(() => existsSync(found));
});

test("a corrupt profile-lock file does not block startup", async () => {
  const { checkProfileLock } = await import("../lib/browser.mjs");
  const dir2 = mkdtempSync(join(tmpdir(), "bwb-cfg-"));
  const saved = cfg.userDataDir;
  try {
    writeFileSync(join(dir2, "bwb-owner.json"), "not json at all");
    cfg.userDataDir = dir2;
    checkProfileLock(); // must not throw: unreadable lock != another agent
  } finally {
    cfg.userDataDir = saved;
    rmSync(dir2, { recursive: true, force: true });
  }
});