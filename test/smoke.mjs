import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Smoke test: boot the REAL server over stdio and exercise the paths that do
// not need Chromium. Two passes — normal, and --readonly.

async function boot(extraArgs = []) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.mjs", ...extraArgs],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "bwb-selftest", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

function fail(msg, detail) {
  console.error(`FAIL: ${msg}${detail ? `\n  ${detail}` : ""}`);
  process.exitCode = 1;
}

const text = (r) => r.content.map((c) => c.text || "").join("\n");

// ─── Normal mode ──────────────────────────────────────────────────────────────
{
  const { client, transport } = await boot();

  const { tools } = await client.listTools();
  console.log(`tools: ${tools.length}`);
  if (tools.length !== 26) fail(`expected 26 tools, got ${tools.length}`);

  const names = tools.map((t) => t.name);
  const dupes = names.filter((n, i, a) => a.indexOf(n) !== i);
  if (dupes.length) fail(`duplicate tools: ${dupes.join(", ")}`);
  for (const t of tools) {
    if (!t.description || t.description.length < 20) fail(`${t.name} has an unusable description`);
    if (/GROUNDBREAKING/i.test(t.description)) fail(`${t.name} still carries marketing text`);
  }

  const sessions = await client.callTool({ name: "browser_listSessions", arguments: {} });
  if (!/"sessions"/.test(text(sessions))) fail("browser_listSessions returned nothing", text(sessions));
  console.log("browser_listSessions ok");

  const fileGoto = await client.callTool({ name: "browser_goto", arguments: { url: "file:///etc/passwd" } });
  if (!/Blocked URL scheme/.test(text(fileGoto))) fail("file:// was not refused", text(fileGoto));
  const jsGoto = await client.callTool({ name: "browser_goto", arguments: { url: "javascript:alert(1)" } });
  if (!/Blocked URL scheme/.test(text(jsGoto))) fail("javascript: was not refused", text(jsGoto));
  const metaGoto = await client.callTool({ name: "browser_goto", arguments: { url: "http://169.254.169.254/" } });
  if (!/Refusing to fetch a private/.test(text(metaGoto))) fail("metadata address not refused", text(metaGoto));
  console.log("browser_goto refuses file:, javascript: and the metadata address ok");

  const escape = await client.callTool({
    name: "browser_export",
    arguments: { text: "x", format: "md", filename: "../../.bashrc" },
  });
  if (!/Refusing path outside/.test(text(escape))) fail("export path escape not refused", text(escape));
  const abs = await client.callTool({
    name: "browser_export",
    arguments: { text: "x", format: "md", filename: "/etc/cron.d/pwn" },
  });
  if (!/Refusing path outside/.test(text(abs))) fail("absolute export path not refused", text(abs));
  const good = await client.callTool({
    name: "browser_export",
    arguments: { text: "# selftest", format: "md", filename: "selftest.md", overwrite: true },
  });
  if (!/exported/.test(text(good))) fail("export failed", text(good));
  console.log("browser_export is confined to the export dir ok");

  await client.close();
  await transport.close();
}

// ─── Readonly mode ────────────────────────────────────────────────────────────
{
  const { client, transport } = await boot(["--readonly"]);
  const click = await client.callTool({ name: "browser_click", arguments: { selector: "#x" } });
  if (!/--readonly/.test(text(click))) fail("readonly did not block browser_click", text(click));
  const evalCall = await client.callTool({ name: "browser_eval", arguments: { expression: "1+1" } });
  if (!/--readonly/.test(text(evalCall))) fail("readonly did not block browser_eval", text(evalCall));
  // Reading is still allowed.
  const list = await client.callTool({ name: "browser_listTabs", arguments: {} });
  if (!/tabs/.test(text(list))) fail("readonly blocked a read-only tool", text(list));
  console.log("--readonly blocks writes, keeps reads ok");

  await client.close();
  await transport.close();
}

if (process.exitCode) console.log("SELFTEST FAILED");
else console.log("SELFTEST OK");