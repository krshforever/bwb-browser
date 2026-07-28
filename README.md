# bwb-browser-termux

**Browser Without Bloat** — a lightweight browser automation MCP server using raw Chrome DevTools Protocol (CDP).

No Playwright. No Puppeteer. Just CDP.

Works on **Termux/Android**, Linux, macOS, and Windows.

## Why bwb?

| Feature | bwb | Playwright MCP | Puppeteer MCP |
|---------|-----|----------------|---------------|
| **Dependencies** | 3 packages | 50+ packages | 30+ packages |
| **Install size** | ~2MB | ~500MB+ | ~300MB+ |
| **Works on Termux** | ✅ | ❌ | ❌ |
| **Works in CI** | ✅ | ⚠️ Needs browser download | ⚠️ Needs browser download |
| **Uses existing Chrome** | ✅ | ❌ Downloads its own | ❌ Downloads its own |

## Installation

```bash
npm install -g bwb-browser-termux
```

Or run directly:

```bash
npx bwb-browser-termux
```

## Prerequisites

You need **Chrome** or **Chromium** installed. bwb will auto-detect it.

**Termux/Android:**
```bash
pkg install chromium
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt install chromium-browser
# or
sudo apt install google-chrome
```

**macOS:**
```bash
brew install --cask google-chrome
```

**Windows:**
Download and install Google Chrome normally.

## Usage

### With Claude Desktop / OpenCode / any MCP client

Add to your MCP client config:

```json
{
  "mcpServers": {
    "bwb": {
      "command": "npx",
      "args": ["bwb-browser-termux"]
    }
  }
}
```

For Termux, you may need the full path:

```json
{
  "mcpServers": {
    "bwb": {
      "command": "node",
      "args": ["/path/to/bwb-browser-termux/server.js"]
    }
  }
}
```

### Command line

```bash
# Start the MCP server (stdio)
bwb

# With custom browser path
bwb --browser-path /usr/bin/chromium

# Custom CDP port
bwb --port 9333

# Visible browser (not headless)
bwb --headless false

# See all options
bwb --help
```

## Configuration

| CLI flag | Env var | Default | Description |
|----------|---------|---------|-------------|
| `--browser-path` | `BWB_CHROME_PATH` | auto-detected | Path to Chrome/Chromium binary |
| `--port` | `BWB_CDP_PORT` | `9222` | Remote debugging port |
| `--user-data-dir` | `BWB_USER_DATA_DIR` | `~/.cache/bwb-browser` | Browser profile directory |
| `--headless` | `BWB_HEADLESS` | `true` | Run headless (`true`/`false`) |

## Tools (11)

| Tool | Description |
|------|-------------|
| `browser_goto` | Navigate to a URL |
| `browser_screenshot` | Take a screenshot |
| `browser_html` | Get page/selector HTML |
| `browser_text` | Get page/selector text |
| `browser_click` | Click an element by CSS selector |
| `browser_fill` | Fill an input field |
| `browser_elements` | List interactive elements (links, buttons, inputs, headings) |
| `browser_title` | Get current page title |
| `browser_url` | Get current URL |
| `browser_eval` | Execute JavaScript in page context |
| `browser_status` | Browser connection status |

## License

MIT © krsh
