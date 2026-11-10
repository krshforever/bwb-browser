/**
 * bwb-browser — `bwb pair` / `bwb unpair` / `bwb drishti` (doctor)
 *
 * A thin terminal front end over lib/drishti.mjs. Kept out of server.mjs so the
 * MCP process never pays for CLI code and the pairing flow stays unit-testable.
 */

import { pairFlow, writeStore, removeStore, readStore, storePath, doctor, maskToken, resolvePort } from "./drishti.mjs";

function parseValue(args, flag, fallback) {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const raw = args[i + 1];
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} expects a positive number`);
  return n;
}

function line(ok, text) {
  console.log(`${ok ? "✓" : "✗"} ${text}`);
}

async function pair(args) {
  const port = parseValue(args, "--port", resolvePort());
  const timeoutSec = parseValue(args, "--timeout", 60);
  console.log(`Pairing with drishti on 127.0.0.1:${port}…`);
  console.log("A code has been sent to the app — approve it on your phone.");

  const result = await pairFlow({ port, timeoutMs: timeoutSec * 1000 });
  const path = writeStore({ token: result.token, port: result.port, app: result.app });
  if (result.amError) {
    console.log(`(the code could not be announced automatically: ${result.amError})`);
  }
  console.log(`Paired. Token saved to ${path} (0600), token ${maskToken(result.token)}.`);
  console.log("Run `bwb --drishti`, or nothing at all — auto-detect is now on.");
}

async function unpair() {
  const path = storePath();
  const existed = readStore();
  removeStore();
  console.log(existed ? `Unpaired. Removed ${path}.` : `Nothing to unpair (no store at ${path}).`);
}

async function runDoctor() {
  const report = await doctor();
  for (const check of report.checks) {
    line(check.ok, `${check.name}: ${check.detail}`);
    if (!check.ok && check.fix) console.log(`   fix: ${check.fix}`);
  }
  console.log("");
  console.log(report.ok
    ? "drishti looks healthy. bwb can drive it."
    : "drishti is not ready — fix the first ✗ above.");
  return report.ok;
}

/** Entry point used by server.mjs before it parses MCP flags. */
export async function runCli(sub, args = []) {
  try {
    if (sub === "pair") {
      await pair(args);
      return 0;
    }
    if (sub === "unpair") {
      await unpair();
      return 0;
    }
    if (sub === "drishti") {
      return (await runDoctor()) ? 0 : 1;
    }
    console.error(`bwb: unknown command "${sub}" (expected pair, unpair, or drishti)`);
    return 2;
  } catch (err) {
    console.error(`bwb: ${err.message}`);
    return 1;
  }
}
