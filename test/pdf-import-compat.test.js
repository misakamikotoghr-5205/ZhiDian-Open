import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { actions, PDF_IMPORT_UNAVAILABLE } from '../src/main/office/tools-pdf.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-pdf-import-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const action = actions.find((a) => a.id === 'pdf.word');
const source = path.join(root, 'source.pdf');
const pdf = await PDFDocument.create();
pdf.addPage();
const original = Buffer.from(await pdf.save());
fs.writeFileSync(source, original);

async function convertWith(text, { invalid = false } = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'result-'));
  const made = path.join(dir, 'converted.docx');
  const zip = new JSZip();
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p></w:body></w:document>`);
  fs.writeFileSync(made, invalid ? Buffer.from('broken output') : await zip.generateAsync({ type: 'nodebuffer' }));
  const state = { saved: 0, cleaned: false };
  const promise = action.run({ files: [{ path: source, name: 'source.pdf', kind: 'pdf' }] }, {
    tools: { officeConvert: async () => ({ path: made, cleanup: () => { state.cleaned = true; fs.rmSync(dir, { recursive: true, force: true }); } }) },
    save: () => { state.saved++; return path.join(root, 'source.docx'); },
  });
  return { promise, state };
}

test('pdf.word rejects LibreOffice plain-text fallback without saving PDF container bytes as Word', async () => {
  const { promise, state } = await convertWith('%PDF-1.7\n6 0 obj\n<< /Length 10 >>\nendobj\nstartxref\n123\n%%EOF');
  await assert.rejects(promise, (err) => err.code === 'LO_PDF_IMPORT_UNAVAILABLE' && err.message === PDF_IMPORT_UNAVAILABLE);
  assert.equal(state.saved, 0);
  assert.equal(state.cleaned, true);
  assert.deepEqual(fs.readFileSync(source), original);
});

test('pdf.word rejects a broken converter output and cleans its temporary file', async () => {
  const { promise, state } = await convertWith('', { invalid: true });
  await assert.rejects(promise, /没能生成有效的 Word 文档/);
  assert.equal(state.saved, 0);
  assert.equal(state.cleaned, true);
});

test('pdf.word still accepts real page text that mentions a PDF header', async () => {
  const { promise, state } = await convertWith('%PDF-1.7 is the header used by this file format.');
  assert.equal((await promise).kind, 'file');
  assert.equal(state.saved, 1);
  assert.equal(state.cleaned, true);
});
