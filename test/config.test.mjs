import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, resolveConfig, ConfigError } from "../lib/config.mjs";

// ─── F21: boolean flags must not swallow the next argument ───────────────────

test("F21 bare boolean flags never eat the next flag", () => {
  const cfg = parseArgs(["--nuclear", "--lean", "true"]);
  assert.equal(cfg.nuclear, true);
  assert.equal(cfg.lean, true);
});

test("F21 boolean flags accept explicit values", () => {
  assert.deepEqual(parseArgs(["--nuclear", "false"]), { nuclear: false });
  assert.deepEqual(parseArgs(["--headless"]), { headless: true });
  assert.deepEqual(parseArgs(["--lean", "false", "--nuclear"]), { lean: false, nuclear: true });
});

test("F21 a boolean flag rejects a non-boolean value", () => {
  assert.throws(() => parseArgs(["--nuclear", "yes"]), ConfigError);
});

test("F21 numeric flags are validated", () => {
  assert.equal(parseArgs(["--port", "9222"]).port, 9222);
  assert.throws(() => parseArgs(["--port", "abc"]), ConfigError);
  assert.throws(() => parseArgs(["--port", "-1"]), ConfigError);
  assert.throws(() => parseArgs(["--port"]), ConfigError);
});

test("F21 unknown flags are an error, not a silent typo", () => {
  assert.throws(() => parseArgs(["--nucelar"]), /Unknown option/);
  assert.throws(() => parseArgs(["--browser-path"]), /requires a value/);
});

test("F21 lifecycle flags pass through untouched", () => {
  const cfg = parseArgs(["--version"]);
  assert.equal(cfg._passthrough_version, true);
});

// ─── precedence: CLI > env > default ─────────────────────────────────────────

test("config precedence is CLI > env > default", () => {
  const env = { BWB_CDP_PORT: "1111", BWB_NAV_TIMEOUT: "5000" };
  assert.equal(resolveConfig({ port: 9222 }, env, {}).port, 9222);
  assert.equal(resolveConfig({}, env, {}).port, 1111);
  assert.equal(resolveConfig({}, {}, {}).port, 0);

  assert.equal(resolveConfig({ navTimeout: 1234 }, env, {}).navTimeout, 1234);
  assert.equal(resolveConfig({}, env, {}).navTimeout, 5000);
  assert.equal(resolveConfig({}, {}, {}).navTimeout, 30000);
});

test("headless defaults to true and is disabled by env or flag", () => {
  assert.equal(resolveConfig({}, {}, {}).headless, true);
  assert.equal(resolveConfig({}, { BWB_HEADLESS: "false" }, {}).headless, false);
  assert.equal(resolveConfig({ headless: true }, { BWB_HEADLESS: "false" }, {}).headless, true);
});

test("lean auto-detects Termux and drives the survival defaults", () => {
  const termux = resolveConfig({}, {}, { isTermux: true });
  assert.equal(termux.lean, true);
  assert.equal(termux.idleMs, 5 * 60 * 1000);
  assert.equal(termux.tabMax, 3);

  const desktop = resolveConfig({}, {}, {});
  assert.equal(desktop.lean, false);
  assert.equal(desktop.idleMs, 0);
  assert.equal(desktop.tabMax, 0);
});

// ─── F08: the sandbox is a decision, not a constant ──────────────────────────

test("F08 the sandbox stays on unless we know it cannot work", () => {
  assert.equal(resolveConfig({}, {}, {}).noSandbox, false);
  assert.equal(resolveConfig({}, { BWB_NO_SANDBOX: "1" }, {}).noSandbox, true);
});

// ─── F27: agent-safety policy ────────────────────────────────────────────────

test("readonly mode is opt-in", () => {
  assert.equal(resolveConfig({}, {}, {}).readonly, false);
  assert.equal(resolveConfig({}, { BWB_READONLY: "1" }, {}).readonly, true);
});

test("allow-domains is parsed into a list", () => {
  assert.deepEqual(resolveConfig({}, { BWB_ALLOW_DOMAINS: "a.com, *.B.com " }, {}).allowDomains,
    ["a.com", "b.com"]);
});

test("destructive-click confirmation is on by default", () => {
  assert.equal(resolveConfig({}, {}, {}).confirmDestructive, true);
  assert.equal(resolveConfig({}, { BWB_CONFIRM_DESTRUCTIVE: "false" }, {}).confirmDestructive, false);
});

// ─── misc defaults ───────────────────────────────────────────────────────────

test("journal auto-restore is opt-in off Termux (F09)", () => {
  assert.equal(resolveConfig({}, {}, {}).journalFull, false);
  assert.equal(resolveConfig({}, { BWB_JOURNAL: "full" }, {}).journalFull, true);
});

test("screenshot retention has a default", () => {
  assert.equal(resolveConfig({}, {}, {}).shotKeep, 50);
  assert.equal(resolveConfig({}, { BWB_SHOT_KEEP: "10" }, {}).shotKeep, 10);
});

test("nuclear stays off unless explicitly asked for", () => {
  assert.equal(resolveConfig({}, {}, {}).nuclear, false);
  assert.equal(resolveConfig({ nuclear: true }, {}, {}).nuclear, true);
});