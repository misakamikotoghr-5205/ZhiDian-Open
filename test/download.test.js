import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { download } from '../src/main/local/download.js';

const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
function destination(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-download-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'model.gguf');
}

test('download verifies an existing file before reusing it', async (t) => {
  const dest = destination(t);
  fs.writeFileSync(dest, 'GOOD');
  const result = await download({
    url: 'https://example.invalid/model', dest, size: 4, sha256: hash('GOOD').toUpperCase(),
    fetchImpl: () => assert.fail('a valid cached file must not be downloaded again'),
  });
  assert.equal(result.skipped, true);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'GOOD');
});

test('download repairs a same-size corrupted cached file', async (t) => {
  const dest = destination(t);
  fs.writeFileSync(dest, 'BAD!');
  let requests = 0;
  const result = await download({
    url: 'https://example.invalid/model', dest, size: 4, sha256: hash('GOOD'),
    fetchImpl: async () => { requests++; return new Response('GOOD', { headers: { 'content-length': '4' } }); },
  });
  assert.equal(requests, 1);
  assert.equal(result.skipped, false);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'GOOD');
});

test('cancelling cached-file verification preserves the file and never starts a download', async (t) => {
  const dest = destination(t);
  fs.writeFileSync(dest, '');
  fs.truncateSync(dest, 8 * 1024 * 1024);
  const abort = new AbortController();
  const pending = download({
    url: 'https://example.invalid/model', dest, size: 8 * 1024 * 1024, sha256: hash('GOOD'), signal: abort.signal,
    fetchImpl: () => assert.fail('cancellation must stop before fetching a replacement'),
  });
  setImmediate(() => abort.abort());
  await assert.rejects(pending, (err) => err.kind === 'aborted');
  assert.equal(fs.statSync(dest).size, 8 * 1024 * 1024);
});

test('cancelling after receiving the body preserves the partial file for verified resumption', async (t) => {
  const dest = destination(t);
  const abort = new AbortController();
  await assert.rejects(download({
    url: 'https://example.invalid/model', dest, size: 4, sha256: hash('GOOD'), signal: abort.signal,
    fetchImpl: async () => new Response('GOOD'),
    onProgress: () => abort.abort(),
  }), (err) => err.kind === 'aborted');
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.readFileSync(dest + '.part', 'utf8'), 'GOOD');
  const result = await download({
    url: 'https://example.invalid/model', dest, size: 4, sha256: hash('GOOD'),
    fetchImpl: () => assert.fail('the complete partial file should be verified without another request'),
  });
  assert.equal(result.skipped, false);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'GOOD');
});
