# bwb-browser

**Browser Without Bloat** — 136KB source. 26 tools. Static-first. Runs on your phone, survives it too.

A lightweight MCP server that gives any AI agent browser superpowers. Written by a guy in India on Termux because the existing tools were 200MB of "why" — then rewritten when Android kept killing those tools mid-run.

---

## v4: The Browser Starts Only When It Must

v1–v3 made the server light but spawned Chromium for everything — including reading a README. Android's out-of-memory killer ate whole Termux sessions for that. v4 inverts the default:

- **Static-first fetch ladder** — plain pages are fetched + extracted with zero Chromium. `browser_goto` returns `mode: "static"` in milliseconds. JS pages escalate to CDP automatically (`mode: "browser"` + reason). Dead URLs error without spawning anything.
- **Vigilance system** — every tool response carries a `[bwb resources]` footer. On critical pressure bwb hibernates tabs itself, tears down at one tab, journals everything, and tells the agent what it did.
- **Survival profile** — `--lean` auto-enables on Termux (capped renderers, 3-tab cap, 5-minute mayfly teardown, 256MB JS heap). Runs on a 1GB VPS. Your tabs resurrect from the journal after any kill.
- **On-demand capabilities** — `browser_download` / `browser_export` ship as verbs, not weight. Missing backends (yt-dlp, reportlab) prompt for consent install. Nothing heavy is ever bundled.

Measured on-device: a single YouTube tab costs **746MB** of Chromium tree. That's why the ladder exists.

---

## The Pitch (60 seconds)

Every other MCP browser tool ships a full browser binary. Playwright MCP? ~250MB. Puppeteer MCP? ~400MB. Chrome DevTools MCP? ~350MB.

bwb uses **raw Chrome DevTools Protocol (CDP)** — the same protocol Chrome speaks natively. It auto-detects the browser already on your system. No downloads. No binary mismatches. No "why is my disk full" panic.

| Factor | bwb v4 | Playwright MCP | Puppeteer MCP |
|--------|-----|----------------|---------------|
| Source size | **~136KB** | ~50MB+ | ~100MB+ |
| Published tarball | **38.8 kB** | — | — |
| Total install (npm) | **~62MB, zero browsers** | ~250MB | ~400MB |
| Bundled browser | **None** | Chromium (~200MB) | Chromium (~300MB) |
| Chromium spawns for plain pages | **Never (static-first)** | Always | Always |
| Works on Termux/Android | **✅ Yes** | ❌ | ❌ |
| Survives 1GB RAM / phone OOM | **✅ Lean profile + vigilance** | ❌ | ❌ |
| Zero native deps | **✅ Yes** | ❌ | ❌ |
| Live event streaming | **✅** | ❌ | ❌ |
| Natural language interaction | **✅** | ❌ | ❌ |
| Persistent sessions | **✅** | ❌ | ❌ |
| CPU profile at idle | Mayfly teardown (Termux) | 🐌 | 🐌 |

---

## 🔥 The Features That Actually Matter

### 1. `browser_act` — Talk to the Browser Like a Human

```javascript
browser_act({instruction: "search for laptops under a thousand dollars"})
```

No `findElement` hell. No chaining 10 calls. bwb parses what you want, finds the right elements, interacts, and returns the result. Pure DOM heuristics — no LLM dependency, no API costs, no "the AI is thinking..." spinner.

### 2. `browser_watch` — See What the Page Is Doing

This is the one feature nobody else has. Your agent can **listen** to the page:

```javascript
browser_watch({action: "start", events: ["console", "network"]})
// ... do stuff ...
const events = browser_watch({action: "poll"})
// → [{type: "console", text: "React mounted"}, {type: "network", url: "https://api.example.com/data", status: 200}]
```

Console logs. Network requests. JS exceptions. Page navigations. Your agent isn't flying blind anymore.

### 3. "Login Once, Agent Works for Days"

```javascript
// Monday: Login
browser_saveCookies({name: "gmail"})

// Wednesday: Still logged in. Fresh browser. Zero fuss.
browser_loadCookies({name: "gmail"})
browser_goto({url: "https://gmail.com"})  // Already authenticated
```

Sessions persist across agent restarts, server restarts, even across different machines.

### 4. `browser_diagnose` — Lighthouse for Your AI Agent

One call gets you: performance metrics, console errors, broken images, meta tags, interaction count, and a health score. Your agent can self-diagnose instead of guessing.

### 5. Multi-Tab & Sessions

Create tabs, close them, switch between them, save cookies, load them back. Like a real browser. Because it is one.

### 6. Realistic Browser Profile

Normalizes `navigator.webdriver`, plugins, languages, and user-agent for testing environments. Not "stealth mode" — just honest fingerprint normalization so your tests actually match real user conditions.

### 7. Element Screenshots

Capture just one element — a login form, a chart, a product card — not the whole page:

```javascript
browser_screenshot({selector: "#price-chart"})
browser_screenshot({selector: "h1"})           // The headline, cropped
browser_screenshot({fullPage: true})            // The whole page
browser_screenshot({})                          // Just the viewport
```

Every screenshot is saved to disk (Android: `/storage/emulated/0/Download/bwb-screenshots/`, desktop: `~/bwb-screenshots/`) **and** returned to your agent as a base64 image.

---

## What's New in 4.0.0 — "Lightweight Like Air"

### Static-first fetch ladder
- **`browser_goto` no longer spawns Chromium for plain pages** — fetch + extract in milliseconds (`mode: "static"`). JS pages escalate automatically (`mode: "browser"` + reason). Dead URLs error without spawning anything.
- **On-demand capabilities** — `browser_download` / `browser_export` ship as verbs, not weight. Missing backends prompt for consent install. Nothing heavy is ever bundled.

### Vigilance system
- **Every tool response carries a `[bwb resources]` footer** — MCP + Chromium MB, tabs, ok/watch/critical. `browser_watch` streams memory samples on its existing poll rhythm.
- **Thresholds act, then report** — critical pressure hibernates tabs, tears down at one tab, journals everything. The agent reads about the save, never discovers the OOM.

### Survival profile
- **`--lean` auto-enables on Termux** — capped renderers, silenced background services, 3-tab cap, 5-minute mayfly teardown, 256MB JS heap. `--nuclear` opts into `--single-process`.
- **Tab journal + lazy restore** — kills become resume points, not disasters. `bwb --setup` prints a survival guide.

### Breaking
- `browser_title` + `browser_url` folded into `browser_status.targets`. Still 26 tools — that's now a release gate.

*Full story in the [changelog](./CHANGELOG.md). Older releases documented there too.*

---

## Quick Install

```bash
npm install -g bwb-browser
bwb --version
# → bwb-browser 4.0.0
```

Done. If you have Chrome/Chromium anywhere on your system, bwb finds it. No config files. No environment variables. Just works.

**On Termux/Android:**
```bash
pkg install chromium      # One-time
npm install -g bwb-browser
bwb
```

*Yes, this runs on a phone. Yes, it's fully functional. Yes, I built it this way on purpose.*

---

## All 26 Tools

| Tool | Description |
|------|-------------|
| **`browser_act`** | 🔥 Natural language — "search for X", "click the button", "what's on this page" |
| **`browser_watch`** | 🔥 Live event capture — console, network, errors, navigation |
| **`browser_diagnose`** | 🔥 Full page health check — perf, errors, broken images, score |
| **`browser_fingerprint`** | 🔥 Realistic browser profile for testing |
| `browser_goto` | Navigate — static-first, escalates to browser with reason |
| `browser_screenshot` | Take a screenshot — whole page, viewport, or a single element via `selector` |
| `browser_html` | Get page/selector HTML |
| `browser_text` | Get page/selector text |
| `browser_back` | Go back in history |
| `browser_click` | Click an element (native CDP) |
| `browser_fill` | Fill an input field (native CDP) |
| `browser_elements` | List interactive elements |
| `browser_eval` | Execute JavaScript |
| `browser_setViewport` | Change viewport size |
| `browser_waitForSelector` | Wait for element to appear/disappear |
| `browser_newTab` | Create new tab |
| `browser_closeTab` | Close a tab |
| `browser_switchTab` | Switch to a tab |
| `browser_listTabs` | List all tabs |
| `browser_saveCookies` | Save session to disk |
| `browser_loadCookies` | Load session from disk |
| `browser_listSessions` | List saved sessions |
| `browser_download` | Download media (needs system yt-dlp, consent-gated) |
| `browser_export` | Export md/txt/html (pdf/docx/pptx need pip libs, consent-gated) |
| `browser_status` | Status + live resources + active profile |
| `browser_restart` | Restart the browser |

---

## Where It Runs

| Platform | Status | Notes |
|----------|--------|-------|
| Termux/Android | ✅ **Verified** | `pkg install chromium`, that's it |
| Linux | ✅ **Verified** | Auto-detects Chrome/Chromium |
| macOS | ✅ **Verified** | Auto-detects Chrome.app |
| Windows | ✅ **Verified** | Auto-detects Chrome.exe |
| CI (GitHub Actions) | ✅ **Verified** | Uses system Chrome |
| Docker | ✅ **Verified** | Just need Chrome in container |
| Your Raspberry Pi | ✅ Why not | Same npm install |

---

## MCP Agent Integration

Add this to any MCP-compatible agent's config:

```json
{
  "mcpServers": {
    "bwb": {
      "command": "bwb"
    }
  }
}
```

Works with: **Claude Code, OpenCode, Antigravity CLI, Cline, Continue.dev, Aider, Codex CLI, Cody, Windsurf, Cursor** — literally anything that speaks MCP.

See [AGENTS.md](./AGENTS.md) for copy-paste configs for each one.

---

## The Backstory

Every browser automation tool assumes you have 400MB to spare and a desktop-class machine. That assumption excludes phones, cheap VPS boxes, Raspberry Pis, and CI runners — most of the world's computers.

bwb is engineered against the hardest constraint first: **a memory-pressured device where every megabyte is contested.** No bundled browser. No wrapper frameworks. Just raw CDP — the protocol Chrome speaks natively — plus a static-fetch ladder so Chromium only starts when JavaScript demands it. Mobile-first isn't a feature here. It's the design spec everything else has to survive.

The result is ~136KB of source that does what 400MB of dependencies do. Not better code — less code, held to budgets: 26 tools max, 60 kB tarball max, zero native modules. Constraints are features.

*— Krish Tiwari ([@krshforever](https://github.com/krshforever))*

---

## Roadmap

- **bwb Cloud** — hosted browser instances so your agent has a browser even when your laptop's asleep
- **`browser_act` v2** — multi-step with feedback loops (not just "search for X" but "research this topic and summarize")
- **Recording & Replay** — record sessions, replay them, debug them
- **Browser pool** — multiple isolated instances for CI parallelization

---

## Support

If bwb saves you time, money, or a few brain cells:

- [GitHub Sponsors](https://github.com/sponsors/krshforever)

No gating. No "pro" tier. No bait-and-switch. The code is MIT forever. If you can't or won't pay, that's genuinely fine — I built this because I wanted it to exist.

---

## License

MIT — Krish Tiwari ([@krshforever](https://github.com/krshforever))
