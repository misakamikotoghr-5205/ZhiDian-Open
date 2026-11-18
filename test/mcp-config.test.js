import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpConfigs } from '../src/core/mcp-config.js';

test('Cursor and VS Code exports use each client’s native config schema and the live port/token', () => {
  const configs = buildMcpConfigs({ port: 47891, token: 'session-key', bridgePath: '/app/bin/zhidian-mcp.mjs' });
  const byId = Object.fromEntries(configs.map((c) => [c.id, c]));
  assert.deepEqual(byId.cursor.config, { mcpServers: { zhidian: { url: 'http://127.0.0.1:47891/mcp', headers: { Authorization: 'Bearer session-key' } } } });
  assert.deepEqual(byId.vscode.config, { servers: { zhidian: { type: 'http', url: 'http://127.0.0.1:47891/mcp', headers: { Authorization: 'Bearer session-key' } } } });
  assert.deepEqual(byId.http.config, { transport: 'streamable-http', url: 'http://127.0.0.1:47891/mcp', headers: { Authorization: 'Bearer session-key' } });
  assert.ok(configs.every((c) => c.label && c.description));
});

test('Claude Desktop and generic stdio configs preserve executable arguments without shell quoting', () => {
  const bridgePath = 'C:\\Users\\张三\\My Apps\\指点\\bin\\zhidian-mcp.mjs';
  const configs = buildMcpConfigs({ port: 47600, token: 'never-in-stdio', bridgePath });
  const desktop = configs.find((c) => c.id === 'claude-desktop').config;
  const generic = configs.find((c) => c.id === 'stdio').config;
  assert.deepEqual(desktop, { mcpServers: { zhidian: { command: 'node', args: [bridgePath] } } });
  assert.deepEqual(generic, { command: 'node', args: [bridgePath] });
  assert.equal(JSON.parse(JSON.stringify(desktop)).mcpServers.zhidian.args[0], bridgePath);
  assert.doesNotMatch(JSON.stringify([desktop, generic]), /never-in-stdio/);
});

test('generated JSON preserves special token/path characters and updates across application restarts', () => {
  const first = buildMcpConfigs({ port: 1, token: 'old', bridgePath: '/old' });
  const token = 'new "token" \\ slash';
  const next = buildMcpConfigs({ port: 2, token, bridgePath: '/new dir/bridge.mjs' });
  const parsed = JSON.parse(JSON.stringify(next));
  const http = parsed.find((c) => c.id === 'http').config;
  assert.equal(http.url, 'http://127.0.0.1:2/mcp');
  assert.equal(http.headers.Authorization, `Bearer ${token}`);
  assert.equal(first.find((c) => c.id === 'http').config.headers.Authorization, 'Bearer old');
});
