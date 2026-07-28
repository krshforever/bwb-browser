# bwb-browser-termux — Competitive Benchmarks

> **bwb**: 30KB, 11 tools, raw CDP, Zero heavy deps
> Last updated: 2026-07-28

## Size Comparison

| Tool | Package Size | Dependencies | Browser Engine | Termux? | Setup Time |
|------|-------------|-------------|----------------|---------|-----------|
| **bwb-browser-termux** | **30 KB** | **3** (tiny) | Raw CDP | ✅ Native | **5 seconds** |
| cdpilot | 488 KB | 0 | Raw CDP | ⚠️ Not tested | 5 seconds |
| Playwright MCP | 200+ MB | 30+ | Playwright | ❌ | 5+ minutes |
| Chrome DevTools MCP | 300+ MB | 50+ | Puppeteer | ❌ | 5+ minutes |
| Puppeteer MCP | 400+ MB | 50+ | Puppeteer | ❌ | 5+ minutes |
| OpenChrome | 118 KB | 3 | CDP (real Chrome) | ⚠️ Untested | 2 minutes |
| Termux Browser Pilot | 5+ MB | 20+ (Python) | Firefox/Chromium+xdotool | ✅ Native | 10+ minutes |
| termux-puppeteer-mcp | 10+ MB | 50+ | Puppeteer in Alpine | ✅ Container | 5-10 minutes |
| bb-browser | 1.8 MB | 7 | CDP+daemon | ⚠️ Untested | 2 minutes |

## Live Demo Results (2026-07-28, Termux/Android)

```
╔══════════════════════════════════════════════════════════╗
║        bwb-browser-termux  —  LIVE DEMO               ║
║  30KB · 11 tools · raw CDP · zero bloat · on Termux   ║
╚════════════════════════════════════════════════════════╝

  Step 1: Scraping Hacker News frontpage       ✅  1.7s
    - #1: 7.1 Earthquake in Japan
    - #2: About the security content of macOS Tahoe 26.6
    - #3: What Even Are Microservices?
    - #4: Our position on open-weights models
    - #5: Google's Beyond Zero

  Step 2: Exploring GitHub Trending            ✅  5.1s
    - pascalorg/editor, jenkinsci/jenkins, ...

  Step 3: Google search + fill + submit        ✅  4.0s
    - Filled "bwb browser automation termux", submitted, screenshot

  Step 4: Wikipedia article extraction         ✅  3.2s
    - "A headless browser is a web browser without a GUI..."

  Step 5: Rapid-fire 5 sites in sequence       ✅ 24.1s
    - example.com: 744ms
    - httpbin.org/ip: 1635ms
    - github.com: 5146ms
    - wikipedia.org: 15359ms (load event wait)
    - news.ycombinator.com: 1231ms

  Step 6: System status                        ✅  0.1s
    - Connected: true, Port: 39243, PID: 15409

═══════════════════════════════════════════════════════════
  Total: 44.9s · 6 mission steps · 7 screenshots
═══════════════════════════════════════════════════════════
```

## What Makes bwb Unique

### 1. The Only Native Termux/Android MCP Browser Server
Every other browser MCP requires either:
- Heavy frameworks (Playwright/Puppeteer — 200-400MB)
- Container layers (proot-distro Alpine — 10+ min setup)
- X11 servers (Xvfb + openbox — Python dependency hell)
- Desktop-only (can't run on Termux at all)

**bwb works natively** — just Node.js + Chromium from `pkg`.

### 2. 100x Smaller Than The Competition
- Playwright MCP: 200MB+ (70x bwb)
- Puppeteer MCP: 400MB+ (130x bwb)
- Chrome DevTools MCP: 300MB+ (100x bwb)

**bwb: 30KB.**

### 3. Production-Ready in One Command
```bash
npm install -g bwb-browser-termux
# Then add one line to opencode.json
```

vs competitors requiring:
- 5-10 minute setup scripts
- Container configuration
- Python virtual environments
- System package installation

### 4. Raw CDP Power Without Bloat
No Playwright, no Puppeteer, no Selenium — just the Chrome DevTools Protocol via `chrome-remote-interface`. This means:
- **Lower latency** — no framework overhead between you and the browser
- **Full CDP access** — intercept requests, manipulate cookies, profile performance
- **No version conflicts** — works with any Chromium version

## When to NOT Use bwb

- You need multi-browser testing (Firefox, WebKit) → use Playwright MCP
- You need pixel-perfect stealth/anti-bot → use Stealth Browser MCP or cdpilot
- You need complex network interception → add a layer yourself (raw CDP is available)
- You're on desktop and want more tools → Playwright MCP has 21 tools

## Use Cases

- ✅ **AI agents on mobile** — Browse the web from your phone via Claude/OpenCode
- ✅ **Web scraping** — Extract data from any page, no Puppeteer overhead
- ✅ **Form automation** — Fill and submit forms with native CDP input events
- ✅ **Screenshot pipelines** — Capture pages for monitoring/archival
- ✅ **CI/CD on Termux** — Run browser tests in your Android CI pipeline
- ✅ **Learning/Prototyping** — Simplest possible CDP setup for experimentation

## Roadmap to v2.0 (Monetization Path)

1. **v1.x** (current) — Free, open-source, MIT. Core 11 tools, Termux-native.
2. **v2.0 Beta** — Free. Add: accessibility tree, stealth mode, proxy rotation.
3. **v2.0 Pro** — Paid license. Add: parallel tabs, persistent sessions, network interception, CAPTCHA handling, enterprise auth.
4. **bwb Cloud** — Managed browser instances. Pay-per-use. No infrastructure to manage.
