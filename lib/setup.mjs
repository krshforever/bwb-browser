#!/usr/bin/env node
/**
 * bwb-browser --setup
 * One-command self-configuration for any AI CLI agent.
 *
 * Detects installed agents, writes MCP config entries, verifies Chrome.
 * Run: bwb --setup
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// os.homedir(), not process.env.HOME: on Windows HOME is usually unset, and the
// old '/root' fallback made setup look in a directory nobody has.
const HOME = os.homedir();
const SERVER_PATH = path.resolve(__dirname, '..', 'server.mjs');

// ─── Dry run by default ──────────────────────────────────────────────────────
// setup edits up to eight other tools' config files. It used to do that with no
// confirmation and no way to preview; --yes applies, --dry-run (default) prints.
const ASSUME_YES = process.argv.includes('--yes');
const DRY_RUN = process.argv.includes('--dry-run') || !ASSUME_YES;

// ─── Detect Chrome/Chromium ───────────────────────────────────────
function detectChrome() {
  if (process.env.BWB_CHROME_PATH) {
    const p = process.env.BWB_CHROME_PATH;
    if (fs.existsSync(p)) return { path: p, source: 'BWB_CHROME_PATH env' };
  }

  const candidates = [
    'chromium-browser', 'chromium', 'google-chrome',
    'google-chrome-stable', 'chrome', 'brave-browser',
    '/usr/bin/chromium-browser', '/usr/bin/chromium',
    '/usr/bin/google-chrome', '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];

  // No shell: the candidate list is data. `which`/`where` is tried per bin.
  const lookups = os.platform() === 'win32' ? ['where'] : ['which', 'command -v'];
  for (const bin of candidates) {
    if (path.isAbsolute(bin) && fs.existsSync(bin)) return { path: bin, source: 'filesystem' };
    for (const cmd of lookups) {
      try {
        const args = cmd === 'command -v' ? ['-v', bin] : [bin];
        const out = execFileSync(cmd, args, {
          encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
        }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
        if (out) return { path: out, source: 'PATH' };
      } catch { /* not found */ }
    }
  }

  return null;
}

function whichExists(bin) {
  const cmd = os.platform() === 'win32' ? 'where' : 'which';
  try {
    execFileSync(cmd, [bin], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch { return false; }
}

// ─── Detect AI CLI tools ──────────────────────────────────────────
const AGENT_CONFIGS = [
  {
    name: 'OpenCode',
    file: path.join(HOME, '.config/opencode/opencode.json'),
    detect: (cfg) => !!(cfg.mcp?.bwb || cfg.mcpServers?.bwb),
    add(cfg) {
      const entry = {
        type: 'local',
        command: ['node', SERVER_PATH]
      };
      if (cfg.mcp && typeof cfg.mcp === 'object') cfg.mcp.bwb = entry;
      else if (cfg.mcpServers && typeof cfg.mcpServers === 'object') cfg.mcpServers.bwb = entry;
      else cfg.mcp = { bwb: entry };
      return cfg;
    }
  },
  {
    name: 'Antigravity (CLI)',
    file: path.join(HOME, '.gemini/config/mcp_config.json'),
    detect: (cfg) => !!(cfg.mcpServers?.bwb),
    add(cfg) {
      if (!cfg.mcpServers) cfg.mcpServers = {};
      cfg.mcpServers.bwb = {
        command: 'node',
        args: [SERVER_PATH]
      };
      return cfg;
    }
  },
  {
    name: 'Antigravity (CLI - secondary)',
    file: path.join(HOME, '.gemini/antigravity-cli/mcp_config.json'),
    detect: (cfg) => !!(cfg.mcpServers?.bwb),
    add(cfg) {
      if (!cfg.mcpServers) cfg.mcpServers = {};
      cfg.mcpServers.bwb = {
        command: 'node',
        args: [SERVER_PATH]
      };
      return cfg;
    }
  },
  {
    // Claude Code reads MCP servers from ~/.claude.json (user scope) or a
    // project .mcp.json — NOT from ~/.claude/settings.json, where the old
    // setup wrote mcpServers and then reported "✅ configured" while nothing
    // changed (anthropics/claude-code#4976, #26167). Use the CLI when it
    // exists so the write lands where Claude Code actually looks.
    name: 'Claude Code',
    file: path.join(HOME, '.claude.json'),
    detect: (cfg) => !!(cfg.mcpServers?.bwb),
    cli() {
      const add = ['mcp', 'add', '--scope', 'user', 'bwb', '--', process.execPath, SERVER_PATH];
      const print = `claude ${add.join(' ')}`;
      if (!whichExists('claude')) return { manual: print };
      if (DRY_RUN) return { manual: print };
      try {
        execFileSync('claude', add, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true, file: path.join(HOME, '.claude.json') };
      } catch (err) {
        return { manual: print, error: err.message };
      }
    },
    add(cfg) {
      if (!cfg.mcpServers) cfg.mcpServers = {};
      cfg.mcpServers.bwb = {
        command: 'node',
        args: [SERVER_PATH]
      };
      return cfg;
    }
  },
  {
    name: 'Hermes',
    file: path.join(HOME, '.hermes/mcp.json'),
    detect: (cfg) => !!(cfg.mcpServers?.bwb),
    add(cfg) {
      if (!cfg.mcpServers) cfg.mcpServers = {};
      cfg.mcpServers.bwb = {
        command: 'node',
        args: [SERVER_PATH]
      };
      return cfg;
    }
  },
  {
    name: 'Cline (VS Code)',
    file: path.join(HOME, '.cline/mcp.json'),
    detect: (cfg) => !!(cfg.mcpServers?.bwb),
    add(cfg) {
      if (!cfg.mcpServers) cfg.mcpServers = {};
      cfg.mcpServers.bwb = {
        command: 'node',
        args: [SERVER_PATH]
      };
      return cfg;
    }
  },
  {
    name: 'Continue.dev',
    file: path.join(HOME, '.continue/config.json'),
    detect: (cfg) => {
      const servers = cfg.experimental?.mcpServers || cfg.mcpServers;
      return !!(servers?.bwb);
    },
    add(cfg) {
      if (!cfg.experimental) cfg.experimental = {};
      if (!cfg.experimental.mcpServers) cfg.experimental.mcpServers = {};
      cfg.experimental.mcpServers.bwb = {
        command: 'node',
        args: [SERVER_PATH]
      };
      return cfg;
    }
  },
  {
    name: 'Codex CLI',
    file: path.join(HOME, '.codex/mcp.json'),
    detect: (cfg) => !!(cfg.mcpServers?.bwb),
    add(cfg) {
      if (!cfg.mcpServers) cfg.mcpServers = {};
      cfg.mcpServers.bwb = {
        command: 'node',
        args: [SERVER_PATH]
      };
      return cfg;
    }
  },
];

// ─── Core logic ────────────────────────────────────────────────────
function backup(file) {
  // Timestamped: a single .bak was overwritten on every re-run, so the second
  // run destroyed the only copy of the user's original config.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = `${file}.${stamp}.bak`;
  try {
    fs.copyFileSync(file, bak);
    return bak;
  } catch { return null; }
}

function writeConfigSafely(file, data) {
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

function configureAgent(agent) {
  const { name, file, detect, add, cli } = agent;

  // Some agents must be configured through their own CLI, not by editing JSON.
  if (cli) {
    const res = cli();
    if (res.ok) return { name, status: 'configured', file: res.file, via: 'claude mcp add' };
    if (res.manual) {
      return fs.existsSync(file) && detect(JSON.parse(fs.readFileSync(file, 'utf8')))
        ? { name, status: 'already configured', file }
        : { name, status: 'manual', command: res.manual, error: res.error };
    }
  }

  const fileExists = fs.existsSync(file);

  if (!fileExists) return { name, status: 'skipped', reason: 'not installed' };

  try {
    const raw = fs.readFileSync(file, 'utf8');
    let config;
    try { config = JSON.parse(raw); }
    catch { return { name, status: 'error', reason: 'invalid JSON' }; }

    if (detect(config)) {
      return { name, status: 'already configured', file };
    }

    config = add(config);
    if (DRY_RUN) {
      return { name, status: 'would configure', file };
    }
    const bak = backup(file);
    if (!writeConfigSafely(file, config)) {
      return { name, status: 'error', reason: 'write failed' };
    }

    return { name, status: 'configured', file, backup: bak };
  } catch (err) {
    return { name, status: 'error', reason: err.message };
  }
}

// ─── Permissions check ─────────────────────────────────────────────
function checkPermissions() {
  // On Termux, the HOME may be accessible. Check if we can read/write config dirs.
  const checkPaths = [
    path.join(HOME, '.config/opencode'),
    path.join(HOME, '.gemini/config'),
    path.join(HOME, '.claude'),
  ];
  const issues = [];
  for (const p of checkPaths) {
    if (fs.existsSync(p)) {
      try { fs.accessSync(p, fs.constants.R_OK | fs.constants.W_OK); }
      catch { issues.push(`${p}: no write permission`); }
    }
  }
  return issues;
}

// ─── ────────────────────────────────────────────────────────────────
export function runSetup() {
  console.log('\n  ╔══════════════════════════════════════════════╗');
  console.log('  ║        bwb-browser — Auto Setup             ║');
  console.log('  ╚══════════════════════════════════════════════╝\n');

  // 1. Self-check
  if (!fs.existsSync(SERVER_PATH)) {
    console.error(`  ❌ server.mjs not found at:\n     ${SERVER_PATH}`);
    console.error('     Is bwb-browser installed correctly?\n');
    process.exit(1);
  }
  console.log(`  📦 bwb-browser: ${SERVER_PATH}`);
  console.log(`     v${getVersion()}\n`);

  // 2. Check permissions
  const permIssues = checkPermissions();
  if (permIssues.length > 0) {
    console.log('  ⚠️  Permission notes:');
    for (const i of permIssues) console.log(`     • ${i}`);
    console.log();
  }

  // 3. Detect Chrome
  const chrome = detectChrome();
  if (chrome) {
    console.log(`  ✅ Chrome/Chromium detected:`);
    console.log(`     ${chrome.path} (${chrome.source})`);
  } else {
    console.log(`  ⚠️  Chrome/Chromium not detected.`);
    console.log(`     Install it: pkg install chromium (Termux)`);
    console.log(`     or set BWB_CHROME_PATH env var.\n`);
  }

  // 4. Configure all agents
  console.log('  🔧 Configuring agents...\n');
  const results = AGENT_CONFIGS.map(configureAgent);

  const configured = results.filter(r => r.status === 'configured');
  const would = results.filter(r => r.status === 'would configure');
  const alreadyDone = results.filter(r => r.status === 'already configured');
  const skipped = results.filter(r => r.status === 'skipped');
  const errors = results.filter(r => r.status === 'error');

  for (const r of results) {
    switch (r.status) {
      case 'would configure':
        console.log(`  📝 ${r.name}: would write ${r.file}`);
        break;
      case 'manual':
        console.log(`  📎 ${r.name}: run this yourself — bwb cannot verify it for you:`);
        console.log(`     ${r.command}`);
        if (r.error) console.log(`     (attempt failed: ${String(r.error).slice(0, 120)})`);
        break;
      case 'configured':
        console.log(`  ✅ ${r.name}: configured`);
        if (r.backup) console.log(`     backup: ${r.backup}`);
        break;
      case 'already configured':
        console.log(`  ✅ ${r.name}: already set up`);
        break;
      case 'skipped':
        break; // silent
      case 'error':
        console.log(`  ❌ ${r.name}: ${r.reason}`);
        break;
    }
  }

  // 5. Summary
  console.log('\n  ─── Summary ───────────────────────────────────────');
  console.log(`  ✅ Agents configured:  ${configured.length}`);
  console.log(`  ✅ Already set up:     ${alreadyDone.length}`);
  console.log(`  ⏭️  Not installed:      ${skipped.length}`);
  if (would.length) console.log(`  📝 Would configure:    ${would.length}  (re-run with --yes to apply)`);
  if (errors.length) console.log(`  ❌ Errors:             ${errors.length}`);
  console.log();

  if (DRY_RUN && (would.length || configured.length)) {
    console.log('  🔎 DRY RUN — nothing was written.');
    console.log('     Apply with: bwb --setup --yes\n');
  }
  if (DRY_RUN && !process.stdout.isTTY) {
    // Not a terminal => almost certainly a provisioning script or CI step.
    // A silent no-op here is the one 4.x -> 4.1.0 break that does not fail
    // loudly, so say it on stderr where scripts actually surface errors.
    console.error(
      'bwb: --setup ran in dry-run mode and wrote NOTHING.\n' +
      '      If you are scripting this, pass --yes: bwb --setup --yes\n'
    );
  }
  if (configured.length > 0) {
    console.log('  🔄 RESTART REQUIRED: Close and reopen your AI agent');
    console.log('     for the new MCP tools to take effect.\n');
  }

  if (!chrome) {
    console.log('  ⚠️  Chrome not found — install it first:');
    console.log('     Termux:  pkg install chromium');
    console.log('     macOS:   brew install --cask google-chrome');
    console.log('     Linux:   apt install chromium-browser\n');
  }

  if (!DRY_RUN) console.log('  🚀 Ready to go! Try: browser_status\n');
  printSurvivalGuide();
  return { configured: configured.length, alreadyDone: alreadyDone.length, errors: errors.length };
}

// ─── Survival Guide (v4: OOM is the enemy, not setup) ───────────────────────
// WakeLock + battery exemption don't stop LMK — footprint does. One-time notes.

function printSurvivalGuide() {
  const termux = Boolean(process.env.TERMUX_VERSION
    || process.env.PREFIX?.includes('com.termux')
    || process.env.HOME?.includes('com.termux'));
  console.log('  ─── Survival guide (read once) ───────────────────────');
  console.log('  v4 is static-first: plain pages never spawn Chromium.');
  console.log('  Lean profile auto-enables on Termux (cap 3 tabs, 5-min mayfly).');
  console.log('  Every tool response carries a [bwb resources] footer —');
  console.log('  when it reads critical, bwb sheds tabs itself and says so.');
  if (termux) {
    console.log('  Termux overnight runs:');
    console.log('    • termux-wake-lock (keeps CPU awake, does NOT stop LMK)');
    console.log('    • Exempt Termux from battery optimization (Android Settings)');
    console.log('    • The rest is footprint: fewer tabs, static-first,');
    console.log('      journal restores your working set if Android still kills.');
  }
  console.log();
}

function getVersion() {
  try {
    const pkg = path.resolve(__dirname, '..', 'package.json');
    const json = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    return json.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ─── Direct execution ──────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSetup();
}
