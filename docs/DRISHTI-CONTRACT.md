# BWB Control Contract — v1.1

> **This file is the single source of truth.** It lives in `drishti` at
> `docs/BWB-CONTRACT.md` and is copied verbatim to `bwb-browser` as
> `docs/DRISHTI-CONTRACT.md`. The JSON fixtures under `contract/fixtures/`
> (same relative path in both repos) are the executable form of this document.
> Both test suites assert against those fixtures; neither repo gets to have its
> own opinion about the wire format.
>
> **Bump rule.** Any change to a path, field, status code, or semantic rule
> bumps `contract` in `/bwb/hello`, in every fixture, and in this header. A
> client that needs a field we do not have is not "handled by tolerance" — it is
> a contract bump.

**Version:** 1.1 · **Transport:** HTTP/1.1 over loopback only, `127.0.0.1:9222`.

---

## 0. Rules that apply to every endpoint

1. **Loopback only.** The relay binds `127.0.0.1`. Nothing here is reachable
   from the network, and adding a bind-address option is a breaking change.
2. **Auth.** Every endpoint except `GET /bwb/hello` accepts the same token as
   CDP, in any of three forms:
   - `X-BWB-Token: <token>` (preferred — never lands in a URL log)
   - `Authorization: Bearer <token>`
   - `?token=<token>` (kept for CDP compatibility; stripped before proxying)
   Missing or wrong token → `401 {"error":"Unauthorized"}`. Token comparison is
   constant-time. The token is never logged, never echoed in a response body,
   and never appears in `/bwb/hello`.
3. **Unknown fields are allowed.** A response may gain fields; clients must
   ignore what they do not know. Removing or renaming a field is a bump.
4. **Errors are JSON.** Every non-2xx response has a body that names the reason:
   `{"error":"<human sentence>"}`, which a client may show to a human verbatim.
   The one exception is the pairing poll (§2), whose `status` field is itself
   the reason (`denied` / `expired`) — it must not be wrapped in `error`.
5. **Bodies are capped at 64 KiB.** Larger → `413`.
6. **`/bwb/*` is never proxied.** The relay answers these itself and closes the
   connection; they do not reach the WebView DevTools socket.
7. **Fire-and-forget means fire-and-forget.** `POST /bwb/status` may be dropped
   under load, but it must never block a CDP command or fail a tool call.
8. **Secrets never cross the wire.** No password values, no cookie values, no
   tokens. Credential fill is performed by the app after user approval.
9. **Capability enforcement.** Drishti enforces capabilities in the relay.
   If a client attempts a command for a disabled capability, the relay rejects
   it with CDP error `-32000` `"capability_disabled:<name>"` and logs a line.
   `bwb` never decides this alone; `bwb` registers MCP tools only for enabled
   capabilities (`"core"` is always on).
10. **Idle disconnect.** After N seconds with no agent traffic
    (`idle_disconnect_sec`), Drishti ends the agent session (token stays valid,
    tabs untouched, wake lock released). `bwb` may request a shorter value via
    `POST /bwb/limits`, never longer.

---

## 1. `GET /bwb/hello` — who are you? (no auth)

```http
GET /bwb/hello
```

`200 OK`

```json
{
  "app": "drishti",
  "version": "1.0.0",
  "contract": 1,
  "paired": false,
  "capabilities": [
    "core",
    "history",
    "downloads",
    "tabs",
    "network",
    "cookies_meta",
    "emulation",
    "upload",
    "clipboard"
  ],
  "limits": {
    "idle_disconnect_sec": 900,
    "relay_off_sec": 0
  }
}
```

| field | type | meaning |
|---|---|---|
| `app` | string | **must** be the literal `"drishti"`; this is what auto-detect keys on |
| `version` | string | app version, free-form |
| `contract` | int | contract version this build speaks |
| `paired` | bool | whether the app currently holds a client pairing |
| `capabilities` | string[] | list of currently enabled capability names |
| `limits` | object | session limits currently enforced by the app |
| `limits.idle_disconnect_sec` | int | seconds of no traffic before agent session ends (0 = never). App default **900**; the settings picker offers `300`, `900`, `1800`, `3600`, `0`. |
| `limits.relay_off_sec` | int | seconds of idle before relay server turns off (0 = never) |

### Capabilities
- `"core"`: always on. Basic navigation, DOM inspection, clicking, keyboard input, screenshotting.
- Optional capabilities configurable in app Settings:
  - `"history"`: navigation history traversal.
  - `"downloads"`: managing and initiating file downloads.
  - `"tabs"`: opening and closing browser tabs via `/bwb/tab` and CDP target domain.
  - `"network"`: network inspection and header customization.
  - `"cookies_meta"`: cookie metadata inspection (names, domains, paths, expiration). Cookie values are NEVER sent.
  - `"emulation"`: viewport, user agent, and device emulation.
  - `"upload"`: file input uploads.
  - `"clipboard"`: clipboard reading or writing.

No token is required and no secret is returned.

---

## 2. `GET /bwb/pair?code=<code>` — pairing (no auth, **non-blocking**)

```http
GET /bwb/pair?code=7QK2M9XA
```

The app announces the code out-of-band (`am start -a com.bwb.drishti.PAIR --es
code <code>`), shows a dialog, and the human taps **Allow** or **Deny**. The
client polls this endpoint **once per second for at most 60 seconds**.

| status | body | when |
|---|---|---|
| `202` | `{"status":"pending"}` | code is known and still waiting for the human |
| `200` | `{"status":"approved","token":"<32 hex>"}` | approved. Returned **once**; the code is burned |
| `403` | `{"status":"denied"}` | the human tapped Deny |
| `410` | `{"status":"expired"}` | 60 s elapsed, or the code is unknown/already used |

Rules:

- **The endpoint never waits.** It answers immediately, always. Blocking here
  is what made v0 pair clients race their own timeout.
- Approval is bound to the exact code, within 60 s of registration, and the
  token is returned at most once. A second `200` for the same code is a bug.
- A code is burned on success, on deny, and on expiry. Codes are single-use.
- On `200` the app records `pairedAt`, a client label, and persists the token.
- `code` missing or blank → `400 {"error":"Missing code parameter"}`.

Client algorithm (normative):

```
for i in 0..59:                       # once per second
    r = GET /bwb/pair?code=<code>
    if r.status == 200: store(r.token); done
    if r.status in {403, 410}:        fail(r.json.error or r.json.status); done
    if r.status != 202:               fail
sleep(1s)
fail("pairing timed out")
```

---

## 3. `POST /bwb/status` — what is the agent doing? (auth)

```http
POST /bwb/status
Content-Type: application/json

{ "step": "Clicking #submit", "tool": "browser_click", "state": "working" }
```

`204 No Content` — no body. Always `204`, even if there is no UI listening.

| field | type | notes |
|---|---|---|
| `step` | string | plain human sentence for the phone's status line |
| `tool` | string | tool name, for grouping |
| `state` | enum | `working` \| `idle` \| `error` |

**Never** send typed values, JS expressions, page content, URLs with query
strings, or credentials. The phone shows this text to a human. Malformed JSON →
`400`; oversized → `413`. Failures are invisible to the client by design.

---

## 4. `GET /bwb/state[?wait=N]` — control state (auth)

```http
GET /bwb/state          → answers immediately
GET /bwb/state?wait=8   → holds up to 8 s for a change
```

`200 OK`

```json
{ "mode": "AGENT",
  "help": null }
```

```json
{ "mode": "USER",
  "help": { "id": "help_17f3a1",
            "kind": "site",
            "reason": "Approve demoqa.com?",
            "domain": "demoqa.com",
            "status": "pending" } }
```

```json
{ "mode": "AGENT",
  "help": { "id": "help_17f3a1",
            "kind": "site",
            "reason": "Approve demoqa.com?",
            "domain": "demoqa.com",
            "status": "resolved",
            "approved": true } }
```

| field | type | notes |
|---|---|---|
| `mode` | enum | `"AGENT"` \| `"USER"` |
| `help` | object \| null | the current or most recent help request |
| `help.id` | string | stable id, also returned by `POST /bwb/help` |
| `help.kind` | enum | `"help"` (human task) \| `"site"` (domain approval) |
| `help.reason` | string | the sentence shown to the human |
| `help.domain` | string? | present for `kind:"site"` |
| `help.status` | enum | `"pending"` \| `"resolved"` |
| `help.approved` | bool? | present once resolved: `true` approved, `false` denied |

**Wait semantics.**

- No `wait` → immediate snapshot. This is the only form a UI should poll.
- `wait=N` → hold the response until **the mode changes** or **the help id or
  its status changes**, or until `N` seconds pass, then answer with the current
  state. `N` is clamped to `[0, 30]`; a non-numeric value means `0`.
- With no change inside `N`, the response is the unchanged state — this is not
  an error and not a timeout code.

**Client resume rule (normative).** After a `-32000` rejection or an `401`-free
block, the client may run the next step only when
`mode == "AGENT"` **and** `help` is `null` **or** `help.status == "resolved"`.
For `kind:"site"`, a `resolved` help with `approved:false` is a refusal, not a
retry.

---

## 5. `POST /bwb/help` — I need a human (auth)

```http
POST /bwb/help

{ "kind": "site", "reason": "Approve demoqa.com?", "domain": "demoqa.com" }
```

`200 OK`

```json
{ "id": "help_17f3a1" }
```

| field | type | notes |
|---|---|---|
| `kind` | enum | `"help"` \| `"site"` |
| `reason` | string | the sentence shown on the phone |
| `domain` | string? | required for `kind:"site"`, ignored otherwise |

Effects, in order: the help request becomes `pending`, control switches to
`USER`, a high-priority notification is posted, and a pending `/bwb/state`
long-poll returns. The human's **Hand back** resolves it with `approved:true`;
**Approve/Deny** resolves a site request with the matching boolean.

For `kind:"site"`, a resolved-and-approved help additionally adds `domain` to
the allowlist, so the retried command passes.

---

## 6. `POST /bwb/tab` — open a tab (auth)

```http
POST /bwb/tab

{ "url": "https://example.com" }
```

`200 OK`

```json
{ "id": "DB630DEA4F38B9519419837B5BFDF6DC" }
```

Required **only** because WebView has no `/json/new` (verified on device:
`PUT /json/new` → `500 Could not create new page`). `id` is the CDP page target
id of the tab that was created. `url` may be `null` for the app's new-tab page.

If the installed build cannot create tabs (UI layer not wired), it must answer
`501 {"error":"tab creation is not wired in this build"}` rather than pretending
or hanging. Clients translate `501`/`404` into "this build cannot open tabs"
and keep using the tab the human already has open.

---

## 7. `POST /bwb/limits` — request shorter session limits (auth)

```http
POST /bwb/limits
Content-Type: application/json
X-BWB-Token: <token>

{ "idle_disconnect_sec": 10 }
```

`200 OK`

```json
{ "idle_disconnect_sec": 10, "relay_off_sec": 0 }
```

| field | type | notes |
|---|---|---|
| `idle_disconnect_sec` | int | requested idle disconnect timeout in seconds |

Rules:
- `bwb` may request a **shorter** idle timeout than the app's setting, never longer.
- If requested `idle_disconnect_sec` is larger than the app's configured ceiling, returns `400 {"error":"Cannot request longer idle disconnect than app limit (<N>s)"}`.
- If accepted, updates session disconnect timer and answers `200` with effective limits.

---

## 8. CDP rejections the client reacts to

These are not `/bwb/*` responses; they are real CDP error frames emitted by the
relay, and they drive the state machine:

| code | message contains | client behaviour |
|---|---|---|
| `-32000` | `User has taken control` or `in USER mode` | call `GET /bwb/state?wait=30` until the resume rule holds, then retry the same step |
| `-32000` | `capability_disabled:<name>` | capability is disabled in Drishti settings; do not retry this command or register this tool |
| `-32001` | `Domain permission denied` | `POST /bwb/help {kind:"site",...}`, wait for resolved, retry once if approved |

Changing any of these strings is a contract bump.

---

## 9. Settings Screen Requirements (App Side)

The app Settings screen allows the user to configure:
1. **Per-capability toggles**:
   - `core` (always enabled, locked)
   - `history`
   - `downloads`
   - `tabs`
   - `network`
   - `cookies_meta`
   - `emulation`
   - `upload`
   - `clipboard`
2. **Idle timeout picker**:
   - Options: `5s`, `15s`, `30s`, `60s`, `Never` (0)
   - Default: `15s`

---

## 10. Persistence requirements (app side)

- The token, `pairedAt`, client label, capability preferences, idle timeout, and approved domains survive a process restart and a device reboot.
- The token is stored encrypted with an Android Keystore AES-GCM key; the ciphertext lives in `SharedPreferences`. No plaintext token on disk, no new dependency.
- **Open Mode is never persisted** — it is a 5-minute, per-session bypass.
- Revoke/Unpair regenerates the token, clears pairing and clears approvals. A retired token must fail with `401` immediately.

---

## 11. Fixtures

`contract/fixtures/*.json`, one file per case, checked against a
`contract/fixtures/MANIFEST.sha256` in **both** repos. Shape:

```json
{
  "contract": 1,
  "name": "pair-pending",
  "request": { "method": "GET", "path": "/bwb/pair?code=7QK2M9XA",
               "headers": {}, "body": null },
  "response": { "status": 202, "json": { "status": "pending" } }
}
```

Tests assert that the response **contains** every key/value in `response.json`
(a subset match, so an added field is not a failure) and that the status code
is exact. `null` bodies are asserted as empty. The same manifest hash must
appear in both repos; a mismatch means the contract was edited in one place and
is a failing test, not a merge conflict to resolve later.
