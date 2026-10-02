/**
 * bwb-browser — Config resolution (pure, testable)
 *
 * Precedence: CLI flag > env var > default. Kept out of server.mjs so it can be
 * unit-tested without booting an MCP server (see test/config.test.mjs).
 */

import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";

/** Flags that take a value. Value = next token, if it isn't another flag. */
const VALUE_FLAGS = {
  "--browser-path": "browserPath",
  "--port": "port",
  "--user-data-dir": "userDataDir",
  "--screenshots-dir": "screenshotsDir",
  "--timeout": "navTimeout",
  "--idle": "idleMs",
  "--tab-max": "tabMax",
  "--attach-port": "attachPort",
  "--allow-domains": "allowDomains",
};

/** Flags that are booleans. `--flag`, `--flag true`, `--flag false`. */
const BOOL_FLAGS = {
  "--headless": "headless",
  "--lean": "lean",
  "--nuclear": "nuclear",
  "--readonly": "readonly",
  "--no-sandbox": "noSandbox",
  "--always-browser": "alwaysBrowser",
  "--journal-full": "journalFull",
  "--confirm-destructive": "confirmDestructive",
};

/** Flags that take an integer value. */
const INT_FLAGS = new Set([
  "--port", "--timeout", "--idle", "--tab-max", "--attach-port",
]);

export class ConfigError extends Error {}

/**
 * Parse argv (without node/script) into a partial config.
 * Bare booleans never swallow the next flag — `--nuclear --lean true` yields
 * both. Unknown flags are an error instead of a silent typo.
 */
export function parseArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (BOOL_FLAGS[arg]) {
      const next = argv[i + 1];
      const key = BOOL_FLAGS[arg];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else if (next === "true" || next === "false") {
        out[key] = next === "true";
        i++;
      } else {
        throw new ConfigError(`${arg} expects true or false, got "${next}"`);
      }
      continue;
    }

    if (VALUE_FLAGS[arg]) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ConfigError(`${arg} requires a value`);
      }
      const key = VALUE_FLAGS[arg];
      if (INT_FLAGS.has(arg)) {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) {
          throw new ConfigError(`${arg} expects a non-negative integer, got "${value}"`);
        }
        out[key] = n;
      } else {
        out[key] = value;
      }
      i++;
      continue;
    }

    // Flags handled by server.mjs itself (lifecycle, not config).
    if (arg === "--version" || arg === "--help" || arg === "--setup"
      || arg === "--dry-run" || arg === "--yes") {
      out[`_passthrough_${arg.slice(2)}`] = true;
      continue;
    }

    throw new ConfigError(`Unknown option: ${arg}`);
  }
  return out;
}

function defaultScreenshotsDir(env, isAndroid) {
  const androidPath = "/storage/emulated/0/Download/bwb-screenshots";
  if (isAndroid && existsSync("/storage/emulated/0/Download")) return androidPath;
  if (env.TERMUX_VERSION) return androidPath;
  return join(homedir(), "bwb-screenshots");
}

/**
 * Resolve the full runtime config.
 * @param {object} cli  output of parseArgs
 * @param {object} env  process.env
 * @param {object} opts {isTermux}
 */
export function resolveConfig(cli = {}, env = process.env, opts = {}) {
  const isTermux = opts.isTermux ?? false;
  const termux = isTermux || Boolean(
    env.TERMUX_VERSION ||
    env.PREFIX?.includes("com.termux") ||
    env.HOME?.includes("com.termux")
  );

  const envInt = (name, fallback) => {
    if (env[name] === undefined || env[name] === "") return fallback;
    const n = Number(env[name]);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  const envBool = (name) => (env[name] === undefined ? undefined : env[name] !== "false");

  const cfg = {};

  cfg.port = cli.port ?? envInt("BWB_CDP_PORT", 0);
  cfg.attachPort = cli.attachPort ?? envInt("BWB_ATTACH_PORT", 0);
  cfg.headless = cli.headless ?? envBool("BWB_HEADLESS") ?? true;
  cfg.browserPath = cli.browserPath ?? env.BWB_CHROME_PATH ?? null;

  // Chromium's sandbox is kept where it works. --no-sandbox is needed on Termux,
  // under root/Docker, or with an explicit BWB_NO_SANDBOX=1 — not everywhere.
  cfg.noSandbox = cli.noSandbox ?? envBool("BWB_NO_SANDBOX") ?? false;

  // Agent-safety policy (F27). readonly disables every state-changing tool;
  // allowDomains is an optional host allowlist for goto/newTab/act navigation.
  cfg.readonly = cli.readonly ?? envBool("BWB_READONLY") ?? false;
  cfg.allowDomains = normalizeDomains(cli.allowDomains ?? env.BWB_ALLOW_DOMAINS ?? "");
  cfg.confirmDestructive = cli.confirmDestructive ?? envBool("BWB_CONFIRM_DESTRUCTIVE") ?? true;

  cfg.userDataDir = cli.userDataDir
    ?? env.BWB_USER_DATA_DIR
    ?? join(homedir(), ".cache", "bwb-browser");

  cfg.screenshotsDir = cli.screenshotsDir
    ?? env.BWB_SCREENSHOTS_DIR
    ?? defaultScreenshotsDir(env, platform() === "android" || termux);

  cfg.navTimeout = cli.navTimeout ?? envInt("BWB_NAV_TIMEOUT", 30000);
  cfg.alwaysBrowser = cli.alwaysBrowser ?? envBool("BWB_ALWAYS_BROWSER") ?? false;

  // v4 survival defaults: lean auto-detects Termux; mayfly + tab cap follow lean.
  cfg.lean = cli.lean ?? envBool("BWB_LEAN") ?? termux;
  cfg.nuclear = cli.nuclear ?? (env.BWB_NUCLEAR === "true");

  cfg.idleMs = cli.idleMs
    ?? (env.BWB_IDLE_MS !== undefined ? envInt("BWB_IDLE_MS", 0) : (cfg.lean ? 5 * 60 * 1000 : 0));
  cfg.tabMax = cli.tabMax
    ?? (env.BWB_TAB_MAX !== undefined ? envInt("BWB_TAB_MAX", 0) : (cfg.lean ? 3 : 0));

  // Journal restore re-fires recorded URLs. Only automatic on a lean profile
  // (the post-LMK resurrection flow); elsewhere it is opt-in (F09).
  cfg.journalFull = cli.journalFull ?? (env.BWB_JOURNAL === "full");

  cfg.allowPrivate = envBool("BWB_ALLOW_PRIVATE") ?? false;
  cfg.shotKeep = envInt("BWB_SHOT_KEEP", 50);

  return cfg;
}

function normalizeDomains(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  return list
    .map((d) => String(d).trim().toLowerCase().replace(/^\*\./, ""))
    .filter(Boolean);
}