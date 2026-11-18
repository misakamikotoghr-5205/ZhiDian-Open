import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer } from '../src/main/mcp.js';

const basicService = () => ({ list: () => [], deref: async () => null, point: async () => ({ ok: true, message: 'pointed' }) });

async function fixture(t, extra = {}) {
  const server = await startMcpServer({ port: 0, token: 'context-test-token', service: { ...basicService(), ...extra }, version: '0.3.0' });
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await server.close();
  });
  return {
    server,
    async client(name) {
      const client = new Client({ name, version: '1.0.0' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer context-test-token' } },
      }));
      return client;
    },
  };
}

test('optional context tools leave the original pin tools available to existing clients', async (t) => {
  const f = await fixture(t);
  const client = await f.client('arbitrary-mcp-client');
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['list_referents', 'get_referent', 'point_at']);
  assert.equal((await client.callTool({ name: 'list_referents', arguments: {} })).isError, undefined);
});

test('Cursor and VS Code clients can read captured evidence and propose a plan without executing actions', async (t) => {
  const evidence = {
    app: 'Word', title: '季度报告.docx', selectedText: '实际选中的段落',
    documents: [{ name: '季度报告.docx', content: '来自当前文件的摘录' }],
    controls: [{ id: 'save', name: '保存', role: 'button' }],
    availableActions: [{ id: 'control.save.invoke', label: '点击 保存' }],
  };
  const proposed = [];
  let executed = 0;
  let reads = 0;
  const f = await fixture(t, {
    async context() { reads++; return evidence; },
    async proposeContextPlan(plan) {
      proposed.push(plan);
      return { ok: true, plan: { id: 'pending-' + proposed.length, ...plan, requiresConfirm: true } };
    },
    execute() { executed++; throw new Error('MCP must never execute'); },
  });
  for (const name of ['Cursor', 'Visual Studio Code']) {
    const client = await f.client(name);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name), ['list_referents', 'get_referent', 'point_at', 'get_app_context', 'propose_app_actions']);
    assert.equal(tools.find((tool) => tool.name === 'get_app_context').annotations.readOnlyHint, true);
    assert.equal(tools.find((tool) => tool.name === 'propose_app_actions').annotations.destructiveHint, false);
    const result = await client.callTool({ name: 'get_app_context', arguments: {} });
    assert.deepEqual(JSON.parse(result.content[0].text), evidence);
    const proposal = await client.callTool({ name: 'propose_app_actions', arguments: { summary: '保存当前报告', steps: [{ actionId: 'control.save.invoke' }] } });
    assert.equal(proposal.isError, false);
    const response = JSON.parse(proposal.content[0].text);
    assert.equal(response.ok, true);
    assert.equal(response.executed, false);
    assert.equal(response.plan.requiresConfirm, true);
    assert.match(response.nextStep, /click Execute/);
    assert.equal(executed, 0);
  }
  assert.equal(reads, 2);
  assert.equal(proposed.length, 2);
  assert.deepEqual(proposed[0], { summary: '保存当前报告', steps: [{ actionId: 'control.save.invoke' }] });
});

test('proposal schema rejects oversized plans, unbounded text and invented execution fields before calling the service', async (t) => {
  let calls = 0;
  const f = await fixture(t, { proposeContextPlan: async () => { calls++; return { ok: true }; } });
  const client = await f.client('generic-client');
  const tool = (await client.listTools()).tools.find((tool) => tool.name === 'propose_app_actions');
  assert.equal(tool.inputSchema.properties.steps.maxItems, 6);
  assert.equal(tool.inputSchema.properties.summary.maxLength, 2000);
  const bad = [
    { summary: '', steps: [{ actionId: 'file.open.0' }] },
    { summary: 'x'.repeat(2001), steps: [{ actionId: 'file.open.0' }] },
    { summary: 'empty', steps: [] },
    { summary: 'long', steps: Array.from({ length: 7 }, () => ({ actionId: 'file.open.0' })) },
    { summary: 'bad param', steps: [{ actionId: 'file.open.0', param: 42 }] },
    { summary: 'long param', steps: [{ actionId: 'file.open.0', param: 'x'.repeat(4001) }] },
    { summary: 'bad target', steps: [{ actionId: 'x'.repeat(161) }] },
    { summary: 'extra field', steps: [{ actionId: 'file.open.0', command: 'run-something' }] },
  ];
  for (const args of bad) {
    const response = await client.callTool({ name: 'propose_app_actions', arguments: args });
    assert.equal(response.isError, true, args.summary.slice(0, 20));
  }
  assert.equal(calls, 0);
  const valid = await client.callTool({ name: 'propose_app_actions', arguments: { summary: '填写文本', steps: [{ actionId: 'control.editor.setvalue', param: '你好' }] } });
  assert.equal(valid.isError, false);
  assert.equal(calls, 1);
});

test('missing context and rejected action IDs return actionable tool errors', async (t) => {
  const f = await fixture(t, {
    context: async () => null,
    proposeContextPlan: async () => ({ ok: false, error: '这个动作不属于当前应用或文件。' }),
  });
  const client = await f.client('VSCode');
  const context = await client.callTool({ name: 'get_app_context', arguments: {} });
  assert.equal(context.isError, true);
  assert.match(context.content[0].text, /F8/);
  const proposal = await client.callTool({ name: 'propose_app_actions', arguments: { summary: '未知动作', steps: [{ actionId: 'not-an-action' }] } });
  assert.equal(proposal.isError, true);
  const response = JSON.parse(proposal.content[0].text);
  assert.equal(response.executed, false);
  assert.match(response.error, /不属于/);
});

test('context endpoints retain bearer authentication and browser-origin rejection', async (t) => {
  let reads = 0;
  const f = await fixture(t, { context: async () => { reads++; return { app: 'private' }; } });
  const url = `http://127.0.0.1:${f.server.port}/mcp`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_app_context', arguments: {} } });
  const unauthenticated = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(unauthenticated.status, 401);
  await unauthenticated.text();
  const browser = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer context-test-token', origin: 'https://untrusted.example' }, body });
  assert.equal(browser.status, 403);
  await browser.text();
  assert.equal(reads, 0);
});
