#!/usr/bin/env node
/**
 * bwb-browser — Phone Demo
 * ==========================
 *
 * This script showcases bwb's power running entirely on a phone (Termux/Android).
 * Run it to see bwb in action:
 *
 *   node docs/phone-demo.mjs
 *
 * What it demonstrates:
 *   1. browser_act — natural language interaction ("search for X")
 *   2. Session persistence — save/load cookies across runs
 *   3. Multi-tab — open multiple pages simultaneously
 *   4. Stealth mode — anti-detection
 *   5. Diagnose — page health check
 *   6. browser_watch — live event capture
 *
 * This is designed to produce output suitable for a demo video/screen recording.
 */

const TRANSPORT = process.argv.includes("--stdio") ? "stdio" : "inline";

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║      bwb-browser v3.0 — Phone Demo                  ║
║      "Browser automation from your phone"            ║
╚══════════════════════════════════════════════════════╝
`);
  console.log(`Platform: ${process.platform}`);
  console.log(`Node: ${process.version}`);
  console.log(`Termux: ${process.env.PREFIX || "not detected"}`);
  console.log();

  // We'll simulate the demo sequence using a connected bwb server
  // In real usage, an AI agent would call these tools via MCP.
  // For this script, we use bwb's MCP server via Client.

  const { spawn } = await import("child_process");
  const { resolve } = await import("path");

  const serverPath = resolve(import.meta.dirname || ".", "..", "server.mjs");
  console.log(`Starting bwb server from: ${serverPath}`);

  const child = spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env },
  });

  // Connect as MCP client
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
  });

  const client = new Client({ name: "bwb-demo", version: "3.0.0" });
  await client.connect(transport);

  const call = (tool, args = {}) =>
    client.request(
      { method: "tools/call", params: { name: tool, arguments: args } },
      {},
      (result) => result
    );

  try {
    console.log("\n📱 PHONE DEMO SEQUENCE\n");

    // ─── 1. STATUS ─────────────────────────────────
    console.log("─── 1. browser_status (no browser yet) ───");
    let status = await call("browser_status");
    console.log(`  Browser running: ${JSON.parse(status.content[0].text).running}`);
    console.log();

    // ─── 2. NAVIGATE ────────────────────────────────
    console.log("─── 2. browser_goto (CNN.com) ───");
    let goto = await call("browser_goto", { url: "https://www.cnn.com" });
    console.log(`  Page: ${JSON.parse(goto.content[0].text).title}`);
    console.log();

    // ─── 3. SCREENSHOT ─────────────────────────────
    console.log("─── 3. browser_screenshot ───");
    let ss = await call("browser_screenshot", { quality: 60 });
    const ssData = JSON.parse(ss.content[1]?.text || ss.content[0]?.text || "{}");
    console.log(`  Screenshot: ${ssData.savedTo || "captured"}`);
    console.log();

    // ─── 4. DIAGNOSE ───────────────────────────────
    console.log("─── 4. browser_diagnose (page health check) ───");
    let diag = await call("browser_diagnose");
    const report = JSON.parse(diag.content[0].text);
    console.log(`  Health score: ${report.score}/100`);
    console.log(`  Links: ${report.interactions.links}, Inputs: ${report.interactions.inputs}`);
    console.log(`  Console errors: ${report.issues.consoleErrors.length}`);
    console.log(`  Broken images: ${report.issues.brokenImages.length}`);
    console.log();

    // ─── 5. BROWSER_ACT — Search ───────────────────
    console.log("─── 5. browser_act (natural language search) ───");
    let act = await call("browser_act", { instruction: "search for breaking news today" });
    const actResult = JSON.parse(act.content[0].text);
    console.log(`  Action: ${actResult.action}`);
    console.log(`  Query: ${actResult.query || actResult.target || "N/A"}`);
    console.log(`  Title: ${actResult.title || actResult.pageTitle || ""}`);
    console.log();

    // ─── 6. BROWSER_WATCH ─────────────────────────
    console.log("─── 6. browser_watch (live event capture) ───");
    await call("browser_watch", { action: "start", events: ["console", "network"] });
    await call("browser_goto", { url: "https://example.com" });
    let events = await call("browser_watch", { action: "poll" });
    const pollData = JSON.parse(events.content[0].text);
    console.log(`  Events captured (since start): ${pollData.count}`);
    console.log(`  Types: ${[...new Set(pollData.events.map(e => e.type))].join(", ")}`);
    await call("browser_watch", { action: "stop" });
    console.log();

    // ─── 7. SESSION PERSISTENCE ────────────────────
    console.log("─── 7. browser_saveCookies (session persistence) ───");
    let save = await call("browser_saveCookies", { name: "demo-session" });
    const saveData = JSON.parse(save.content[0].text);
    console.log(`  Saved: ${saveData.cookieCount} cookies → ${saveData.name}`);
    console.log();

    // ─── 8. MULTI-TAB ──────────────────────────────
    console.log("─── 8. Multi-tab: newTab + switchTab + listTabs ───");
    let tab1 = await call("browser_newTab", { url: "https://example.com" });
    console.log(`  Tab 1: ${JSON.parse(tab1.content[0].text).tab}`);
    let tab2 = await call("browser_newTab", { url: "https://httpbin.org/ip" });
    console.log(`  Tab 2: ${JSON.parse(tab2.content[0].text).tab}`);
    let tabs = await call("browser_listTabs");
    const tabsData = JSON.parse(tabs.content[0].text);
    console.log(`  Open tabs: ${tabsData.count}`);
    console.log();

    // ─── 9. STEALTH ────────────────────────────────
    console.log("─── 9. browser_fingerprint (realistic profile) ───");
    let fp = await call("browser_fingerprint");
    const fpData = JSON.parse(fp.content[0].text);
    console.log(`  Status: ${fpData.status}`);
    console.log(`  Techniques: ${fpData.techniques?.length || 0} applied`);
    console.log();

    // ─── 10. RESTART ────────────────────────────────
    console.log("─── 10. browser_restart (clean state) ───");
    let restart = await call("browser_restart");
    console.log(`  Status: ${JSON.parse(restart.content[0].text).status}`);
    console.log();

    // ─── SUMMARY ──────────────────────────────────
    console.log(`
╔══════════════════════════════════════════════════════╗
║  DEMO COMPLETE                                       ║
║                                                      ║
║  bwb-browser v3.0 ran 10 demo steps on:              ║
║  ${process.platform} · Node ${process.version}                   ║
║                                                      ║
║  25 tools · 76KB source · works on your phone        ║
╚══════════════════════════════════════════════════════╝
`);

  } catch (err) {
    console.error("Demo error:", err.message);
    console.error(err.stack);
  } finally {
    await client.close();
    child.kill();
  }
}

main().catch(console.error);
