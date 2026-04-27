#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const BASE_URL = 'https://feed.neuraspheres.com';
const MCP_URL = `${BASE_URL}/api/mcp`;
const args = process.argv.slice(2);

if (args[0] === 'install') {
  await install();
} else {
  await runServer();
}

// ── stdio MCP server ──────────────────────────────────────────────────────────

async function runServer() {
  const server = new McpServer({ name: 'neurafeed', version: '1.0.0' });

  server.tool(
    'get_latest_news',
    'Fetch the single most recent AI-generated news article from NeuraFeed. ' +
    'Returns a full article object: title, summary, HTML article body, tags, ' +
    'cited sources, cover image URL, and optional embedded YouTube video.',
    {},
    async () => {
      const res = await fetch(`${BASE_URL}/api/latest-news`);
      const data = await res.json();
      if (!data.article) {
        return { content: [{ type: 'text', text: 'No articles published yet.' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(data.article, null, 2) }] };
    },
  );

  server.tool(
    'get_recent_news',
    'Fetch a list of recent AI-generated news articles from NeuraFeed, sorted newest first. ' +
    'Each item is a full article object.',
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('How many articles to return (1-100). Defaults to 20.'),
    },
    async ({ limit = 20 }) => {
      const res = await fetch(`${BASE_URL}/api/recent-news?limit=${limit}`);
      const data = await res.json();
      if (!data.articles?.length) {
        return { content: [{ type: 'text', text: 'No articles available.' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(data.articles, null, 2) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ── installer ─────────────────────────────────────────────────────────────────

async function install() {
  const home = os.homedir();
  const plat = process.platform;
  const appdata = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');

  console.log('Installing NeuraFeed MCP server...\n');

  // Step 1: global npm install so the binary is in PATH
  ensureGlobalInstall();

  let found = 0;

  // Step 2: Claude Code — must use the `claude mcp add` CLI (writes to ~/.claude.json)
  if (registerClaudeCode()) found++;

  // Step 3: Claude Desktop
  const claudeDesktopPath =
    plat === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : plat === 'win32'
      ? path.join(appdata, 'Claude', 'claude_desktop_config.json')
      : null;
  if (claudeDesktopPath && patchJsonConfig('Claude Desktop', claudeDesktopPath, ['mcpServers'], { url: MCP_URL })) {
    found++;
  }

  // Step 4: Cursor (~/.cursor/mcp.json)
  if (patchJsonConfig('Cursor', path.join(home, '.cursor', 'mcp.json'), ['mcpServers'], { url: MCP_URL })) {
    found++;
  }

  // Step 5: VS Code (user settings.json — mcp.servers key, VS Code 1.99+)
  const vscodePath =
    plat === 'win32'
      ? path.join(appdata, 'Code', 'User', 'settings.json')
      : plat === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
      : path.join(home, '.config', 'Code', 'User', 'settings.json');
  if (patchJsonConfig('VS Code', vscodePath, ['mcp', 'servers'], { type: 'http', url: MCP_URL })) {
    found++;
  }

  // Cleanup: remove the old incorrect ~/.claude/mcp.json entry (Claude Code ignores that file)
  cleanupLegacyMcpJson(path.join(home, '.claude', 'mcp.json'));

  console.log('');

  if (found === 0) {
    console.log('No supported MCP clients detected on this machine.');
    console.log('');
    console.log('Supported clients: Claude Code, Claude Desktop, Cursor, VS Code');
    console.log('');
    console.log('Add it manually to your MCP config:');
    console.log('');
    console.log(JSON.stringify({ neurafeed: { url: MCP_URL } }, null, 2));
  } else {
    console.log('Done. Restart your client to load the new server.');
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function ensureGlobalInstall() {
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: 'pipe' }).trim();
    if (fs.existsSync(path.join(globalRoot, 'neurafeed-mcp'))) {
      console.log('  ✓ neurafeed-mcp already globally installed (in PATH)\n');
      return;
    }
    process.stdout.write('  Installing neurafeed-mcp globally (adds to PATH)... ');
    execSync('npm install -g neurafeed-mcp', { stdio: 'pipe' });
    console.log('done');
    console.log('  ✓ neurafeed-mcp is now in PATH\n');
  } catch {
    console.log('  ! Could not install globally — run: npm install -g neurafeed-mcp\n');
  }
}

function registerClaudeCode() {
  try {
    execSync('claude --version', { stdio: 'pipe' });
  } catch {
    // claude CLI not installed on this machine
    return false;
  }
  try {
    execSync(`claude mcp add --transport http --scope user neurafeed "${MCP_URL}"`, { stdio: 'pipe' });
    console.log('  + Claude Code: registered');
    return true;
  } catch (err) {
    const msg = String(err.stderr ?? err.message ?? '');
    // "already exists" or "already registered" means it was set up previously — treat as success
    if (/already|exists/i.test(msg)) {
      console.log('  ✓ Claude Code: already registered');
      return true;
    }
    console.error(`  x Claude Code: ${msg.trim() || 'unknown error'}`);
    return false;
  }
}

// Merges { [keyPath]: { neurafeed: entry } } into a JSON config file.
// keyPath is an array of nested keys, e.g. ['mcpServers'] or ['mcp', 'servers'].
// Skips silently if the client directory does not exist (client not installed).
function patchJsonConfig(name, configPath, keyPath, entry) {
  const dir = path.dirname(configPath);
  const fileExists = fs.existsSync(configPath);
  if (!fs.existsSync(dir) && !fileExists) return false;

  let config = {};
  if (fileExists) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      console.error(`  x ${name}: could not parse existing config, skipping`);
      return false;
    }
  }

  // Walk / create the nested key path
  let obj = config;
  for (let i = 0; i < keyPath.length - 1; i++) {
    if (typeof obj[keyPath[i]] !== 'object' || obj[keyPath[i]] === null) {
      obj[keyPath[i]] = {};
    }
    obj = obj[keyPath[i]];
  }
  const last = keyPath[keyPath.length - 1];
  if (typeof obj[last] !== 'object' || obj[last] === null) obj[last] = {};
  obj[last].neurafeed = entry;

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log(`  + ${name}: ${fileExists ? 'updated' : 'created'} ${configPath}`);
    return true;
  } catch (err) {
    console.error(`  x ${name}: ${err.message}`);
    return false;
  }
}

// Removes the neurafeed entry from the old ~/.claude/mcp.json file (which Claude
// Code never actually reads — it uses ~/.claude.json via `claude mcp add`).
function cleanupLegacyMcpJson(mcpJsonPath) {
  if (!fs.existsSync(mcpJsonPath)) return;
  try {
    const cfg = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
    if (!cfg.mcpServers?.neurafeed) return;
    delete cfg.mcpServers.neurafeed;
    if (Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers;
    fs.writeFileSync(mcpJsonPath, JSON.stringify(cfg, null, 2) + '\n');
  } catch { /* ignore */ }
}
