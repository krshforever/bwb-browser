# Changelog

## 4.0.2 — "It was quietly doing the wrong thing"

A deep review of 4.0.1 found the two flagship features were silently wrong, and that a handful of security holes mattered more than usual for a tool an LLM points at pages it does not control. This release is the fixes. Most of it is `Fixed`, because most of it was broken.

### The bugs that mattered (each reproduced before the fix, each covered by a test)

- **`browser_act` typed everything in lowercase.** Every pattern matched `instruction.trim().toLowerCase()` and then typed or navigated the captured group, so `fill password with MyS3cretPass` sent `mys3cretpass` (and echoed it back to the model), and `go to GitHub.com/Krish/Repo` navigated to `github.com/krish/repo`. Matching is case-insensitive now; the text that gets typed keeps its case.
- **`browser_act` clicked the wrong element.** The finder returned a CSS selector and the caller re-queried it, so `a` matched the first link: "click the Pricing link" reported `clicked: "Pricing"` and dispatched a mouse event at **Home**. `data-testid` also produced the invalid selector `["checkout-btn"]` instead of `[data-testid="checkout-btn"]`. Scoring, filtering, scrolling, measuring and tagging now all happen inside one `Runtime.evaluate`, against one element.
- **Element matching was mostly documented fiction.** `aria-label`, `title`, `value` and hidden-node filtering were half-supported, and the "exact match is best" comment sat above a loop that returned on the first element whose text merely *contained* the query, in document order — so "click login" hit "Login with Google" before "Login". All candidates are scored now (exact > startsWith > contains > fuzzy), the smallest/leafmost element wins, `html`/`body`/`script`/`style` are excluded, and **if the top two scores are within 2 points it returns `candidates` instead of guessing**.
- **`browser_act "search for X"` typed into whatever input was first on the page** — a newsletter email field, then pressed Enter — because the finder fell back to "first input" and made the real search fallbacks unreachable. Search now only matches search-shaped inputs, and an unknown target returns the candidate list.
- **`fill`/`type` appended instead of replacing.** `focus()` alone does not clear a field, and the Ctrl+A was sent as raw key events with no `modifiers` bit, so it did nothing; only plain inputs survived, via `el.value = ''`. Now `el.select()` / `execCommand('selectAll')` before `insertText`.
- **Static fetch corrupted every multibyte page.** `html += Buffer.from(value).toString("utf8")` decoded *each network chunk separately*, so any character straddling a chunk boundary became `U+FFFD`. Reproduced with a Devanagari page: **1,445 replacement characters**. Real servers split at arbitrary byte offsets, so this hit Hindi/CJK/emoji pages at random. Chunks are concatenated as bytes and decoded once, honouring the declared charset (header, then `<meta charset>`).
- **Static fetch had no body timeout.** `clearTimeout` ran in a `finally` as soon as *headers* arrived, so a server that sent headers and then trickled bytes hung past the configured timeout (reproduced: >7s with `timeout: 2000`). The abort timer now covers the body read.
- **Static fetch escalated to Chromium for JSON, XML, CSV and a 31-byte `robots.txt`** — precisely the cases v4 exists to avoid. Those types are served verbatim now, with no Readability and no "too thin" heuristic.
- **`browser_goto` (static) and every other tool saw different pages.** After `mode:"static"` nothing was navigated, so `browser_text` / `browser_click` / `browser_screenshot` / `browser_act` all spawned Chromium on `about:blank` and returned nothing — while the response itself said "use browser_screenshot, that escalates". Escalation did not navigate. It does now: the static URL is carried across and materialized by the first tool that needs a live page.
- **The static rung ignored loaded cookies.** `browser_loadCookies("gmail")` then `browser_goto(gmail)` returned the logged-**out** page with `confidence: "high"`, and the agent concluded it was logged out. Once cookies are loaded, static fetches are skipped for the rest of the run.
- **`browser_listTabs` lied after a static goto**: `syncActiveTab` was called with the static URL while the real tab was elsewhere.
- **`browser_text` returned `textContent`** — `<script>` and `<style>` bodies, hidden nodes — while describing itself as "visible text". Now `innerText`, with a `maxChars` cap and `truncated`/`nextOffset`.
- **`browser_eval` could not await.** No `awaitPromise`, so `await fetch(...)` returned `{}` and agents concluded their script had done nothing.
- **`browser_watch` leaked listeners and went stale.** The `chrome-remote-interface` unsubscribe functions were discarded, so `cleanupWatch()` removed nothing, `start` twice duplicated every event, and listeners stayed bound to a switched-away or closed tab. `Page.frameNavigated` was also subscribed without `Page.enable()`, so navigation events never arrived at all. `start` is idempotent now, and switching tabs or restarting stops the capture.
- **`browser_diagnose` killed an active watch.** `Runtime.enable()` does *not* throw when already enabled, so the "was it already enabled?" probe always answered no and the handler always called `Runtime.disable()` — silently stopping console capture.
- **`browser_download` refused any URL containing the letter "s".** The validator was `/^https?:\/\/[^\\s"';`$(){}|&<>]+$/i`, where `\\s` inside a character class is a literal backslash **and the letter s**: `https://x.com/user/status/123` was rejected, `https://www.instagram.com/p/abc/` was rejected, while `https://example.com/a b` was accepted. It also still built a shell string.
- **CLI booleans swallowed the next argument.** `--nuclear --lean true` produced `{nuclear: true}` — `--lean` was eaten as `--nuclear`'s value. `--port abc` became `NaN` → a random port. Unknown flags were ignored silently.
- **`gotoUrl` reported the URL it was asked for**, ignored `Page.navigate`'s `errorText` (a DNS failure returns normally), and resolved silently on timeout.
- **Clicks could silently miss** — no `scrollIntoView`, no visibility check, no `elementFromPoint` verification — and still reported success.
- **`browser_waitForSelector` aborted on navigation**: "Execution context was destroyed" is thrown by design mid-navigation, and it was uncaught.
- **Tab lifecycle.** Hibernating the default tab closed its target but left the *global* connection pointing at it, so the next call got a dead protocol. The tab-cap loop could `CDP.Close` **real user tabs** in attach mode. The oom-guard could tear the browser down mid-task, losing form state and scroll.
- **Screenshots overwrote each other** (second-level timestamp) and were never pruned — on Android that is the public Download folder.
- **The resource footer ran `ps -o … -e` synchronously on every tool call**, blocking the event loop (including `browser_watch` handlers) and listing every process on the box. Now async, cached for 5s.
- **`restartBrowser` could return `undefined`**, producing `text: undefined` — malformed MCP content.
- **`browser_export` wrote anywhere.** Any `output_path`, including `~/.bashrc`.
- **`browser_export` lied about pdf/docx/pptx**: `{ready: true}`, and nothing written.
- **`bwb --setup` wrote `mcpServers` into `~/.claude/settings.json`** — which Claude Code does not read for MCP ([#4976](https://github.com/anthropics/claude-code/issues/4976), [#26167](https://github.com/anthropics/claude-code/issues/26167)) — and then printed "✅ Claude Code: configured". It also edited up to eight other tools' config files with no confirmation and no dry run, overwrote a single `.bak` on every re-run, reformatted files with `JSON.stringify` (comments lost), and resolved `HOME` as `process.env.HOME || '/root'` — so on Windows it looked in a directory nobody has.
- **`run.sh`** pointed at `server.js` (the file is `server.mjs`) and hardcoded a Termux `NODE_PATH`. Deleted; `bin/bwb` is the entry point.

### Security

- **URL policy** (`lib/urlpolicy.mjs`), applied to goto, newTab, act-navigation, download and every static fetch *including each redirect hop*: `file:`, `javascript:`, `data:`, `chrome:`, `devtools:`, `view-source:` refused; loopback / private / link-local / CGNAT (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`) refused unless `BWB_ALLOW_PRIVATE=1`. Before this, `browser_goto("file:///etc/passwd")` fell through to `Page.navigate` and `browser_text` read the file back — reachable by telling the agent "summarise file:///home/you/.bwb/sessions/gmail.json" — and the static rung happily fetched `127.0.0.1`, or `169.254.169.254` on a cloud box.
- **The Chromium sandbox stays on.** 4.0.1 passed `--no-sandbox --disable-setuid-sandbox` on *every* platform, removing the main containment for a browser rendering pages an LLM chose from untrusted content. Now applied only on Termux, as root, or with `BWB_NO_SANDBOX=1`.
- **Secrets at rest.** Session cookies were written with the default umask (world-readable) into a `0755` directory, holding live logins for every visited domain. Now `0600` inside `0700`, with an optional `domains` filter. The tab journal stored full URLs — OAuth callbacks, magic links, reset tokens — and re-navigated them on every spawn, even on desktop and even for an unrelated task. Now origin + path only, and desktop spawns no longer replay stale entries (`--journal-full` restores the old behaviour).
- **No shell in new paths.** `ps`/`which` are read via `execFile` and filtered in JS (the old pipeline interpolated `userDataDir` into a shell string, escaping only `"` and `\`, and did not exist on Windows); `yt-dlp` runs via `execFile` with `--`; a profile lock file stops two agents sharing a user-data-dir from killing each other's browser.
- **`--readonly` / `BWB_READONLY=1`** disables every state-changing tool. **`--allow-domains`** restricts navigation to a host list.
- **`browser_act` refuses destructive clicks** ("Delete account", "Buy now", "Send", …) with `needs_confirmation` unless `force:true`.

### New

- `browser_goto` takes `mode: "auto" | "static" | "browser"`, `maxChars` and `raw`.
- `browser_saveCookies` takes `domains` and warns that the file is a credential.
- `browser_text` / `browser_html` take `maxChars`; `browser_setViewport` takes `reset`.
- `browser_act` takes `force`. `browser_eval` takes `timeout`.
- Config flags: `--readonly`, `--allow-domains`, `--always-browser`, `--no-sandbox`, `--journal-full`, `--confirm-destructive`. `bwb --setup` is a **dry run unless you pass `--yes`**.
- Static results carry `links` (first 40), so an agent can navigate without a browser.

### Changed / removed

- `browser_export` lost `pdf` / `docx` / `pptx`. They reported success and wrote nothing; rather than ship a lie, the enum ends at md/txt/html, and writes are confined to the export directory with an extension allowlist and no silent overwrite.
- `browser_fingerprint` no longer hardcodes `Chrome/126 … Linux x86_64`, which contradicted `navigator.platform` and `userAgentData` and made it *more* detectable on Termux ARM. The UA is derived from `Browser.getVersion()` with matching metadata. The docs no longer call this "not stealth mode" — it is the standard anti-detection patch set, intended for testing sites you own.
- `browser_diagnose`'s score is documented as a heuristic, not a Lighthouse grade.
- Screenshots get millisecond + random filenames, and the newest `BWB_SHOT_KEEP` (default 50) are kept.
- Tool descriptions rewritten to state return shapes and failure modes. "GROUNDBREAKING" is gone — marketing in model-facing text is a cost, not a feature.

### Testing

- `npm test` was `node --check server.mjs && node --check lib/*.mjs`. `node --check` takes **one** file, so the shell expanded the second path and only the first was ever checked: a syntax error anywhere in `lib/` exited **0**. There were no tests at all.
- Now: `npm test` → `node --test test/`, `npm run lint` (every file), `npm run smoke` (boots the real server over stdio — tool count, URL policy, export confinement, `--readonly`), and CI on Node 18/20/22 with a hard 26-tool gate.
- `jsdom` is a devDependency for tests only. No new runtime dependency.

### Docs

- Size numbers corrected everywhere (~174KB source, 64 kB tarball, 5 runtime dependencies) instead of "136KB", "zero-dependencies", "30KB, 11 tools".
- "raw CDP" → "CDP over one thin client (`chrome-remote-interface`); no Playwright, no Puppeteer". There was always a CDP client; there was never a browser binary.
- README gained a **Security Notes** section; AGENTS.md's was expanded with the real posture, including the prompt-injection warning.
- Windows and Docker downgraded from "✅ Verified" to "supported, untested" — orphan-kill, process sampling and setup depend on `ps`/`which`.
- `BENCHMARKS.md`'s stale v1 table was rewritten, and its "Roadmap to v2.0 (Monetization Path): paid Pro licence, CAPTCHA handling, proxy rotation" was removed: it contradicted the README's "No gating. No pro tier. No bait-and-switch." Either the roadmap or the promise was a lie. The promise stands.

## 4.0.1 — "Guest Mode"

### New: attach mode (`--attach-port` / `BWB_ATTACH_PORT`)
- Attach to an already-running browser's CDP port (e.g. `9222`) instead of spawning headless. bwb becomes a guest: no spawn, no orphan-kill, no journal restore on connect, no auto-shed of foreign tabs (pressure is reported in the footer; the human closes their own tabs).
- `browser_status` reports `attached: true` + `profile.attached: <port>`; `stopBrowser`/`restartBrowser` disconnect only, never kill. `pid` stays `null` (foreign process, untracked).
- Use case: drive the window you're looking at — `BWB_ATTACH_PORT=9222 bwb` then `browser_newTab` opens a VISIBLE tab.

### Fixed
- Runtime browser detection (`findBrowserPath`) missed Brave while `--setup` already detected it — static mode worked but any CDP escalation failed with "Browser not started" on Brave-only machines. `brave-browser`, `brave`, `/usr/bin/brave-browser` added to linux candidates.

## 4.0.0 (2026-09-10) — "Lightweight Like Air"

> *"We tried and failed, again and again. Shipped lean, watched Android kill it anyway.*
> *Watched the battery drain overnight. Watched a single YouTube tab eat 746MB.*
> *So we stopped asking the browser to be light — and started asking whether*
> *the browser needs to be there at all. It usually doesn't."*

### The story
- v1–v3 made the **server** light (136KB source, zero browsers bundled) — then spawned Chromium for everything, including reading a README. Android's LMK killed whole Termux sessions mid-run, 15 minutes to 2 hours into overnight agent loops. WakeLocks didn't help; the footprint did it.
- v4 inverts the default: **static-first fetch ladder.** Plain pages are fetched + extracted with zero Chromium (no process, no LMK risk, milliseconds). The browser spawns only when JS demands it — and on lean profiles it lives like a mayfly: capped tabs, idle teardown, journaled working set, transparent resurrection.
- Measured, not claimed: single YouTube tab = **746MB Chromium tree** on-device (this number ended two verification sessions via OOM — the feature it motivated then proved itself by cleaning up with zero strays).

### New: fetch ladder (Glyph merge, scoped)
- `lib/fetch.mjs` — plain-HTTP + `@mozilla/readability` extraction, lazy-loaded deps (zero persistent RAM until first use). 2MB body cap, auth-wall + JS-shell detection.
- `browser_goto` tries static first (`mode: "static"`), escalates to CDP (`mode: "browser"`, reason included), hard-errors dead URLs **without spawning anything**.
- Ported the information tools' *behavior*, not their weight: research/extract/summarize ride the ladder. `download_media`/`export_results` ship as `browser_download`/`browser_export` — **verbs, not deps** (probe-and-consent, zero bundled weight, no silent installs).

### New: vigilance system
- Every tool response carries a `[bwb resources]` footer (MCP MB + Chromium MB + tabs + state). `browser_watch` poll streams memory samples on the existing rhythm.
- Thresholds act, then report: critical pressure hibernates oldest tabs, tears down at one tab, journals everything. The agent reads about the save — never discovers the OOM.
- Budgets: 300/450MB (lean: Termux auto-detect, 1GB VPS) vs 1024/1536MB desktop. Override via `BWB_WARN_MB`/`BWB_CRIT_MB`.

### New: survival profile
- `--lean` (auto on Termux): renderer cap, silenced background services, 64MB disk cache, 256MB JS heap cap. `--nuclear` opts into `--single-process` (max saving, min stability — your funeral, your flag).
- Mayfly teardown: `--idle` (default 5min lean, off desktop), suppressed while `browser_watch` records. Tab journal (`bwb-tabs.json`) + capped lazy restore — resurrection reopens the working set, never re-spikes at startup.
- `bwb --setup` prints a survival guide (incl. the honest note that WakeLock doesn't stop LMK).

### Breaking (major version)
- `browser_title` + `browser_url` removed — both already covered by `browser_status.targets`. Net tool count: **still 26**.
- Tool count budget is now a release gate: v4 ships ≤26 tools.

### Numbers (measured, `npm pack --dry-run` + `du`)
- Tarball **38.8 kB** (budget was ≤60) / unpacked 138.1 kB / source ~136KB
- Deps 3 → 5, all pure JS, zero native modules (`@mozilla/readability` 0 deps; `linkedom` light DOM)
- Install weight ~62MB via npm ( SDK drift owns most of it; our addition ≈7MB) — the old "~1MB install" claim is retired; the comparison that matters (no bundled browser, no 250–400MB) stands

## 3.2.0 (2026-08-06) — "The Correctness Patch"

> *"Surgery, not reboots. Every tool verified live, not just syntactically."*

### New Feature
- **`browser_screenshot({ selector })`** — capture just one element (a form, a chart, a product card) via bounding-rect clip. Verified live on real pages.

### Fixed (from @netzro's PR #1 review — credit to the Hermes Agent)
- `killOrphanedChrome()` now SIGTERM → 1s grace → SIGKILL **and scoped to bwb's own `--user-data-dir`** — it can no longer kill another agent's Chrome
- `lib/diagnose.mjs` — `Runtime.enable`/`disable` now tracked as a single pair (events were left uncollected after an enable)
- `lib/helpers.mjs` — `waitForSelector` dead-code branch collapsed
- `lib/fingerprint.mjs` — `window.chrome.runtime` deletion replaced with safe `Object.defineProperty` getter (strict-mode-proof)
- `server.mjs` — screenshot directory auto-detect: Android/Termux → `/storage/emulated/0/Download/bwb-screenshots`, otherwise `~/bwb-screenshots` (override with `BWB_SCREENSHOTS_DIR`)

### Fixed (found live during verification)
- **`browser_act` navigation regex** — greedy match swallowed compound instructions ("go to X and read the title" now navigates instead of failing)
- **`browser_act` fill-swap bug** — "fill X with Y" and "type Y in X" had inverted semantics; now target/text are correct
- **`browser_act` search anchoring** — unanchored `search` pattern could hijack "fill search with X"
- **`browser_back`** — now uses native `Page.getNavigationHistory()` + `navigateToHistoryEntry` (the bundled CDP 1.3 protocol has no `Page.goBack`; the old JS `history.back()` hack is gone). History returns flat (`{currentIndex, entries}`), not nested — verified with real two-step back navigation.
- **`browser_restart`** — calls `cleanupWatch()` so watch listeners never outlive the dying protocol
- **`browser_status`** — port lookup uses the real bound port (`actualCdpPort || cfg.port`); removed the hardcoded 9222 poke that could probe another tool's browser

### Docs
- Tool count corrected everywhere: it's **26 tools**, not 25
- README upgraded with the selector-screenshot feature and accuracy fixes

### Quality
- Behavioral verification, not just syntax: multi-step single-browser scenario suite all-green (navigate → watch start/poll/stop → diagnose → element screenshot → restart → post-restart fill)
- Safety: pre-surgery tag `safety-v3.1.1-pre-320` + full backup tree

## 3.1.1 (2026-07-29)
- Fix: version now reads dynamically from package.json — no more hardcoded version drift
- `--version` and `--help` always show the real version

## 3.1.0 (2026-07-29) — "One Command to Rule Them All"

> *"npm install -g bwb-browser && bwb --setup. That's it. That's the tweet."*
>
> From now on, no agent gets stuck configuring bwb. Zero CLI battles. Five seconds to browser superpowers.

### Added
- **`bwb --setup`** — one-command auto-configuration. Detects every AI agent on your machine (OpenCode, Antigravity, Claude Code, Hermes, Cline, Continue.dev, Codex CLI), writes the correct MCP config, verifies Chrome/Chromium. Run once, done.
- `lib/setup.mjs` — modular setup engine with per-agent config detection, JSON backup, and safe write

### Changed
- AGENTS.md overhauled: "Zero-Config Install (5 seconds)" replaces old manual copy-paste instructions
- `server.mjs` now handles `--setup` flag before starting MCP server

### Quality
- Manual test: `bwb --setup` detected 4 installed agents, configured 1 new, skipped 4 not-found
- All existing 62 tests pass

## 3.0.0 (2026-07-28) — "Browser Without Bloat"

> *"Hey, let's run this on a phone." — Krish, probably*
>
> The big one. 10 new tools. Modular architecture. Natural language. Multi-tab. Sessions that persist longer than your attention span. 62 tests. Zero regrets.

### Breaking Changes
- `browser_stealth` → renamed to `browser_fingerprint` (better framing)
- Module split: `server.mjs` → 8 files under `lib/`

### Added (10 new tools)
- **`browser_act`** — natural language page interaction ("search for x", "click the button", "what's on this page")
- **`browser_diagnose`** — full page health check (performance, errors, broken images, score)
- **`browser_fingerprint`** — realistic browser profile for testing (replaces `browser_stealth`)
- **`browser_waitForSelector`** — wait for element to appear/disappear with timeout
- **Multi-tab**: `browser_newTab`, `browser_closeTab`, `browser_switchTab`, `browser_listTabs`
- **Session persistence**: `browser_saveCookies`, `browser_loadCookies`, `browser_listSessions`
- **`browser_restart`** — clean browser restart with fresh state

### Changed
- Monolithic `server.mjs` (928 lines) → 8 modular files under `lib/`
- Fixed: browser restart now clears tab state to prevent stale CDP connections
- Fixed: `ensureDefaultTab()` no longer hangs after restart
- README overhaul with accurate size claims and repositioned fingerprint feature
- AGENTS.md updated to v3.0.0

### Quality
- 62 integration tests: 29 core + 15 new-tool + 18 v3-feature
- 0 npm vulnerabilities
- 5-axis code review applied: double-click fix, orphan Chrome protection, OOM protection

## 2.0.4 (2026-07-28)
- Fix: `browser_setViewport` — use `Emulation.setDeviceMetricsOverride` instead of `Page.setViewport` (Termux fix)

## 2.0.3 (2026-07-28)
- Upgraded README with hero feature, demo results, comparisons, agent credits

## 2.0.2 (2026-07-28)
- Fix: package.json dedup, include AGENTS.md in tarball

## 2.0.1 (2026-07-28)
- Rename: `bwb-browser-termux` → `bwb-browser`
- Groundbreaking: `browser_watch` — live page event capture (first MCP browser tool with this capability)

## 2.0.0 (2026-07-28)
- Initial rename release. 15 tools, monolithic server.mjs

## 1.x — `bwb-browser-termux` (deprecated)

11 versions published under old package name. All deprecated — migrate to `bwb-browser`.

### 1.1.1 — 1.0.0
- Initial development: browser lifecycle, CDP integration, navigation, screenshots, eval, click, fill
- Concurrent call handling, crash recovery, orphan cleanup
- Cross-platform browser detection
