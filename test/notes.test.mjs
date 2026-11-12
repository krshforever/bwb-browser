/**
 * Steering notes (contract §5.1 / §5.2).
 *
 * The load-bearing claim of this file: a note the human types mid-flight is
 * delivered EXACTLY ONCE, on the next tool result, and a broken relay never
 * costs a tool call. Everything else here is formatting.
 *
 * Teardown rule learned the hard way in this repo: always terminate sockets
 * before closing, or the test process sits alive for three minutes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  relativeAge,
  noteBlock,
  getNotes,
  postNote,
  NoteFeed,
  readNotesCursor,
  writeNotesCursor,
  MAX_NOTE_CHARS,
} from "../lib/drishti.mjs";

/**
 * A relay that answers from a function and records every request it saw.
 * close() destroys live sockets first — see the file header.
 */
async function fakeRelay(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const parsed = raw ? JSON.parse(raw) : null;
      const seen = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        token: req.headers["x-bwb-token"] ?? null,
        body: parsed,
      };
      requests.push(seen);
      const out = handler(seen) ?? {};
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const close = async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      server.close(() => { clearTimeout(timer); resolve(); });
    });
  };
  return { port, requests, close };
}

function tempCursor(t) {
  const dir = mkdtempSync(join(tmpdir(), "bwb-notes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "notes-cursor.json");
}

// ─── Formatting ─────────────────────────────────────────────────────────────

test("relativeAge rounds into human buckets", () => {
  const now = 1_700_000_000_000;
  assert.equal(relativeAge(now, now), "just now");
  assert.equal(relativeAge(now - 9_000, now), "just now");
  assert.equal(relativeAge(now - 12_000, now), "12s ago");
  assert.equal(relativeAge(now - 180_000, now), "3m ago");
  assert.equal(relativeAge(now - 7_200_000, now), "2h ago");
  assert.equal(relativeAge(now - 200_000_000, now), "2d ago");
  // A clock that jumped backwards must not print "-4s ago".
  assert.equal(relativeAge(now + 60_000, now), "just now");
  assert.equal(relativeAge(undefined, now), "just now");
});

test("noteBlock is empty when there is nothing to say", () => {
  assert.equal(noteBlock([]), "");
  assert.equal(noteBlock(null), "");
  assert.equal(noteBlock([{ id: "note_1" }]), ""); // no text, not a note
});

test("noteBlock renders one line the model can read out of context", () => {
  const now = 1_700_000_000_000;
  const block = noteBlock([{ id: "note_1", text: "no, use the second link", at: now - 12_000 }], { now });
  assert.equal(block, "[human, typed in the browser 12s ago] no, use the second link");
});

test("a pasted multi-line note cannot break the footer shape", () => {
  const now = 1_700_000_000_000;
  const block = noteBlock([{ id: "note_1", text: "  first line\n\nsecond   line\t ", at: now }], { now });
  assert.equal(block, "[human, typed in the browser just now] first line second line");
  assert.equal(block.split("\n").length, 1);
});

test("noteBlock caps the lines and admits the rest", () => {
  const now = 1_700_000_000_000;
  const notes = Array.from({ length: 7 }, (_, i) => ({ id: `note_${i}`, text: `step ${i}`, at: now }));
  const block = noteBlock(notes, { now, max: 3 });
  assert.equal(block.split("\n").length, 4);
  assert.match(block, /…and 4 more$/);
});

test("an evicted cursor is announced, not swallowed", () => {
  const now = 1_700_000_000_000;
  const block = noteBlock([{ id: "note_1", text: "go left", at: now }], { now, cursorUnknown: true });
  assert.match(block, /^\[bwb\] notes were dropped before delivery/);
  assert.match(block, /go left$/);
});

// ─── HTTP client ────────────────────────────────────────────────────────────

test("getNotes sends the token and parses the page", async (t) => {
  const relay = await fakeRelay(() => ({
    json: { notes: [{ id: "note_9", text: "stop", at: 1 }], cursor: "note_9", cursor_unknown: false },
  }));
  t.after(relay.close);

  const page = await getNotes({ port: relay.port, token: "tok-123456789", after: "note_8" });
  assert.deepEqual(page.notes.map((n) => n.id), ["note_9"]);
  assert.equal(page.cursor, "note_9");
  assert.equal(page.cursor_unknown, false);
  assert.equal(page.unsupported, false);
  assert.equal(relay.requests[0].query.after, "note_8");
  assert.equal(relay.requests[0].token, "tok-123456789");
});

test("an app without the note channel is unsupported, not broken", async (t) => {
  const relay = await fakeRelay(() => ({ status: 404, json: { error: "not_found" } }));
  t.after(relay.close);

  const page = await getNotes({ port: relay.port, token: "tok", after: "note_1" });
  assert.deepEqual(page.notes, []);
  assert.equal(page.unsupported, true);
  assert.equal(page.cursor, "note_1", "the cursor must survive a 404");
});

test("postNote returns the queued id", async (t) => {
  const relay = await fakeRelay((req) => {
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/bwb/note");
    return { status: 201, json: { id: "note_abc", at: 1_700_000_000_000 } };
  });
  t.after(relay.close);

  const queued = await postNote("  no, the second link  ", { port: relay.port, token: "tok" });
  assert.equal(queued.id, "note_abc");
  assert.equal(relay.requests[0].body.text, "no, the second link", "trimmed before it leaves");
});

test("postNote surfaces the app's typed refusal", async (t) => {
  const relay = await fakeRelay(() => ({
    status: 400,
    json: { error: `note_too_long:${MAX_NOTE_CHARS} chars` },
  }));
  t.after(relay.close);

  await assert.rejects(
    () => postNote("x".repeat(MAX_NOTE_CHARS + 1), { port: relay.port, token: "tok" }),
    /note_too_long/,
  );
  assert.equal(relay.requests.length, 0, "too long is rejected locally, no round trip");
});

test("an empty note never reaches the phone", async (t) => {
  const relay = await fakeRelay(() => ({ status: 201, json: { id: "note_x" } }));
  t.after(relay.close);

  await assert.rejects(() => postNote("   \n ", { port: relay.port, token: "tok" }), /note_empty/);
  assert.equal(relay.requests.length, 0);
});

test("postNote on an old build says so instead of throwing an HTTP code", async (t) => {
  const relay = await fakeRelay(() => ({ status: 404, json: {} }));
  t.after(relay.close);

  await assert.rejects(
    () => postNote("hello", { port: relay.port, token: "tok" }),
    /no note channel/,
  );
});

// ─── Feed: cursor, dedupe, silence ──────────────────────────────────────────

test("a note is delivered exactly once", async (t) => {
  const cursorPath = tempCursor(t);
  const now = 1_700_000_000_000;
  let calls = 0;
  const feed = new NoteFeed({
    cursorPath,
    fetchNotes: async () => {
      calls++;
      return { notes: [{ id: "note_1", text: "go left", at: now }], cursor: "note_1", cursor_unknown: false };
    },
  });

  assert.equal(await feed.next(now), "[human, typed in the browser just now] go left");
  // A relay that keeps replaying the same buffer must not replay the note.
  assert.equal(await feed.next(now), "");
  assert.equal(calls, 2, "the second call asked, then dropped the duplicate");
  assert.equal(readNotesCursor(cursorPath), "note_1");
});

test("the cursor survives a restart", async (t) => {
  const cursorPath = tempCursor(t);
  assert.equal(writeNotesCursor("note_7", cursorPath), true);
  assert.equal(readNotesCursor(cursorPath), "note_7");

  const seen = [];
  const feed = new NoteFeed({
    cursorPath,
    fetchNotes: async (after) => { seen.push(after); return { notes: [], cursor: after, cursor_unknown: false }; },
  });
  assert.equal(await feed.next(), "");
  assert.deepEqual(seen, ["note_7"], "a restart resumes instead of replaying the buffer");
});

test("a corrupt cursor file degrades to a fresh start", async (t) => {
  const cursorPath = tempCursor(t);
  writeNotesCursor("note_1", cursorPath);
  // Hermes-style truncation: valid JSON is not guaranteed on a phone that died.
  const { writeFileSync } = await import("fs");
  writeFileSync(cursorPath, "{", "utf8");
  assert.equal(readNotesCursor(cursorPath), null);
});

test("a failing relay costs one tool result, then goes quiet", async (t) => {
  let calls = 0;
  const feed = new NoteFeed({
    cursorPath: tempCursor(t),
    quietMs: 60_000,
    fetchNotes: async () => { calls++; throw new Error("ECONNREFUSED"); },
  });

  assert.equal(await feed.next(1_700_000_000_000), "");
  assert.equal(await feed.next(1_700_000_000_100), "");
  assert.equal(calls, 1, "no retry inside the quiet window");
});

test("an unsupported build goes quiet instead of paying a 404 per call", async (t) => {
  let calls = 0;
  const feed = new NoteFeed({
    cursorPath: tempCursor(t),
    quietMs: 60_000,
    fetchNotes: async () => { calls++; return { notes: [], cursor: "", cursor_unknown: false, unsupported: true }; },
  });

  assert.equal(await feed.next(1_700_000_000_000), "");
  assert.equal(await feed.next(1_700_000_000_100), "");
  assert.equal(calls, 1);
});

test("an evicted cursor warns on the delivered block", async (t) => {
  const feed = new NoteFeed({
    cursorPath: tempCursor(t),
    fetchNotes: async () => ({
      notes: [{ id: "note_99", text: "wrong tab", at: 1_700_000_000_000 }],
      cursor: "note_99",
      cursor_unknown: true,
    }),
  });

  const block = await feed.next(1_700_000_000_000);
  assert.match(block, /notes were dropped before delivery/);
  assert.match(block, /wrong tab$/);
});

test("no notes, no block, no placeholder", async (t) => {
  const feed = new NoteFeed({
    cursorPath: tempCursor(t),
    fetchNotes: async () => ({ notes: [], cursor: "note_5", cursor_unknown: false }),
  });

  assert.equal(await feed.next(), "");
  assert.equal(readNotesCursor(feed.cursorPath), "note_5", "a clean empty page still advances");
});
