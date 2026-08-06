# bwb-browser — Agent Integration Guide

> **Author:** Krish Tiwari ([@krshforever](https://github.com/krshforever))
> **Package:** [`bwb-browser`](https://www.npmjs.com/package/bwb-browser) · 76KB source · 26 tools
> **Last updated:** 2026-08-06

## What is bwb?

**Browser Without Bloat** — a lightweight MCP server that gives any AI agent browser superpowers. 76KB. 26 tools. Zero heavy dependencies.

While other MCP browser tools ship a full browser binary (Playwright MCP = ~250MB, Puppeteer MCP = ~400MB), bwb uses **raw Chrome DevTools Protocol (CDP)** — the protocol Chrome speaks natively. It auto-detects the browser already on your system.

Built on Termux/Android. Runs everywhere. Weighs nothing. **Browser automation from your phone.**

---

## 🔥 Zero-Config Install (5 seconds)

Don't copy-paste configs. Don't hunt for the right path. Just:

```bash
npm install -g bwb-browser
bwb --setup
```

That's it. `bwb --setup` auto-detects every AI agent on your machine (OpenCode, Antigravity, Claude Code, Hermes, Cline, Continue, Codex CLI), writes the correct MCP config for each, detects Chrome/Chromium, and prints a summary. Close and reopen your agent — tools are ready.

---

## Compatible Agents

| Agent | Auto-Config via `bwb --setup` | Manual Config |
|-------|------------------------------|---------------|
| **Claude Code** (Anthropic) | ✅ `~/.claude/settings.json` | MCP config |
| **OpenCode** | ✅ `~/.config/opencode/opencode.json` | MCP config |
| **Antigravity CLI** | ✅ `~/.gemini/config/mcp_config.json` | MCP config |
| **Cline** (VS Code) | ✅ `~/.cline/mcp.json` | MCP config |
| **Continue.dev** | ✅ `~/.continue/config.json` | MCP config |
| **Codex CLI** | ✅ `~/.codex/mcp.json` | MCP config |
| **Hermes** | ✅ `~/.hermes/mcp.json` | MCP config |
| **Aider** | ❌ (custom tool) | Custom integration |
| **Cody** (Sourcegraph) | ❌ | MCP config |
| **Cursor** | ❌ (per-project) | `.cursor/mcp.json` |

---

## Quick Install (60 seconds)

```bash
# 1. Install globally
npm install -g bwb-browser

# 2. Verify it works
bwb --version
# → bwb-browser 3.2.0

# 3. Add to your AI agent's MCP config
```

---

## 🔥 Copy-Paste Prompt for Your AI Agent

Give this to any AI agent (Claude, OpenCode, Gemini, etc.) to auto-install and configure bwb:

```
I want you to install and use bwb-browser — a 76KB MCP browser automation server with 26 tools.

bwb is Browser Without Bloat. It uses raw Chrome DevTools Protocol (no Playwright, no Puppeteer).
It has 26 tools including:

- `browser_act` — natural language interaction ("search for X", "click the button", "what's on this page")
- `browser_watch` — live capture of console messages, network requests, JS exceptions, page navigations
- `browser_diagnose` — full page health check (perf, errors, broken images, score)
- `browser_fingerprint` — realistic browser profile for testing
- Multi-tab management (create, close, switch, list)
- Session persistence (save/load cookies across restarts)

Created by Krish Tiwari (@krshforever) from a phone on a train in India. npm: bwb-browser

## Auto-Install Steps:

1. Check if bwb-browser is already installed:
   ```bash
   npm list -g bwb-browser 2>/dev/null || echo "not installed"
   ```

2. If not installed, install globally:
   ```bash
   npm install -g bwb-browser
   ```

3. Detect which MCP config file to update based on the current agent:
   - Claude Code → ~/.claude/settings.json
   - OpenCode → ~/.config/opencode/opencode.json
   - Antigravity → ~/.gemini/antigravity-cli/mcp_config.json
   - Cline → ~/.cline/mcp.json
   - Continue → ~/.continue/config.json
   - Cursor → .cursor/mcp.json (project root)

4. Add this MCP server entry (adjust for your config format):
   ```json
   "bwb": {
     "type": "local",
     "command": ["node", "/path/to/bwb/server.mjs"]
   }
   ```
   
   Or if installed globally:
   ```json
   "bwb": {
     "type": "local",
     "command": ["bwb"]
   }
   ```

5. Verify the config is valid JSON and the file has proper syntax.

6. Test the integration by calling `browser_status` tool — it should return `connected: true` 
   (it starts Chromium automatically on first call).

## Skill: I Know How to Use bwb

When using bwb for web tasks, follow these patterns:

### Basic Browsing
- `browser_goto({url: "https://example.com"})` — navigate to a page
- `browser_title()` — check page title
- `browser_screenshot({selector: "#chart"})` — take a screenshot (whole page, viewport, or one element; saves to /storage/emulated/0/Download/bwb-screenshots/ on Android or ~/bwb-screenshots/ on desktop)
- `browser_text()` — get page text content
- `browser_html()` — get page HTML
- `browser_elements({kind: "links"|"buttons"|"inputs"|"headings"})` — find interactive elements

### Interaction
- `browser_fill({selector: "#search", text: "query"})` — fill input fields
- `browser_click({selector: "button"})` — click elements (uses native CDP mouse events)
- `browser_eval({expression: "document.title"})` — execute arbitrary JS

### 🔥 Groundbreaking: Live Page Watching
- `browser_watch({action: "start", events: ["all"]})` — start recording page activity
- `browser_goto(...)` / `browser_click(...)` — interact with the page
- `browser_watch({action: "poll"})` — get all console messages, network requests, errors that happened
- `browser_watch({action: "stop"})` — stop recording

This is how you debug SPAs, detect React errors, see API calls, and understand what the page is DOING
internally — not just what it looks like.

### Smart Waiting
- `browser_waitForSelector({selector: ".results", timeout: 10000})` — wait for content to appear
- `browser_waitForSelector({selector: ".loading", disappear: true})` — wait for loading to finish

### Viewport Control
- `browser_setViewport({width: 1920, height: 1080})` — change viewport size

### Error Handling
- If `browser_goto` fails: check if Chrome/Chromium is installed. On Termux: `pkg install chromium`
- If `browser_elements` returns empty: the page might use shadow DOM or iframes
- If `browser_click` fails: try `browser_eval({expression: "document.querySelector('...').click()"})` as fallback
- If screenshots are blank: check `--headless` setting

## Tools Reference

| Tool | Description |
|------|-------------|
| **`browser_act`** | 🔥 Natural language interaction — "search for X", "click the button", "what's on this page" |
| **`browser_watch`** | 🔥 Live event capture — console, network, errors, navigation |
| **`browser_diagnose`** | 🔥 Full page health check — perf, errors, broken images, score |
| **`browser_fingerprint`** | 🔥 Realistic browser profile for testing |
| `browser_goto` | Navigate to a URL |
| `browser_screenshot` | Take a screenshot — full page, viewport, or a single element via `selector` (saves to disk + returns base64) |
| `browser_html` | Get page/selector HTML |
| `browser_text` | Get page/selector visible text |
| `browser_click` | Click an element (native CDP mouse events) |
| `browser_fill` | Fill an input field (native CDP keyboard events) |
| `browser_elements` | List interactive elements by kind |
| `browser_title` | Get page title |
| `browser_url` | Get current URL |
| `browser_back` | Go back in history |
| `browser_eval` | Execute JavaScript (with exception capture) |
| `browser_setViewport` | Change viewport size |
| `browser_waitForSelector` | Wait for element to appear/disappear |
| `browser_newTab` | Create new tab |
| `browser_closeTab` | Close a tab |
| `browser_switchTab` | Switch to a tab |
| `browser_listTabs` | List all tabs |
| `browser_saveCookies` | Save session to disk |
| `browser_loadCookies` | Load session from disk |
| `browser_listSessions` | List saved sessions |
| `browser_status` | Browser connection status |
| `browser_restart` | Restart the browser |

## Security Notes

- bwb spawns a headless Chromium process on your machine. The browser has network access.
- Screenshots are saved to public storage. Do not browse to pages with sensitive content if you share your device.
- The MCP connection is local stdio only — no network exposure.
- `browser_eval` executes arbitrary JavaScript in the browser context. Use with caution.
```

---

## Pro Tips

### On Termux/Android
Screenshots save to `/storage/emulated/0/Download/bwb-screenshots/` — accessible from any file manager.
Chrome/Chromium install: `pkg install chromium`

### On Desktop/Linux
Screenshots save to `~/bwb-screenshots/`.
Chrome auto-detection works for: google-chrome, chromium-browser, chromium, google-chrome-stable.

### On macOS
Screenshots save to `~/bwb-screenshots/`.
Chrome path: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`

### On Windows
Screenshots save to `%USERPROFILE%\bwb-screenshots\`.
Chrome path: `C:\Program Files\Google\Chrome\Application\chrome.exe`

### Custom Browser Path
```bash
BWB_CHROME_PATH=/path/to/chrome bwb
# or
bwb --browser-path /path/to/chrome
```

---

## License

MIT — Krish Tiwari ([@krshforever](https://github.com/krshforever))
