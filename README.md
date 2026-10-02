# bwb-browser

**Browser Without Bloat** — ~173KB of source, 65 kB tarball. 26 tools. Static-first. Runs on your phone, survives it too.

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

bwb speaks **Chrome DevTools Protocol (CDP)** — the protocol Chrome speaks natively — through one thin CDP client (`chrome-remote-interface`). No Playwright, no Puppeteer, no browser binary. It auto-detects the browser already on your system. No downloads. No binary mismatches. No "why is my disk full" panic.

| Factor | bwb v4 | Playwright MCP | Puppeteer MCP |
|--------|-----|----------------|---------------|
| Source size | **~173KB** | ~50MB+ | ~100MB+ |
| Published tarball | **65 kB** | — | — |
| Total install (npm) | **~62MB, zero browsers** | ~250MB | ~400MB |
| Bundled browser | **None** | Chromium (~200MB) | Chromium (~300MB) |
| Chromium spawns for plain pages | **Never (static-first)** | Always | Always |
| Works on Termux/Android | **✅ Yes** | ❌ | ❌ |
| Survives 1GB RAM / phone OOM | **✅ Lean profile + vigilance** | ❌ | ❌ |
| Zero native deps | **✅ Yes** | ❌ | ❌ |
| Runtime dependencies | **5** | many | many |
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

Your agent can **listen** to the page:

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

Sessions survive agent restarts and server restarts. Copying the file to another machine *may* work, but many sites bind sessions to IP, user-agent and device — assume it does not.

⚠️ The session file holds **live login credentials** in `~/.bwb/sessions/` (mode `600`). Pass `domains: ["gmail.com"]` to `browser_saveCookies` to store less. Treat the file like a password.

### 4. `browser_diagnose` — Lighthouse for Your AI Agent

One call gets you: load timings, console errors, broken images, meta tags, interaction counts, and a heuristic health score (a weighted penalty sum — not a Lighthouse audit). Your agent can self-diagnose instead of guessing.

### 5. Multi-Tab & Sessions

Create tabs, close them, switch between them, save cookies, load them back. Like a real browser. Because it is one.

### 6. Realistic Browser Profile

Applies the usual anti-detection patches — `navigator.webdriver`, plugins, languages, and a user agent derived from the real Chromium build. That *is* what "stealth mode" means; the difference is intent: use it on sites you own or have permission to test, and you get tests that match real user conditions.

### 7. Element Screenshots

Capture just one element — a login form, a chart, a product card — not the whole page:

```javascript
browser_screenshot({selector: "#price-chart"})
browser_screenshot({selector: "h1"})           // The headline, cropped
browser_screenshot({fullPage: true})            // The whole page
browser_screenshot({})                          // Just the viewport
```

Every screenshot is saved to disk (Android: `/storage/emulated/0/Download/bwb-screenshots/`, desktop: `~/bwb-screenshots/`) **and** returned to your agent as a base64 image. The newest 50 are kept (`BWB_SHOT_KEEP`).

---

## Security Notes

bwb drives a **real, logged-in browser** on behalf of a model that is reading pages it does not control. The defaults are chosen for that, and they are not all comfortable:

- **Only http/https.** `file:`, `javascript:`, `data:`, `chrome:`, `devtools:` and `view-source:` are refused — a page that tells your agent to "open file:///… and summarize it" gets an error, not your files.
- **No SSRF.** Static fetches refuse loopback, private, link-local and CGNAT addresses (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, `::1`, `fc00::/7`) — including every redirect hop. On a cloud box that is the difference between "reads a website" and "reads the metadata service". Local development: `BWB_ALLOW_PRIVATE=1`.
- **The Chromium sandbox stays on.** `--no-sandbox` is applied only where it must be: Termux, running as root, or if you pass `BWB_NO_SANDBOX=1`.
- **Cookies at rest are credentials.** `~/.bwb/sessions/*.json` is `600` in a `700` directory and holds live logins for every domain visited. `domains: [...]` limits it.
- **The tab journal stores origin + path only**, so OAuth callbacks, magic links and reset tokens never land on disk. Stale URLs are not auto-replayed on desktop.
- **`browser_export` cannot write outside its directory.** No arbitrary `output_path`.
- **`--readonly`** disables every state-changing tool (click, fill, eval, act, export, download, tab mutation) for browsing untrusted sites.
- **`browser_act` refuses destructive clicks** ("Delete account", "Buy now", "Send") unless you pass `force:true`, and returns `candidates` rather than guessing when a label is ambiguous.
- **Page content is untrusted.** Anything these tools return from a page is attacker-controlled input. Instructions inside it are data, not commands. Do not let page text talk your agent into `browser_eval`, `browser_export` or `browser_download`.

---

## What's New — 4.1.0

### It was quietly doing the wrong thing. Now it doesn't.
- **`browser_act` typed in lowercase.** Every pattern matched `instruction.toLowerCase()` and then typed the captured group, so `fill password with MyS3cretPass` sent `mys3cretpass`. Case is preserved everywhere now, and secrets are redacted from the result instead of echoed back.
- **`browser_act` clicked the wrong element.** It built a CSS selector from the match and re-queried it, so `click the Pricing link` became selector `a` and clicked **Home**. Elements are now scored, scrolled, measured and tagged inside one `Runtime.evaluate`; ambiguous matches return `candidates` instead of a coin flip; destructive labels need `force:true`.
- **Static fetch mangled every non-English page.** It decoded each network chunk separately, so a Hindi/CJK/emoji page split at a byte boundary came back as `U+FFFD` soup (1,445 replacement characters in the repro). Chunks are concatenated as bytes and decoded once, with the declared charset.
- **`browser_goto` and every other tool were looking at different pages.** A static result left Chromium on `about:blank`, so the next `browser_text` returned nothing, and the static rung ignored loaded cookies (a logged-out page, reported at `confidence: "high"`). The URL is now carried across and materialized on demand.
- **`npm test` did not test.** `node --check server.mjs && node --check lib/*.mjs` — `node --check` takes one file, so a syntax error in `lib/` exited 0. Now: a real suite, `npm run lint`, and CI on Node 18/20/22.

### Security, honestly
- URL policy: http(s) only, no `file:`/`javascript:`, no loopback/private/metadata addresses on any redirect hop.
- Chromium's sandbox is on unless you are on Termux, root, or ask for `--no-sandbox`.
- Session cookies are `600` in a `700` directory; the tab journal keeps origin+path only.
- `browser_export` writes only inside its export directory. `browser_download` uses no shell.
- `--readonly` for browsing untrusted sites.

### Static-first fetch ladder (4.0)
- **`browser_goto` does not spawn Chromium for plain pages** — fetch + extract in milliseconds (`mode: "static"`). JS pages escalate automatically (`mode: "browser"` + reason). Dead URLs error without spawning anything. JSON/XML/CSV/`robots.txt` are served statically too.

### Vigilance system (4.0)
- **Every tool response carries a `[bwb resources]` footer** — MCP + Chromium MB, tabs, ok/watch/critical. `browser_watch` streams memory samples on its existing poll rhythm.
- **Thresholds act, then report** — critical pressure hibernates tabs, journals everything, and tells the agent. It only tears the browser down after two consecutive critical samples, and never during a watch.

### Survival profile (4.0)
- **`--lean` auto-enables on Termux** — capped renderers, silenced background services, 3-tab cap, 5-minute mayfly teardown, 256MB JS heap. `--nuclear` opts into `--single-process`.
- **Tab journal + lazy restore** — kills become resume points, not disasters. `bwb --setup` prints a survival guide.

### Breaking
- `browser_title` + `browser_url` folded into `browser_status.targets` (4.0). Still 26 tools — that's a release gate, enforced in CI.
- `browser_export` lost `pdf`/`docx`/`pptx`. They reported `{ready: true}` and wrote nothing. Markdown, txt and html remain.
- `browser_goto` takes `mode` and `maxChars`; `browser_saveCookies` takes `domains`. `bwb --setup` is a dry run unless you pass `--yes`.

*Full story in the [changelog](./CHANGELOG.md). Older releases documented there too.*

---

## Quick Install

```bash
npm install -g bwb-browser
bwb --setup --yes     # writes the MCP entry into your agent's config
bwb --version         # → bwb-browser 4.1.0
```

`bwb --setup` is a **dry run unless you pass `--yes`** — it lists exactly which of your agents' config files it would touch. If you have Chrome/Chromium anywhere on your system, bwb finds it. No config files of your own. No environment variables. Just works.

Useful flags when you want less:

| Flag | Effect |
|------|--------|
| `--readonly` | Refuse every state-changing tool |
| `--allow-domains a.com,b.com` | Navigation allowlist |
| `--always-browser` | Skip the static rung entirely |
| `--no-sandbox` | Disable the Chromium sandbox (auto on Termux/root) |
| `--attach-port 9222` | Drive a browser you already opened (guest mode) |

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
| **`browser_act`** | Natural language — "search for X", "click the button", "what's on this page". Returns `candidates` instead of guessing |
| **`browser_watch`** | Live event capture — console, network, errors, navigation |
| **`browser_diagnose`** | Full page health check — timings, errors, broken images, score |
| **`browser_fingerprint`** | Anti-detection patches for testing sites you own |
| `browser_goto` | Navigate — static-first (`mode: auto\|static\|browser`), escalates with a reason |
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
| `browser_export` | Write md/txt/html into the export directory |
| `browser_status` | Status + live resources + active profile |
| `browser_restart` | Restart the browser |

---

## Where It Runs

| Platform | Status | Notes |
|----------|--------|-------|
| Termux/Android | ✅ **Verified** | `pkg install chromium`, that's it |
| Linux | ✅ **Verified** | Auto-detects Chrome/Chromium |
| macOS | ✅ **Verified** | Auto-detects Chrome.app |
| Windows | ⚠️ **Supported, untested** | Auto-detects Chrome.exe; `ps`/`which` fallbacks are Linux-only, process sampling degrades to self |
| CI (GitHub Actions) | ✅ **Tested** | `npm test` + `npm run smoke` on Node 18/20/22 |
| Docker | ⚠️ **Supported, untested** | Chrome in the container; runs as root, so the sandbox is auto-disabled |
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

bwb is engineered against the hardest constraint first: **a memory-pressured device where every megabyte is contested.** No bundled browser. No wrapper frameworks. Just CDP — the protocol Chrome speaks natively, over one thin client — plus a static-fetch ladder so Chromium only starts when JavaScript demands it. Mobile-first isn't a feature here. It's the design spec everything else has to survive.

The result is ~173KB of source that does what 400MB of dependencies do. Not better code — less code, held to budgets: 26 tools max, 5 runtime dependencies, 65 kB tarball, zero native modules. Constraints are features. (The 4.1.0 correctness pass grew the source by ~50KB: a real URL policy, a real element-scoring engine, and the tests that keep them honest.)

*— Krish Tiwari ([@krshforever](https://github.com/krshforever))*

---

## Roadmap

- **bwb Cloud** — hosted browser instances so your agent has a browser even when your laptop's asleep. (The URL policy in 4.1.0 is what makes this safe to offer; prompt injection becomes a server-side problem there.)
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
