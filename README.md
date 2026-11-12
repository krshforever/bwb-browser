# bwb-browser

**Browser Without Bloat.** An MCP server that gives an AI agent a real browser without making you install one.

**Two halves.** `bwb` drives the browser. **Drishti** is the browser — a real Android browser, on the phone in your hand, that you and your agent use *at the same time*. No cloud session, no remote desktop, no instance in Virginia holding a login that isn't yours.

Chrome already speaks CDP. Most agent browsers answer that by shipping a second Chrome — a couple of hundred megabytes of it — wrapping it in a driver, and calling the wrapper a feature. bwb talks to the browser you already have, over one thin CDP client, and refuses to start it until JavaScript makes it necessary.

On this phone, one YouTube tab costs **746MB**. That number is the design.

```bash
npm install -g bwb-browser
bwb --setup --yes      # writes the MCP entry into every agent it finds
bwb --version          # → bwb-browser 4.6.0
```

**41 tools · 5 dependencies · ~321KB of source · 112 kB tarball · no bundled browser · MIT**

Those five dependencies are `@modelcontextprotocol/sdk`, `chrome-remote-interface`, `linkedom`, `@mozilla/readability` and `zod`. No `postinstall` that phones home, no native build step, no forty minutes of `npm install` while you make tea.

---

## Thirty seconds

An agent checking out on a JS-heavy shop, abridged:

```js
browser_goto({ url: "https://shop.example/cart" })
// → { mode: "static" }                    ← Chromium never started

browser_click({ selector: "#checkout" })
// → { mode: "browser", reason: "client-side render" }   ← it escalated itself

browser_snapshot()
// → - heading "Checkout" [level=1]
//   - textbox "Email" [ref=e2]
//   - button "Pay $42.00" [ref=e9]
//   [bwb resources] chromium 312MB · tabs 1 · ok

browser_fill({ ref: "e2", text: "..." })
browser_click({ ref: "e9" })

// the page wants an SMS code. Don't guess it — hand it over.
needs_human({ reason: "Enter the SMS code for the payment" })
```

`[ref=e9]` is the whole point. A CSS selector is a promise the page makes and then breaks on the next re-render; a ref is a handle to a node the server just resolved, scoped to that tab. Snapshot, act by ref, re-snapshot when the page changes. That's the loop.

---

## Why it exists

Agent browsers are built for the laptop of the person writing them: 16GB, mains power, a fan you can hear from the hallway. Playwright and Puppeteer are magnificent at that job — genuinely, they're why half this vocabulary exists. They are also the wrong shape for the other machine: a phone in a bag, 1GB free on a good day, and an OS that kills processes as a hobby.

Subtraction is the entire answer. No bundled browser, no wrapper framework, no driver protocol, no second copy of everything. One thin CDP client, plus a static fetch path so most pages never need a renderer at all.

| | bwb | Chromium-bundled servers |
|---|---|---|
| Ships a browser | **No** | Yes, 200–400MB typical |
| Chromium for a plain page | **Never** | Always |
| Time to first page | **Milliseconds** | One Chromium boot |
| Runtime dependencies | **5** | — |
| Install | **112 kB tarball** | Hundreds of MB |
| Termux / Android | **Runs** | Does not |
| 1GB box / phone OOM | **Sheds load, journals tabs, tells the agent** | Dies mid-run, politely |
| Console + network history | **Always recording, metadata only** | Opt-in, or absent |

---

## The screen problem

An agent with a browser is a very capable thing with no face. It clicks, it reads, it types into your bank — and you watch a spinner. Every serious agent browser has noticed this, and the answers so far are the same shape: **rent a browser in a datacenter and stream a video of it back to you.** Browserbase, Steel and Cloudflare all ship a live viewer with human takeover, and they are good at it. Your agent then browses as a rented machine in Virginia, holding a session that isn't yours, on hardware you will never touch.

bwb and Drishti take the other road: **the browser is already in your hand.**

It is a real browser — tabs, history, a URL bar — and the agent attaches to *that* browser, live, while you are looking at it. Same instance, same cookies, same tab you just opened. Three things follow that no cloud session can offer:

- **You can see it working.** Not a replay, not a screenshot after the fact — the page moves under your thumb.
- **You can take it back.** Tap *Take control* and the agent pauses mid-step, holds the request open, and resumes exactly where it stopped when you hand back. Nothing is lost, nothing restarts, nothing is retried behind your back.
- **Nothing leaves the device.** No session token to a vendor, no recording of your bank, no "trust us with the profile". The network boundary is your phone.

And the Android-specific part, which is why this had to be an app and not a CLI trick. Chromium under Termux is a child process of a terminal with no foreground standing; Android ranks it near the bottom of what to kill when memory tightens, which is exactly why a 746MB YouTube tab keeps dying mid-task. An app the system considers visible is a different class of citizen — the same reason your music keeps playing and your background build does not.

**The browser that solves agent browsing is the one that doesn't get killed.**

Sharing one browser with an agent is not a feature you bolt on. It is a negotiation, and the negotiation is the entire design: who may write to a tab (leases), whether a site gets opened at all (approvals), what silence means (refusal, always), and how a human interrupts a running step without destroying it (takeover, pause, resume).

---

## What this is not

- **Not a framework.** There is no `page.locator().first().nth(0).waitFor()`. There is `browser_snapshot()`, and then you click `e9`.
- **Not a cloud.** No account, no key, no dashboard, no telemetry. Nothing leaves the machine the browser is on.
- **Not a stealth tool.** `browser_fingerprint` exists so your tests match real user conditions on sites you own. Using it to farm accounts is a legal problem with your name on it.
- **Not Playwright with extra steps.** Playwright drives a browser it installed for you. bwb drives the one you already have — or the one in your hand.
- **Not an LLM.** `browser_act` is DOM heuristics and a scoring function, not a model with opinions. It will never hallucinate a button. It *will* hand you `candidates` and make you choose, which is both worse and better.

---

## Static first

The fastest browser is the one that doesn't start.

```
browser_goto
   │
   ├─ fetch, decode once, extract ─────────────► { mode: "static" }
   │     JSON · XML · CSV · robots.txt · dead URLs included
   │
   └─ JS detected ──► Chromium starts on that same URL ──► { mode: "browser", reason }
```

`mode: "static"` is not a cache warming up. It means no browser process exists yet, and the next tool that needs one materializes it on the URL you already navigated to — same page, same cookies, no `about:blank` in between. A dead URL doesn't deserve a browser, so it doesn't get one.

- `--always-browser` skips the rung entirely, for people who enjoy the fan noise.
- Cookies from `browser_saveCookies` are carried into the static fetch, so a logged-in page is not reported as public with `confidence: "high"` — a bug that shipped once and is now a test.

---

## 4.5 — Meridian

The release that closed the gap with the big frameworks without importing either of them, and without adding 200MB to apologise for. bwb went from *reads and clicks* to *operates a page*.

| Added | What it means |
|---|---|
| **`browser_snapshot`** | The accessibility tree with `[ref=e12]` on everything actionable. Refs are per tab, so two agents cannot clobber each other's snapshot — a race fixed by having the feature, not by documenting it |
| **Full interaction surface** | `hover`, `select`, `press`, `scroll`, `drag`, `upload`, `dialog` — the seven things an agent hits on the second page of any real task |
| **Always-on telemetry** | `browser_console` and `browser_network` record from attach: 300 console entries, 400 requests, status/size/duration. Metadata only — never bodies, never cookie values |
| **`browser_waitFor`** | Text, ref, selector, URL or network-idle. Stop sleeping and hoping |
| **Page extraction** | `browser_extract` returns whole structures — links, tables, forms, JSON-LD — instead of four thousand tokens of `<div>` |
| **Frames and storage** | `browser_frames` names every frame; `browser_storage` lists keys, sizes, flags, and not once a value |

Two things are deliberately absent. **PDF export** — `printToPDF` is desktop-only, so it would fail exactly where bwb lives. **Request interception** — that is not a tool, that is a routing engine with opinions about your traffic. 4.6 gets the headache.

One honest number, because you'd find it anyway: on a dense page the accessibility snapshot measured **7,561 characters against 7,160 of HTML**. It is not smaller. It is *actionable*, which is the part that was missing — raw HTML is a screenshot with extra steps for an agent that can't look at one.

---

## Tools

41 of them, all documented below, because a tool an agent cannot discover is a tool that does not exist. Every response carries a `[bwb resources]` footer — MCP and Chromium MB, open tabs, `ok` / `watch` / `critical` — and on critical, bwb sheds tabs itself and says so. Read the footer before spawning more work.

### Look

| Tool | Does |
|---|---|
| **`browser_snapshot`** | Accessibility tree with refs. Start here on any unfamiliar page |
| `browser_text` | Visible text of the page or one selector |
| `browser_html` | HTML of the page or one selector |
| `browser_elements` | Interactive elements by kind — links, buttons, inputs, headings |
| `browser_extract` | Whole structures: `links`, `tables`, `forms`, `structured` |
| `browser_frames` | Every frame and its id, for `browser_snapshot({frameId})` |
| `browser_screenshot` | Whole page, viewport or one element — to disk and back as base64 |
| `browser_storage` | `localStorage` / `sessionStorage` / cookies: names, sizes, flags. Never values |

### Act

| Tool | Does |
|---|---|
| `browser_click` | Click by ref or selector, native CDP mouse events |
| `browser_fill` | Fill a field by ref or selector, native keyboard events |
| `browser_hover` | Real pointer onto a ref — `:hover`, menus, tooltips |
| `browser_select` | Native `<select>` by value, label or index; fires `input` + `change` |
| `browser_press` | A key or chord at focus — `Enter`, `Tab`, `Control+a` |
| `browser_scroll` | Wheel scroll, scroll-to-ref, or jump to top/bottom |
| `browser_drag` | Drag one ref onto another with real mouse motion |
| `browser_upload` | Put files into `<input type=file>` without the OS picker |
| **`browser_act`** | Natural language — "search for X", "click the button". Ambiguity returns `candidates`, not a coin flip |
| **`needs_human`** | Hand the phone to the human: login, captcha, 2FA, payment |

### Observe

| Tool | Does |
|---|---|
| `browser_console` | Console output, uncaught exceptions, browser logs |
| `browser_network` | Every request: status, size, duration, failure |
| **`browser_watch`** | Live stream of console, network, errors, navigation |
| **`browser_diagnose`** | Page health: timings, errors, broken images, heuristic score |
| `browser_waitFor` | Wait for text, ref, selector, URL or network idle |
| `browser_waitForSelector` | Wait for an element to appear or disappear |
| `browser_dialog` | Answer `alert` / `confirm` / `prompt`: standing policy or this one |

### Navigate and tabs

| Tool | Does |
|---|---|
| `browser_goto` | Static-first navigation — `mode: auto \| static \| browser` |
| `browser_back` | History back |
| `browser_newTab` | Open a tab |
| `browser_closeTab` | Close a tab |
| `browser_switchTab` | Switch to a tab |
| `browser_listTabs` | Every tab, its URL, and who owns it |

### Session

| Tool | Does |
|---|---|
| `browser_saveCookies` | Persist a session to disk (mode `600`), optionally `domains: [...]` |
| `browser_loadCookies` | Restore it into a fresh browser |
| `browser_listSessions` | What is saved |
| **`browser_fingerprint`** | Anti-detection patches for sites you own or are authorised to test |

### Files

| Tool | Does |
|---|---|
| `browser_download` | Media via system `yt-dlp`, consent-gated, never through a shell |
| `browser_export` | Markdown / txt / html, confined to the export directory |

### Runtime

| Tool | Does |
|---|---|
| `browser_status` | Connection, live resources, active profile, `targets` (title + URL) |
| `browser_restart` | Restart the browser |
| `browser_eval` | Execute JavaScript, with exception capture |
| `browser_setViewport` | Change viewport size |

---

## Drishti — the screen

```bash
bwb pair        # a code goes to the phone; approve it there
bwb             # auto-detects the paired token and the app
bwb drishti     # doctor: pairing, relay, app, contract, token, tabs, leases, control
bwb note "no, the second link"   # steer the running agent, mid-flight
bwb notes       # peek at the backlog without consuming it
```

One tap to pair, and the agent is a guest in the browser you are holding. This is the only setup in the world where "attach the debugger" means physically gripping the phone.

The app is built on Android's WebView — the same engine inside Chrome, shipped by the OS, zero megabytes to download. That is an engineering choice, not the idea: it is why Drishti starts instantly, why it cannot drift out of version sync with the phone, and why the page survives memory pressure that deletes a headless Chromium spawned under Termux.

- **Attach only.** Never launches a browser, never kills anything, never restores a journal.
- **Your tabs stay yours.** bwb never closes or navigates a tab it did not open; `browser_listTabs` marks them `owned: false`.
- **Tabs are leased, not grabbed.** The registry tracks one exclusive writer per tab, 120 s, renewed by working. A 409 names the holder in `held_by`, so back off instead of retrying into the same wall. Being honest about the current limit: the lease is tracked at the registry, not yet enforced on the CDP socket — it stops two agents from *disagreeing* through `/bwb/tabs`, not one of them from sending `Input` to a tab it does not hold. Closing that is the first item in 1.1. The human, meanwhile, cannot be overwritten at all: USER mode blocks mutating CDP methods at the relay.
- **Takeover is a pause.** Tap *Take control* and the blocked command long-polls `GET /bwb/state?wait=30` — one held request, not a hot loop — then resumes the same step when you hand back.
- **Silence is never consent.** The approval wait reads your decision, not the absence of a refusal. No answer before the timeout is a denial, the same as tapping Deny.
- **The human cannot be locked out of their own phone.** No lease, no queue, no "please wait".
- **The phone shows what bwb is doing** in plain language ("Clicking #submit"), never typed values or page content.
- **It asks, it never bypasses.** Logins, captchas, 2FA and payments go through `needs_human`, which asks the person holding the device and waits.
- **Steering is not chat.** You watch a click go to the wrong thing, tap the sheet, type "no, the second link" — and it appears in the agent's very next tool result. There is no reply field, no reply route, and none planned: delivery is pull, because the relay has no channel to push through, and the cursor never hands the same note over twice. A note you send is a correction to the plan, not the opening of a conversation. From Termux, `bwb note "…"` does the same thing.

```text
✓ paired: token ••••a1b2 on port 9222
✓ relay: listening on 127.0.0.1:9222
✓ app: Drishti 1.0.0
✓ contract: v2 (tab leases, last_help) · 10 capabilities
✓ token: WebView (Android-Package: com.bwb.drishti)
✓ tabs: 3 page target(s)
✓ leases: 2/12 tabs, 1 leased (3f2a9c4e→bwb-a1b2c3)
✓ control: mode=AGENT · last decision: denied blocked.example
```

The wire format is [docs/DRISHTI-CONTRACT.md](docs/DRISHTI-CONTRACT.md), a verbatim copy of the app's contract, asserted by both test suites against the same fixtures — so "works on my phone" has a checksum.

---

## Security

bwb drives a real, logged-in browser for a model reading pages it does not control. That is the threat model, and it is not a comfortable one. The defaults are picked for it.

| Guarantee | What it stops |
|---|---|
| **http(s) only** | `file:`, `javascript:`, `data:`, `chrome:`, `devtools:` and `view-source:` are refused — "open file:///etc/passwd and summarise it" returns an error, not your files |
| **No private addresses, on every redirect hop** | SSRF into `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7` — on a cloud box that is the difference between reading a website and reading the metadata service. `BWB_ALLOW_PRIVATE=1` for local dev |
| **Chromium sandbox stays on** | `--no-sandbox` only on Termux, as root, or with `BWB_NO_SANDBOX=1`. I am not that brave on your behalf |
| **Session files are credentials** | `~/.bwb/sessions/*.json`, `600` inside `700`, live logins for every domain visited. Treat it like a password, because it is one |
| **Journal keeps origin + path only** | OAuth callbacks, magic links and reset tokens never reach disk |
| **Export is confined** | No `output_path` argument, so an injected page cannot aim it at `~/.bashrc` |
| **`--readonly`** | Every state-changing tool refused — for browsing untrusted sites |
| **Destructive clicks need `force:true`** | `browser_act` will not click "Delete account" on a heuristic |
| **Page text is untrusted** | Prompt injection is the real threat. Instructions inside page content are data. Do not let a page talk your agent into `browser_eval`, `browser_export` or `browser_download` |
| **In Drishti mode, the human holds the keys** | Site approvals, tab leases and takeover all belong to the person holding the phone. The agent cannot grant itself any of them |

---

## Where it runs

| Platform | Status | Notes |
|---|---|---|
| Termux / Android | ✅ Verified | `pkg install chromium`, then npm. The whole reason this exists |
| Android + Drishti | 🟡 Built, device pending | No Chromium to install at all — the app is the browser. Unit-tested and CI-built; the on-device checklist in the app repo has not been run yet |
| Linux | ✅ Verified | Chrome or Chromium, auto-detected |
| macOS | ✅ Verified | Chrome.app auto-detected |
| CI (GitHub Actions) | ✅ Tested | Unit suite on Node 18/20/22, browser suite on 22 |
| Windows | 🟡 Supported, untested | Auto-detects Chrome.exe; `ps`/`which` are Linux-only, so process sampling politely gives up and reports itself |
| Docker | 🟡 Supported, untested | Runs as root, so the sandbox turns itself off and pretends that's fine |

---

## Wire it up

```json
{ "mcpServers": { "bwb": { "command": "bwb" } } }
```

`bwb --setup` writes this into every agent it detects — OpenCode, Claude Code, Antigravity, Hermes, Cline, Continue, Codex CLI — with timestamped backups. It is a dry run until you pass `--yes`: nothing writes to your config while you're merely reading. I know exactly how that sounds, and I've been burned too.

Useful flags: `--readonly` · `--allow-domains a.com,b.com` · `--always-browser` · `--attach-port 9222` (drive a window you already opened) · `--drishti`. Per-agent details live in [AGENTS.md](./AGENTS.md), which is also the file to hand to the agent itself instead of explaining MCP to it again.

---

## History

Every release, including the 4.1.0 correctness pass and 4.0's static-first ladder, is in the [changelog](./CHANGELOG.md).

MIT — Krish Tiwari ([@krshforever](https://github.com/krshforever)). Sponsorship is welcome and buys you nothing: no pro tier, no gating, MIT forever.

And the pitch, one last time: a plain page never starts a browser, and a Chrome tab still costs 746MB. Everything above is just me refusing to accept the second number.
