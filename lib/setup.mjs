#!/usr/bin/env node
/**
 * bwb-browser --setup
 * One-command self-configuration for any AI CLI agent.
 *
 * Detects installed agents, writes MCP config entries, verifies Chrome.
 * Run: bwb --setup
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || '/root';
const SERVER_PATH = path.resolve(__dirname, '..', 'server.mjs');

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

  for (const bin of candidates) {
    try {
      const out = execSync(`which "${bin}" 2>/dev/null || command -v "${bin}" 2>/dev/null || echo ""`, {
        encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      if (out) return { path: out, source: 'PATH' };
    } catch { /* not found */ }
  }

  return null;
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
    name: 'Claude Code',
    file: path.join(HOME, '.claude/settings.json'),
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
  const bak = file + '.bak';
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
  const { name, file, detect, add } = agent;
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

    const bak = backup(file);
    config = add(config);
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
  const alreadyDone = results.filter(r => r.status === 'already configured');
  const skipped = results.filter(r => r.status === 'skipped');
  const errors = results.filter(r => r.status === 'error');

  for (const r of results) {
    switch (r.status) {
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
  if (errors.length) console.log(`  ❌ Errors:             ${errors.length}`);
  console.log();

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

  console.log('  🚀 Ready to go! Try: browser_status\n');
  return { configured: configured.length, alreadyDone: alreadyDone.length, errors: errors.length };
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
