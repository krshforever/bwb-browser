# bwb-browser

**Browser Without Bloat** — 76KB. 25 tools. Zero dependencies. Runs on your phone.

A lightweight MCP server that gives any AI agent browser superpowers. Written by a guy in India on Termux because the existing tools were 200MB of "why."

---

## The Pitch (60 seconds)

Every other MCP browser tool ships a full browser binary. Playwright MCP? ~250MB. Puppeteer MCP? ~400MB. Chrome DevTools MCP? ~350MB.

bwb uses **raw Chrome DevTools Protocol (CDP)** — the same protocol Chrome speaks natively. It auto-detects the browser already on your system. No downloads. No binary mismatches. No "why is my disk full" panic.

| Factor | bwb | Playwright MCP | Puppeteer MCP |
|--------|-----|----------------|---------------|
| Source size | **76KB** | ~50MB+ | ~100MB+ |
| Total install | **~1MB** | ~250MB | ~400MB |
| Bundled browser | **None** | Chromium (~200MB) | Chromium (~300MB) |
| Works on Termux/Android | **✅ Yes** | ❌ | ❌ |
| Zero deps (no node_modules hell) | **✅ Yes** | ❌ | ❌ |
| Live event streaming | **✅** | ❌ | ❌ |
| Natural language interaction | **✅** | ❌ | ❌ |
| Persistent sessions | **✅** | ❌ | ❌ |
| CPU profile at idle | Basically nothing | 🐌 | 🐌 |

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

---

## Quick Install

```bash
npm install -g bwb-browser
bwb --version
# → bwb-browser 3.1.1
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

## All 25 Tools

| Tool | Description |
|------|-------------|
| **`browser_act`** | 🔥 Natural language — "search for X", "click the button", "what's on this page" |
| **`browser_watch`** | 🔥 Live event capture — console, network, errors, navigation |
| **`browser_diagnose`** | 🔥 Full page health check — perf, errors, broken images, score |
| **`browser_fingerprint`** | 🔥 Realistic browser profile for testing |
| `browser_goto` | Navigate to a URL |
| `browser_screenshot` | Take a screenshot |
| `browser_html` | Get page/selector HTML |
| `browser_text` | Get page/selector text |
| `browser_title` | Get page title |
| `browser_url` | Get current URL |
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
| `browser_status` | Browser connection info |
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

I built this because I was tired of every browser automation tool assuming you have 400MB to spare and a desktop-class machine. I work from my phone sometimes. Termux exists. Why shouldn't browser automation work there too?

So I did what any reasonable person would do: I ignored all the existing solutions and wrote my own, using nothing but raw CDP — the protocol Chrome speaks natively. No wrappers. No abstractions. Just JSON messages over WebSocket.

The result is 76KB of source code that does what 400MB of dependencies do. It's not _better_ code — it's _less_ code. And sometimes less is all you need.

*— Krish Tiwari ([@krshforever](https://github.com/krshforever)), somewhere on an Indian train, writing code on a phone*

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
