// Real settings UI and IPC. Configuring speech never records or contacts an endpoint.
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-voice-settings-'));
let requests = 0;
const server = http.createServer((req, res) => { requests++; res.end('{}'); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const key = 'test-voice-secret-735109';
const chatKey = 'test-chat-secret-632001';
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  seenIntro: false, actions: { ambient: false }, mcp: { enabled: false },
  cloud: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'chat-model', key: 'v1:raw:' + Buffer.from(chatKey).toString('base64'), keyHost: 'api.openai.com' },
}));
let app;
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', repo, '--rehearse'], env: { ...process.env, NODE_OPTIONS: '', ZHIDIAN_TEST: '1', ZHIDIAN_USER_DATA: userData, ZHIDIAN_LOCAL_DIR: path.join(userData, 'local') } });
  let page;
  for (let i = 0; i < 100; i++) {
    page = app.windows().find((window) => window.url().split('#')[0].endsWith('/settings.html'));
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(page, 'settings window opens');
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('#vpreset option', { state: 'attached' });
  await page.locator('[data-section="voice"]').click();
  assert.equal(await page.locator('[data-section="voice"]').getAttribute('aria-current'), 'location');
  assert.equal(await page.locator('#venabled').isChecked(), false);
  assert.equal(await page.locator('#venabled').isDisabled(), true, 'chat key does not configure speech');
  assert.match(await page.locator('#vwherehint').textContent(), /上传/);
  assert.match(await page.locator('.voice-steps').textContent(), /不会自动提问/);

  await page.selectOption('#vpreset', 'groq');
  await page.waitForFunction(() => document.querySelector('#vurl').value === 'https://api.groq.com/openai/v1');
  assert.equal(await page.inputValue('#vmodel'), 'whisper-large-v3-turbo');
  await page.fill('#vkey', key);
  await page.locator('#vkeysave').click();
  await page.waitForFunction(() => document.querySelector('#vkeynote').textContent.includes('api.groq.com'));
  assert.equal(await page.inputValue('#vkey'), '', 'secret is removed from the input after saving');
  assert.match(await page.locator('#vkey').getAttribute('placeholder'), /5109/);
  await page.locator('#venabled').check();
  await page.waitForFunction(async () => (await window.zhidian.settings.get()).voice.enabled);
  const safe = JSON.stringify(await page.evaluate(() => window.zhidian.settings.get()));
  assert.equal(safe.includes(key) || safe.includes(chatKey) || safe.includes(Buffer.from(key).toString('base64')), false, 'settings API never returns voice or chat credentials');
  assert.equal((await page.locator('body').textContent()).includes(key), false);

  await page.fill('#vkey', 'unsaved-key');
  await page.selectOption('#vpreset', 'local-openai');
  await page.waitForFunction(() => document.querySelector('#vurl').value === 'http://127.0.0.1:8000/v1' && document.querySelector('#vkeydelete').hidden);
  assert.equal(await page.inputValue('#vkey'), '', 'unsaved credentials do not follow a changed destination');
  assert.equal(await page.locator('#vlocalhelp').getAttribute('open'), '');
  assert.match(await page.locator('#vwherehost').textContent(), /本机服务/);
  assert.match(await page.locator('#vlocalhelp').textContent(), /8B.*不等于语音识别模型/s);
  assert.equal(await page.locator('#venabled').isDisabled(), false, 'local service can work without a key');
  await page.selectOption('#vpreset', 'custom');
  await page.fill('#vurl', baseUrl); await page.locator('#vmodel').click();
  await page.fill('#vmodel', 'my-whisper'); await page.locator('#vlanguage').click();
  await page.fill('#vlanguage', 'EN'); await page.locator('#vurl').click();
  await page.waitForFunction(async (url) => { const v = (await window.zhidian.settings.get()).voice; return v.baseUrl === url && v.model === 'my-whisper' && v.language === 'en'; }, baseUrl);
  await page.fill('#vlanguage', ''); await page.locator('#vmodel').click();
  await page.waitForFunction(async () => (await window.zhidian.settings.get()).voice.language === '');
  await page.fill('#vkey', key); await page.locator('#vkeysave').click();
  await page.waitForFunction(() => !document.querySelector('#vkeydelete').hidden);
  await page.locator('#vkeydelete').click();
  await page.waitForFunction(() => document.querySelector('#vkeydelete').hidden);
  assert.equal((await page.evaluate(() => window.zhidian.settings.get())).voice.hasKey, false);
  const disk = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  assert.equal(disk.voice.key, '');
  assert.equal(disk.cloud.key, 'v1:raw:' + Buffer.from(chatKey).toString('base64'), 'voice key changes leave the chat key intact');
  assert.equal(requests, 0, 'settings saves never upload audio or probe the service');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'settings have no horizontal overflow');
  if (process.env.E2E_OUT) {
    fs.mkdirSync(process.env.E2E_OUT, { recursive: true });
    await page.locator('#sec-voice').screenshot({ path: path.join(process.env.E2E_OUT, 'settings-voice.png') });
  }
  await page.setViewportSize({ width: 540, height: 850 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'voice settings also fit a narrow window');
  if (process.env.E2E_OUT) await page.locator('#sec-voice').screenshot({ path: path.join(process.env.E2E_OUT, 'settings-voice-narrow.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: speech presets, separate secrets, local setup, destination disclosure, language selection, enablement and no configuration-time uploads');
} finally {
  await app?.close();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  fs.rmSync(userData, { recursive: true, force: true });
}
