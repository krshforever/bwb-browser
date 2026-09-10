/**
 * bwb-browser — Resource vigilance (v4)
 *
 * Pure measurement + policy. No imports from tabs/browser (avoid cycles) —
 * the server.mjs response wrapper executes the actions assess() recommends.
 * MCP can't push, so every tool response carries a ~100-byte footer and the
 * watcher stream carries memory samples. That IS the "instant" channel.
 */

import { execSync } from "child_process";

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

function selfMb() {
  return Math.round(process.memoryUsage().rss / MB);
}

// Sum RSS of a pid + its descendants via ps. Null when unmeasurable.
function treeMb(rootPid) {
  if (!rootPid) return null;
  try {
    const out = execSync("ps -o pid=,ppid=,rss= -e", { encoding: "utf8", timeout: 3000 });
    const procs = out.trim().split("\n").map((l) => {
      const [pid, ppid, rss] = l.trim().split(/\s+/).map(Number);
      return { pid, ppid, rss };
    });
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
  } catch {
    return null;
  }
}

/** Snapshot: {mcpMb, chromiumMb|null, tabCount} */
export function sampleResources(browserPid, tabCount = 0) {
  return { mcpMb: selfMb(), chromiumMb: treeMb(browserPid), tabCount };
}

/**
 * Policy verdict: 'ok' | 'watch' | 'critical'.
 * critical = shed load NOW (hibernate tabs → teardown). watch = warn only.
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
  return `[bwb resources] mcp:${sample.mcpMb}MB ${c} tabs:${sample.tabCount} state:${trend}${note ? " " + note : ""}]`;
}
