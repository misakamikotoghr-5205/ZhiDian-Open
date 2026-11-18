// Real settings UI and IPC, with local HTTP fixtures for API/model discovery. No cloud calls.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requests = [];
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  requests.push({ path: req.url, auth: req.headers.authorization });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: JSON.parse(body).model === 'my-8b' ? ['completion'] : ['completion', 'vision'] }));
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'my-8b' }, { id: 'my-vision' }] }));
  return res.end(JSON.stringify({ data: [{ id: 'remote-vision', supports_vision: true }, { id: 'remote-text', supports_vision: false }] }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const host = new URL(origin).host;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-connections-'));
const keyA = 'test-api-profile-one-012345';
const keyB = 'test-api-profile-two-678901';
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  seenIntro: false, actions: { ambient: false }, mcp: { enabled: false },
  local: { mode: 'external', externalPreset: 'ollama', externalUrl: origin + '/v1', externalModel: 'my-8b' },
  cloud: { provider: 'openai', model: 'legacy-model', baseUrl: origin + '/legacy/v1', key: 'v1:raw:' + Buffer.from(keyA).toString('base64'), keyHost: host },
}));
let app;
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', repo, '--rehearse'], env: { ...process.env, NODE_OPTIONS: '', ZHIDIAN_TEST: '1', ZHIDIAN_USER_DATA: userData, ZHIDIAN_LOCAL_DIR: path.join(userData, 'local') } });
  let page;
  for (let i = 0; i < 100; i++) {
    page = app.windows().find((w) => w.url().split('#')[0].endsWith('/settings.html'));
    if (page) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(page);
  const errors = []; page.on('pageerror', (err) => errors.push(err.message));
  await page.waitForSelector('#cpreset option', { state: 'attached' });
  if (process.env.E2E_OUT) {
    fs.mkdirSync(process.env.E2E_OUT, { recursive: true });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: path.join(process.env.E2E_OUT, 'settings-overview.png') });
  }
  assert.equal(await page.locator('.profile-card').count(), 1, 'the existing connection migrates');
  assert.equal(await page.inputValue('#cpreset'), 'custom', 'an existing OpenAI-compatible endpoint must not be labelled Anthropic');
  await page.locator('#probe').click();
  await page.waitForFunction(() => document.querySelector('#extmodels').options.length === 3);
  await page.selectOption('#extmodels', 'my-8b');
  await page.waitForFunction(() => document.querySelector('#extvision').value === 'text');
  assert.equal(await page.inputValue('#extmodel'), 'my-8b');
  await page.selectOption('#extmodels', 'my-vision');
  await page.waitForFunction(() => document.querySelector('#extvision').value === 'vision');
  assert.equal(await page.inputValue('#extmodel'), 'my-vision');
  if (process.env.E2E_OUT) { fs.mkdirSync(process.env.E2E_OUT, { recursive: true }); await page.screenshot({ path: path.join(process.env.E2E_OUT, 'settings-local.png') }); }

  await page.locator('[data-section="cloud"]').click();
  await page.locator('#cnew').click();
  await page.waitForFunction(() => document.querySelectorAll('.profile-card').length === 2);
  await page.selectOption('#cpreset', 'deepseek');
  await page.waitForFunction(() => document.querySelector('#curl').value === 'https://api.deepseek.com/v1');
  assert.equal(await page.inputValue('#cmodel'), 'deepseek-chat');
  assert.equal(await page.inputValue('#cvision'), 'text');
  await page.evaluate(async (baseUrl) => window.zhidian.settings.cloud.update({ presetId: 'custom', baseUrl, model: '' }), origin + '/second/v1');
  await page.fill('#ckey', keyB); await page.locator('#cksave').click();
  await page.waitForFunction(() => document.querySelector('#ckey').value === '' && document.querySelector('#ckeynote').textContent.includes('只用于'));
  await page.locator('#cdiscover').click();
  await page.waitForFunction(() => document.querySelector('#cmodelselect').options.length === 3);
  await page.selectOption('#cmodelselect', 'remote-text');
  await page.waitForFunction(() => document.querySelector('#cmodel').value === 'remote-text');
  assert.equal(await page.inputValue('#cvision'), 'text');
  assert.ok(requests.some((r) => r.path === '/second/v1/models' && r.auth === `Bearer ${keyB}`));
  await page.locator('.profile-card').first().getByText('切换', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#cmodel').value === 'legacy-model');
  await page.locator('#cdiscover').click();
  await page.waitForFunction(() => document.querySelector('#cmodelselect').options.length === 3);
  assert.ok(requests.some((r) => r.path === '/legacy/v1/models' && r.auth === `Bearer ${keyA}`));
  const safe = JSON.stringify(await page.evaluate(() => window.zhidian.settings.get()));
  assert.equal(safe.includes(keyA) || safe.includes(keyB) || safe.includes(Buffer.from(keyA).toString('base64')), false, 'saved keys never return through settings IPC');
  const disk = fs.readFileSync(path.join(userData, 'settings.json'), 'utf8');
  assert.equal(disk.includes(keyA) || disk.includes(keyB), false, 'new and migrated keys remain sealed on disk');
  await page.locator('.profile-card').first().getByText('重命名', { exact: true }).click();
  await page.locator('.profile-name input').fill('我的工作连接');
  await page.getByText('保存名称', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.profile-name').textContent.includes('我的工作连接'));
  if (process.env.E2E_OUT) await page.screenshot({ path: path.join(process.env.E2E_OUT, 'settings-connections.png') });
  await page.locator('.profile-card').nth(1).getByText('删除', { exact: true }).click();
  await page.locator('.profile-card').nth(1).getByText('确认删除', { exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.profile-card').length === 1);
  assert.equal(await page.inputValue('#cmodel'), 'legacy-model', 'deleting another connection preserves the active one');
  const persisted = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  assert.equal(persisted.apiProfiles.length, 1);
  assert.equal(persisted.apiProfiles[0].name, '我的工作连接');
  assert.equal(persisted.apiProfiles[0].config.key, 'v1:raw:' + Buffer.from(keyA).toString('base64'));
  await page.locator('[data-section="mcp"]').click();
  await page.selectOption('#mcpclient', 'vscode');
  assert.ok(JSON.parse(await page.locator('#mcpconfig').textContent()).servers.zhidian);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'settings fit the window without horizontal scrolling');
  assert.deepEqual(errors, []);
  console.log('PASS: legacy migration, local 8B/vision discovery, provider autofill, isolated profile keys, cloud model selection and generic MCP settings');
} finally {
  await app?.close(); server.closeAllConnections(); await new Promise((r) => server.close(r));
  fs.rmSync(userData, { recursive: true, force: true });
}
