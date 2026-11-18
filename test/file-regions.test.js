import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatesForItem, filesInRegion, rectSelectsItem } from '../src/main/context/file-regions.js';
import { createDesktopBridge } from '../src/main/context/desktop.js';

const entries = [
  { name: '季度报告.txt', path: 'G:\\Reports\\季度报告.txt', aliases: ['季度报告'] },
  { name: '报价清单.csv', path: 'G:\\Reports\\报价清单.csv', aliases: ['报价清单'] },
];
const visible = entries.map((entry, index) => ({ name: entry.name, path: entry.path, status: 'resolved', bounds: { x: -600, y: 100 + index * 100, w: 120, h: 80 } }));
const raw = () => ({ app: 'explorer', title: 'Reports', windowId: '123', pid: 100, files: [], controls: [],
  fileSurface: { kind: 'explorer', folder: 'G:\\Reports', rows: visible, entries, truncated: false } });
const bridge = (options = {}) => createDesktopBridge({ platform: 'win32', request: async () => raw(), isFile: file => entries.some(e => e.path === file), ...options });

test('match labels only against captured Shell entries, including declared hidden-extension aliases', () => {
  assert.equal(candidatesForItem('季度报告', entries)[0].path, entries[0].path);
  assert.equal(candidatesForItem('季度报告.TXT', entries)[0].path, entries[0].path);
  assert.deepEqual(candidatesForItem('guessed.docx', entries), []);
  assert.equal(candidatesForItem('季度报…', entries).length, 1);
  assert.equal(candidatesForItem('季…', entries).length, 0);
});

test('two files sharing a visible hidden-extension name remain ambiguous', () => {
  const duplicate = [...entries, { name: '季度报告.pdf', path: 'G:\\Reports\\季度报告.pdf', aliases: ['季度报告'] }];
  assert.equal(candidatesForItem('季度报告', duplicate).length, 2);
  assert.equal(candidatesForItem('季度报告.txt', duplicate).length, 1);
});

test('screen physical rectangles select multiple unselected icons at negative monitor origins', () => {
  const result = filesInRegion(visible, { x: -610, y: 90, w: 150, h: 200 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, entries.map(e => e.path));
  assert.deepEqual(filesInRegion(visible, { x: 0, y: 0, w: 100, h: 100 }).files, []);
});

test('details view accepts icon/name crop without requiring the center of a full-width row', () => {
  const row = { ...visible[0], bounds: { x: 461, y: 346, w: 1046, h: 43 }, hitBounds: [{ x: 500, y: 351, w: 412, h: 34 }, { x: 461, y: 346, w: 39, h: 43 }] };
  assert.equal(rectSelectsItem({ x: 455, y: 340, w: 180, h: 60 }, row), true);
  assert.equal(rectSelectsItem({ x: 1200, y: 340, w: 250, h: 60 }, row), false);
  assert.equal(rectSelectsItem({ x: 459, y: 342, w: 3, h: 3 }, row), false);
});

test('mixed unknown icons are reported and block silent partial execution', () => {
  const rows = [...visible, { name: '虚拟文件夹', status: 'unresolved', bounds: { x: -600, y: 300, w: 100, h: 80 } }];
  const result = filesInRegion(rows, { x: -610, y: 90, w: 150, h: 310 });
  assert.equal(result.ok, false);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.files.length, 2);
  assert.ok(result.warnings.length);
});

test('invalid, empty or outside rectangles never resolve files', () => {
  for (const rect of [null, {}, { x: NaN, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: -1, h: 10 }]) {
    assert.equal(filesInRegion(visible, rect).ok, false);
  }
});

test('bridge uses its private captured mapping, not modified snapshot fields', async () => {
  const client = bridge();
  const snapshot = await client.captureContext();
  assert.equal(snapshot.files.length, 0, 'no Explorer selection is needed');
  snapshot.visibleFiles[0].path = 'G:\\NotCaptured\\secret.txt';
  snapshot.fileSurface.kind = 'none';
  const result = client.resolveSnapshotFiles(snapshot, visible[0].bounds);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, [entries[0].path]);
  assert.equal(client.resolveSnapshotFiles({ ...snapshot }, visible[0].bounds).ok, false);
});

test('stale, deleted and unsupported window snapshots are refused', async () => {
  let now = 0, exists = true;
  const client = bridge({ now: () => now, isFile: () => exists });
  const snapshot = await client.captureContext();
  exists = false;
  assert.deepEqual(client.resolveSnapshotFiles(snapshot, visible[0].bounds).files, []);
  exists = true; now = 600001;
  assert.equal(client.resolveSnapshotFiles(snapshot, visible[0].bounds).ok, false);
  const other = bridge({ request: async () => ({ ...raw(), fileSurface: { kind: 'none' } }) });
  assert.equal(other.resolveSnapshotFiles(await other.captureContext(), visible[0].bounds).ok, false);
});

test('network paths, missing files and ambiguous names do not become executable paths', async () => {
  const client = bridge({ isFile: () => true, request: async () => ({ ...raw(), fileSurface: { kind: 'desktop', rows: [
    { name: '季度报告', bounds: visible[0].bounds }, { name: 'remote.docx', bounds: visible[1].bounds },
  ], entries: [...entries, { name: '季度报告', path: 'G:\\Reports\\季度报告.pdf' }, { name: 'remote.docx', path: '\\\\server\\share\\remote.docx' }] } }) });
  const snapshot = await client.captureContext();
  assert.equal(snapshot.visibleFiles[0].status, 'ambiguous');
  assert.equal(snapshot.visibleFiles[1].status, 'unresolved');
  assert.equal(client.resolveSnapshotFiles(snapshot, { x: -610, y: 90, w: 150, h: 200 }).ok, false);
});

test('Shell PIDL identity disambiguates desktop icons without trusting unmatched paths', async () => {
  const duplicates = [...entries, { name: '季度报告', path: 'G:\\Reports\\季度报告.pdf' }];
  const client = bridge({ isFile: () => true, request: async () => ({ ...raw(), fileSurface: { kind: 'desktop', rows: [
    { name: '季度报告', path: entries[0].path, bounds: visible[0].bounds },
    { name: 'Not captured', path: 'G:\\NotCaptured\\secret.txt', bounds: visible[1].bounds },
  ], entries: duplicates } }) });
  const snapshot = await client.captureContext();
  assert.equal(snapshot.visibleFiles[0].status, 'resolved');
  assert.equal(snapshot.visibleFiles[0].path, entries[0].path);
  assert.equal(snapshot.visibleFiles[1].path, null);
});
