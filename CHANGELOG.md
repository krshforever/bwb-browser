# Changelog

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
