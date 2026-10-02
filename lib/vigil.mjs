/**
 * bwb-browser — Resource vigilance (v4)
 *
 * Pure measurement + policy. No imports from tabs/browser (avoid cycles) —
 * the server.mjs response wrapper executes the actions assess() recommends.
 * MCP can't push, so every tool response carries a ~100-byte footer and the
 * watcher stream carries memory samples. That IS the "instant" channel.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { platform } from "os";

const execFileAsync = promisify(execFile);

// 1GB-box budgets (MB) when lean; roomier desktop defaults otherwise.
// Override any via BWB_WARN_MB / BWB_CRIT_MB. resolveBudgets() is called
// by server.mjs after config — before that, lean-safe values apply.
export let WARN_MB = parseInt(process.env.BWB_WARN_MB || "300", 10);
export let CRIT_MB = parseInt(process.env.BWB_CRIT_MB || "450", 10);

export function resolveBudgets(isLean) {
  if (process.env.BWB_WARN_MB !== undefined) WARN_MB = parseInt(process.env.BWB_WARN_MB, 10);
  else WARN_MB = isLean ? 300 : 1024;
  if (process.env.BWB_CRIT_MB !== undefined) CRIT_MB = parseInt(process.env.BWB_CRIT_MB, 10);
  else CRIT_MB = isLean ? 450 : 1536;
}

const MB = 1024 * 1024;

// The process table is sampled at most every SAMPLE_TTL_MS. Reading it with a
// synchronous `ps` on EVERY tool call blocked the event loop (including
// browser_watch's event handlers) and listed every process on the box.
const SAMPLE_TTL_MS = 5000;
let sampleCache = { at: 0, procs: null };

function readProcessTable() {
  if (Date.now() - sampleCache.at < SAMPLE_TTL_MS) return sampleCache.procs;
  sampleCache = { at: Date.now(), procs: null };
  if (platform() === "win32") return null; // no ps: resource readings degrade to self
  execFileAsync("ps", ["-eo", "pid=,ppid=,rss="], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 })
    .then(({ stdout }) => {
      const procs = stdout.trim().split("\n").map((l) => {
        const [pid, ppid, rss] = l.trim().split(/\s+/).map(Number);
        return { pid, ppid, rss };
      }).filter((p) => Number.isFinite(p.pid));
      // Only publish if no newer sample landed while we were reading.
      if (Date.now() - sampleCache.at >= SAMPLE_TTL_MS - 100) sampleCache = { at: Date.now(), procs };
    })
    .catch(() => {});
  return sampleCache.procs;
}

function selfMb() {
  return Math.round(process.memoryUsage().rss / MB);
}

// Sum RSS of a pid + its descendants via the cached process table.
// Async warm-up: the first call returns null, later ones are accurate.
function treeMb(rootPid) {
  if (!rootPid) return null;
  const procs = readProcessTable();
  if (!procs) return null;
  const kids = new Set([Number(rootPid)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) {
      if (kids.has(p.ppid) && !kids.has(p.pid)) { kids.add(p.pid); grew = true; }
    }
  }
  let kb = 0;
  for (const p of procs) if (kids.has(p.pid) && Number.isFinite(p.rss)) kb += p.rss;
  return Math.round(kb / 1024);
}

/** Snapshot: {mcpMb, chromiumMb|null, tabCount} */
export function sampleResources(browserPid, tabCount = 0) {
  return { mcpMb: selfMb(), chromiumMb: treeMb(browserPid), tabCount };
}

/**
 * Policy verdict: 'ok' | 'watch' | 'critical'.
 * critical = shed load NOW (hibernate tabs → teardown). watch = warn only.
 * Budgets are tuned for a 1GB box (lean). Desktop defaults are deliberately
 * high, so 'critical' rarely fires there — that is intentional, not a bug.
 */
export function assess(sample) {
  const total = (sample.chromiumMb || 0) + sample.mcpMb;
  if (total >= CRIT_MB) return "critical";
  if (total >= WARN_MB) return "watch";
  return "ok";
}

/** ~100-byte footer appended as an extra text block to every tool response. */
export function resourceFooter(sample, note = "") {
  const c = sample.chromiumMb === null ? "browser:off" : `browser:${sample.chromiumMb}MB`;
  const trend = assess(sample);
  return `[bwb resources] mcp:${sample.mcpMb}MB ${c} tabs:${sample.tabCount} state:${trend}${note ? " " + note : ""}`;
}
