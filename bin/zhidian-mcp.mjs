#!/usr/bin/env node
// stdio bridge for MCP clients that only launch local commands (for example Claude Desktop).
// It forwards tools/list and tools/call to the running Zhidian app over its local HTTP server.
// Nothing is written to stdout except protocol messages: diagnostics go to stderr.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const NOT_RUNNING =
  'Zhidian is not running. Ask the user to start the Zhidian app, then try again.';

function discovery() {
  const file = path.join(os.homedir(), '.zhidian', 'mcp.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

let upstream = null;
let upstreamInstructions = '';

const pkgVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.5.0';
  } catch {
    return '0.5.0';
  }
})();

async function connect(clientName) {
  if (upstream) return upstream;
  const { port, token } = discovery();
  const client = new Client({ name: clientName || 'zhidian-bridge', version: pkgVersion });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  transport.onclose = () => { upstream = null; };
  transport.onerror = () => { upstream = null; };
  await client.connect(transport);
  upstreamInstructions = client.getInstructions() ?? '';
  upstream = client;
  return client;
}

// Connect once up front so the server can advertise the app's own instructions. If the app is
// not running yet the bridge still starts, and connects on the first tool call.
try {
  await connect();
} catch {
  upstream = null;
}

const server = new Server(
  { name: 'zhidian', version: pkgVersion },
  { capabilities: { tools: {} }, instructions: upstreamInstructions || undefined },
);

async function withUpstream(fn) {
  const name = server.getClientVersion()?.name;
  try {
    return await fn(await connect(name));
  } catch (first) {
    upstream = null; // the app may have restarted: reconnect once
    try {
      return await fn(await connect(name));
    } catch (err) {
      process.stderr.write(`[zhidian-mcp] ${err?.message ?? err} (after: ${first?.message ?? first})\n`);
      throw err;
    }
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    return await withUpstream((c) => c.listTools());
  } catch {
    return { tools: [] };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await withUpstream((c) => c.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} }));
  } catch {
    return { isError: true, content: [{ type: 'text', text: NOT_RUNNING }] };
  }
});

await server.connect(new StdioServerTransport());
