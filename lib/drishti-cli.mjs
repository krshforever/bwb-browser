/**
 * bwb-browser — `bwb pair` / `bwb unpair` / `bwb drishti` (doctor)
 *
 * A thin terminal front end over lib/drishti.mjs. Kept out of server.mjs so the
 * MCP process never pays for CLI code and the pairing flow stays unit-testable.
 */

import { pairFlow, writeStore, removeStore, readStore, storePath, doctor, maskToken, resolvePort, generatePairCode, postNote, getNotes, readNotesCursor, relativeAge } from "./drishti.mjs";

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
  const timeoutSec = parseValue(args, "--timeout", 90);
  // Single-use and 60s-lived: printing it is the only way a human can match the
  // card on the phone, and the only way a failed attempt is diagnosable.
  const code = generatePairCode();
  console.log(`Pairing with drishti on 127.0.0.1:${port}…`);
  console.log("A code has been sent to the app — approve it on your phone.");

  console.log(`Code: ${code}`);
  console.log("The drishti app should be showing it now — tap Allow within 60s.");

  const result = await pairFlow({ port, code, timeoutMs: timeoutSec * 1000 });
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

/**
 * `bwb note "no, the second link"` — steer the agent from the terminal.
 *
 * The app has a field for this; the CLI exists so the channel can be tested and
 * so a human already in Termux does not have to reach for the phone.
 */
async function steer(args) {
  const text = args.join(" ").trim();
  if (!text) {
    console.error('bwb: note needs text — bwb note "no, use the second link"');
    return 2;
  }
  const queued = await postNote(text);
  console.log(`note queued: ${queued.id}`);
  return 0;
}

/**
 * `bwb notes` — peek at the backlog WITHOUT consuming it.
 *
 * Peeking matters: the agent still needs to receive these, so this command
 * deliberately does not advance the cursor. It prints what the agent will see.
 */
async function pendingNotes() {
  const page = await getNotes({ after: readNotesCursor() });
  if (page.unsupported) {
    console.error("bwb: this drishti build has no note channel (needs 1.0.2 or later)");
    return 1;
  }
  if (!page.notes.length) {
    console.log(page.cursor_unknown
      ? "no pending notes (some were dropped before delivery)"
      : "no pending notes");
    return 0;
  }
  for (const note of page.notes) {
    const text = String(note.text ?? "").replace(/\s+/g, " ");
    console.log(`${note.id}  ${relativeAge(note.at)}  ${text}`);
  }
  if (page.cursor_unknown) {
    console.log("(the cursor was evicted — these are the whole buffer, not a clean continuation)");
  }
  return 0;
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
    if (sub === "note") {
      return await steer(args);
    }
    if (sub === "notes") {
      return await pendingNotes();
    }
    console.error(`bwb: unknown command "${sub}" (expected pair, unpair, drishti, note, or notes)`);
    return 2;
  } catch (err) {
    console.error(`bwb: ${err.message}`);
    return 1;
  }
}
