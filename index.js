import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';

const BASE_URL = 'https://feed.neuraspheres.com';
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

  const clients = [
    {
      name: 'Claude Desktop',
      configPath:
        plat === 'darwin'
          ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
          : plat === 'win32'
          ? path.join(appdata, 'Claude', 'claude_desktop_config.json')
          : null,
      entry: { url: `${BASE_URL}/api/mcp` },
    },
    {
      name: 'Claude Code',
      configPath: path.join(home, '.claude', 'mcp.json'),
      entry: { type: 'http', url: `${BASE_URL}/api/mcp` },
    },
    {
      name: 'Cursor',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      entry: { url: `${BASE_URL}/api/mcp` },
    },
  ];

  console.log('Installing NeuraFeed MCP server...\n');

  let found = 0;

  for (const client of clients) {
    if (!client.configPath) continue;

    const dir = path.dirname(client.configPath);
    const dirExists = fs.existsSync(dir);
    const fileExists = fs.existsSync(client.configPath);

    // Skip clients that are not installed on this machine
    if (!dirExists && !fileExists) continue;

    found++;

    let config = { mcpServers: {} };

    if (fileExists) {
      try {
        const raw = fs.readFileSync(client.configPath, 'utf8');
        config = JSON.parse(raw);
      } catch {
        console.error(`  x ${client.name}: could not parse existing config, skipping`);
        continue;
      }
    }

    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers.neurafeed = client.entry;

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(client.configPath, JSON.stringify(config, null, 2) + '\n');
      const action = fileExists ? 'updated' : 'created';
      console.log(`  + ${client.name}: ${action} ${client.configPath}`);
    } catch (err) {
      console.error(`  x ${client.name}: ${err.message}`);
    }
  }

  console.log('');

  if (found === 0) {
    console.log('No supported MCP clients detected on this machine.');
    console.log('');
    console.log('Supported clients: Claude Desktop, Claude Code, Cursor');
    console.log('');
    console.log('Add it manually by pasting this into your client\'s MCP config:');
    console.log('');
    console.log(JSON.stringify({ mcpServers: { neurafeed: { url: `${BASE_URL}/api/mcp` } } }, null, 2));
  } else {
    console.log('Done. Restart your client to load the new server.');
  }
}
