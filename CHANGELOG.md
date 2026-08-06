# Changelog

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
