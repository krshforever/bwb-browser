# bwb-browser — Benchmarks & Comparison

> **bwb**: ~173KB source, 65 kB tarball, 26 tools, 5 runtime dependencies, no bundled browser
> Numbers refreshed for 4.0.2. Figures marked *(measured)* come from runs on the author's machine; anything else is an approximate published size and should be re-verified before you quote it.

## Size Comparison

| Tool | Package size | Runtime deps | Browser engine | Termux? | Setup time |
|------|--------------|--------------|----------------|---------|-----------|
| **bwb-browser** | **65 kB** | **5** | CDP over a thin client | ✅ Native | **5 seconds** |
| Playwright MCP | 200+ MB | 30+ | Playwright (bundled Chromium) | ❌ | 5+ minutes |
| Chrome DevTools MCP | 300+ MB | 50+ | Puppeteer | ❌ | 5+ minutes |
| Puppeteer MCP | 400+ MB | 50+ | Puppeteer | ❌ | 5+ minutes |

Install footprint is the number that matters on a phone or a 1GB VPS: `npm install -g bwb-browser` pulls ~62MB of Node dependencies and **zero** browsers. That is roughly 3–6x smaller than the alternatives, and it is the number the 4.x work actually moved.

## What the static ladder saves *(measured)*

The headline of v4 is not a benchmark, it is an absence: for a plain article, **Chromium never starts**.

| Page type | `browser_goto` mode | Chromium spawned | Typical wall time |
|-----------|--------------------|------------------|-------------------|
| News article, blog post, docs | `static` | no | ~0.2–0.8s |
| `robots.txt`, JSON, CSV, RSS | `static` | no | ~0.05–0.2s |
| JS app / SPA shell | `browser` (escalated) | yes | 2–15s |
| Logged-in page (cookies loaded) | `browser` | yes | 2–15s |

A single YouTube tab costs **746MB** of Chromium tree RSS *(measured, Termux/Android)*. That is why the ladder exists and why the resource footer exists.

## Live Demo Results (2026-07-28, Termux/Android)

An end-to-end run over six steps — scrape, explore, search, extract, rapid-fire, status — completed in **44.9s total** with 7 screenshots, driving a real browser on a phone. Raw output:

```
  Step 1: Scraping Hacker News frontpage       ✅  1.7s
  Step 2: Exploring GitHub Trending            ✅  5.1s
  Step 3: Google search + fill + submit        ✅  4.0s
  Step 4: Wikipedia article extraction         ✅  3.2s
  Step 5: Rapid-fire 5 sites in sequence       ✅ 24.1s
  Step 6: System status                        ✅  0.1s
  ─────────────────────────────────────────────────────────
  Total: 44.9s · 6 mission steps · 7 screenshots
```

Those five rapid-fire timings are from v1, before the static ladder existed — the article and data fetches in that sequence are now answered without a browser at all, so the same run is substantially faster on 4.0.2. The script is `docs/phone-demo.mjs`.

## What actually makes bwb different

### 1. It runs natively on Termux/Android
Every other browser MCP needs one of: Playwright/Puppeteer (200–400MB), a proot/Alpine container layer, an Xvfb + window manager, or a desktop. bwb needs Node and Chromium from `pkg`.

### 2. It is built against the memory budget, not just the feature list
26 tools max (a release gate, enforced in CI), 5 dependencies, no native modules, a lean profile that caps renderers on a 1GB box, and a resource footer on **every** response so the agent sees pressure before Android's OOM killer does.

### 3. It fails visibly
- A heuristic clicker that cannot decide between "Login" and "Login with Google" returns `candidates` rather than clicking one.
- A click whose label reads "Delete account" needs `force:true`.
- A URL policy refuses `file:`, `javascript:` and private/loopback addresses instead of fetching them.
- `--readonly` exists for exactly the case where you do not trust the page.

## When to NOT use bwb

- Multi-browser testing (Firefox, WebKit) → Playwright MCP
- Pixel-perfect bot evasion as a product feature → a dedicated stealth stack
- A pixel/trace-level debugging protocol → Chrome DevTools MCP
- Complex request interception → CDP `Fetch` domain is reachable via `browser_eval`/CDP, but it is not a product feature here

## Use Cases

- ✅ **AI agents on mobile** — browse from a phone via Claude Code / OpenCode
- ✅ **Scraping** — article extraction with no browser at all
- ✅ **Form automation** — native CDP input events, select-then-insert (no append)
- ✅ **Screenshot pipelines** — full page, viewport, or one selector; newest 50 retained
- ✅ **CI on Linux** — `npm test` (84 unit tests) + `npm run smoke` + `npm run test:browser` (21 checks against a real Chromium), Node 18/20/22

## Roadmap

v4 line: correctness and security hardening (4.0.2 shipped the URL policy, the element-scoring rewrite and the test suite). Longer term: accessibility tree, recording/replay, a browser pool for CI parallelisation, and possibly hosted browser instances.

**No paid tier.** There is no Pro licence, no CAPTCHA-solving service, and no proxy rotation behind a paywall. That is not a roadmap item — it is a promise. If bwb ever does need money to survive, that page will say so plainly before anything is paywalled.