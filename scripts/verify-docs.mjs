/**
 * Cross-check every place the 26 tools are described against the code.
 *
 * Descriptions are what an agent reads before calling a tool, and the docs are
 * what a human reads before trusting it. If they disagree, the agent is the one
 * that gets hurt. Run: node scripts/verify-docs.mjs
 */

import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const benchmarks = readFileSync(new URL("../BENCHMARKS.md", import.meta.url), "utf8");

const problems = [];
const fail = (m) => problems.push(m);

// ── Boot the real server and ask it for its own tools ───────────────────────
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server.mjs"],
  cwd: new URL("..", import.meta.url).pathname,
  stderr: "pipe",
});
const client = new Client({ name: "verify-docs", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();
await transport.close();

console.log(`# ${tools.length} tools reported by the server\n`);

// ── 1. The release gate ──────────────────────────────────────────────────────
if (tools.length !== 26) fail(`tool count is ${tools.length}, the stated gate is 26`);

// ── 2. Every tool is documented in README and AGENTS ────────────────────────
// Only table rows count as "documented as a tool". Prose and Breaking notes
// may legitimately name a removed tool to explain that it was removed.
const docTables = { "README.md": readme, "AGENTS.md": agents };
const tableRows = (text) => text.split("\n").filter((l) => l.trim().startsWith("|"));

for (const t of tools) {
  for (const [file, text] of Object.entries(docTables)) {
    if (!text.includes(t.name)) fail(`${file} does not mention ${t.name}`);
    const row = tableRows(text).find((l) => l.includes(t.name));
    if (!row) fail(`${file} has no table row for ${t.name}`);
  }
}
// The reverse: anywhere the docs name a tool, the server must expose it.
// This has to scan PROSE too, not just tables — a doc that tells an agent to
// call a nonexistent tool is exactly the failure this catches. Lines that
// discuss a tool's removal are exempt (that is how CHANGELOG-style notes read).
const REMOVAL_CONTEXT =
  /\b(?:folded|removed|renamed|replaced|deprecated|no longer|used to|dropped|lost)\b/i;
// A line that says what a tool does NOT support ("no pdf/docx/pptx") is a
// correct statement, not an advertisement.
const NEGATED = /\b(?:no|not|without|never|lost|dropped|removed)\b[^.\n]{0,30}$/i;
for (const [file, text] of Object.entries(docTables)) {
  for (const line of text.split("\n")) {
    if (REMOVAL_CONTEXT.test(line)) continue;
    for (const m of line.matchAll(/`(browser_[a-zA-Z]+)`/g)) {
      if (!tools.some((t) => t.name === m[1])) {
        fail(`${file} references ${m[1]}, which the server does not expose`);
      }
    }
  }
}

// ── 3. No marketing filler in model-facing text ─────────────────────────────
for (const t of tools) {
  if (/GROUNDBREAKING|REVOLUTIONARY|GAME-?CHANGER|WORLD-?CLASS/i.test(t.description)) {
    fail(`${t.name}: marketing language in a model-facing description`);
  }
  if (t.description.trim().length < 40) {
    fail(`${t.name}: description too thin to act on (${t.description.trim().length} chars)`);
  }
}

// ── 4. Documented behaviour matches implemented behaviour ────────────────────
// Each of these was a real defect in 4.0.1; the docs must not re-advertise it.
const exportedTools = new Set(tools.map((t) => t.name));

// browser_export must not advertise formats the code rejects — in the docs
// AND in its own tool description.
const exportTool = tools.find((t) => t.name === "browser_export");
const exportSchema = JSON.stringify(exportTool.inputSchema);
if (/pdf|docx|pptx/i.test(exportSchema)) fail("browser_export schema still accepts pdf/docx/pptx");
for (const [file, text] of Object.entries({ ...docTables, "BENCHMARKS.md": benchmarks })) {
  for (const line of text.split("\n")) {
    if (!/browser_export/.test(line)) continue;
    const fmt = /\b(?:pdf|docx|pptx)\b/i.exec(line);
    if (!fmt) continue;
    if (REMOVAL_CONTEXT.test(line)) continue;
    if (NEGATED.test(line.slice(0, fmt.index))) continue;
    fail(`${file} still advertises pdf/docx/pptx for browser_export`);
  }
}

// browser_text must advertise its cap and its innerText semantics.
const textTool = tools.find((t) => t.name === "browser_text");
if (!/maxChars/.test(textTool.description)) fail("browser_text does not document maxChars");
if (!/innerText/.test(textTool.description)) fail("browser_text does not state it returns innerText");

// browser_act must document the two guardrails it actually has.
const actTool = tools.find((t) => t.name === "browser_act");
if (!/candidates/.test(actTool.description)) fail("browser_act does not document candidates");
if (!/force/.test(actTool.description)) fail("browser_act does not document force");

// browser_goto must document mode.
const gotoTool = tools.find((t) => t.name === "browser_goto");
if (!/mode/.test(gotoTool.description)) fail("browser_goto does not document mode");

// Security posture must be stated in both docs.
for (const [file, text] of Object.entries(docTables)) {
  for (const claim of ["file:", "readonly", "prompt injection"]) {
    if (!new RegExp(claim, "i").test(text)) {
      fail(`${file} does not mention "${claim}" in its security notes`);
    }
  }
}

// ── 5. Stale claims that were fixed in 4.1.0 must not reappear ───────────────
const staleClaims = [
  [/raw CDP/i, "claims 'raw CDP' — there is a thin CDP client"],
  [/zero-dependencies/i, "keyword 'zero-dependencies' is false (5 runtime deps)"],
  [/136KB|38\.8 ?kB/, "quotes the old 136KB / 38.8kB size"],
  [/30KB, 11 tools/, "quotes the v1-era BENCHMARKS numbers"],
  [/bwb-browser 4\.0\.0|bwb-browser 3\.2\.0/, "quotes an old version in an example"],
  [/Not "stealth mode"|not "stealth mode"/i, "still claims the fingerprint is not stealth"],
  [/Pro paid license|v2\.0 Pro|Monetization Path/i, "still promises a paid Pro tier"],
];
for (const [file, text] of Object.entries(docTables)) {
  for (const [re, why] of staleClaims) {
    if (re.test(text)) fail(`${file} ${why}`);
  }
}
// BENCHMARKS must not promise monetization that the README forbids.
if (/Monetization Path|v2\.0 Pro|paid license/i.test(benchmarks)) {
  fail("BENCHMARKS.md still has the monetization roadmap that contradicts the README");
}

// ── 6. Version is consistent everywhere ──────────────────────────────────────
const v = pkg.version;
if (!changelog.includes(`## ${v}`)) fail(`CHANGELOG has no heading for ${v}`);
for (const [file, text] of Object.entries({
  ...docTables,
  "BENCHMARKS.md": benchmarks,
  "CHANGELOG.md": changelog,
})) {
  for (const m of text.matchAll(/bwb-browser (\d+\.\d+\.\d+)/g)) {
    // Only examples that claim to be *current* output must match. Historical
    // release notes legitimately name older versions.
    if (m[1] !== v && file !== "CHANGELOG.md") {
      fail(`${file} shows 'bwb-browser ${m[1]}' but package.json is ${v}`);
    }
  }
}
// The --version example line. It carries extra spaces for column alignment, so
// match the shape, not the exact spacing.
if (!/#\s*→ bwb-browser \d+\.\d+\.\d+\s*$/m.test(readme)) {
  fail("README has no 'bwb --version' output line");
}

// ── 7. The size claims must match reality, not just each other ───────────────
const { statSync, readdirSync } = await import("node:fs");
const { join } = await import("node:path");
const root = new URL("..", import.meta.url).pathname;
let codeBytes = statSync(join(root, "server.mjs")).size;
for (const f of readdirSync(join(root, "lib"))) codeBytes += statSync(join(root, "lib", f)).size;
const kb = Math.round(codeBytes / 1024);

// Match only claims that are specifically about THIS package's source size.
// A generic /(\d+)KB/ sweep would also catch competitor figures in comparison
// tables, which are legitimately different numbers.
//
// The near-miss words "grew the source by", "grew ... to" mark DELTAS, not
// absolute sizes, so skip those.
const isDelta = (line, index) => {
  const before = line.slice(Math.max(0, index - 40), index);
  // "grew the source by ~50KB", "added ~50KB", "from 120KB to 173KB" describe a
  // change, not the current size. Tolerate the "~" that may follow the verb.
  return /\b(?:by|grew|added|more|increase[sd]?|gaining)\s*~?$|\bfrom\s+\d+\s?KB$/i.test(before);
};
const SOURCE_CLAIM = /\b~?(\d{2,4})\s?KB\b/g;
for (const [file, text] of Object.entries({ ...docTables, "BENCHMARKS.md": benchmarks })) {
  for (const line of text.split("\n")) {
    // Only lines that talk about source size at all are in scope.
    if (!/\b(?:source|Source)\b/.test(line)) continue;
    for (const m of line.matchAll(SOURCE_CLAIM)) {
      if (isDelta(line, m.index)) continue;
      const claimed = Number(m[1]);
      if (![kb - 1, kb, kb + 1].some((c) => c === claimed)) {
        fail(`${file} claims ${claimed}KB of source; server.mjs + lib/ is ${kb}KB`);
      }
    }
  }
}
console.log(`# source: ${kb}KB · deps: ${Object.keys(pkg.dependencies).length} · tools: ${tools.length}\n`);

// ── Report ───────────────────────────────────────────────────────────────────
if (problems.length) {
  console.error(`✗ ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
console.log("✓ docs, descriptions, version and size claims all agree with the code");