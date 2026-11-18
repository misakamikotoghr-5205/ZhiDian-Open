// A real Markdown-to-PDF conversion must keep local/embedded pictures and never fetch
// document-provided network resources. Run with a desktop (xvfb-run on Linux).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { launchOffice } from './office-harness.mjs';

const localPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAA0AAAANCAIAAAD9iXMrAAAAFUlEQVQoz2P8z0AUYCJO2ai6IaoOACGHARkvTtGdAAAAAElFTkSuQmCC', 'base64');
const dataPng = 'iVBORw0KGgoAAAANSUhEUgAAABEAAAARCAIAAAC0D9CtAAAAGklEQVQoz2NkYPjPQCJgIlXDqJ5RPaN64AAAq+QBIaUn0joAAAAASUVORK5CYII=';
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  res.writeHead(200, { 'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'image/png' });
  res.end(req.url.endsWith('.css') ? 'body { color: red; }' : localPng);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let office;
try {
  office = await launchOffice();
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const source = path.join(office.work, 'offline.md');
  fs.writeFileSync(path.join(office.work, 'local.png'), localPng);
  fs.writeFileSync(source, `# Offline printing

![local](local.png)

![embedded](data:image/png;base64,${dataPng})

![remote](${endpoint}/remote.png)

<link rel="stylesheet" href="${endpoint}/remote.css">
<div style="background-image: url('${endpoint}/background.png')">Local text</div>
<iframe src="${endpoint}/remote-frame"></iframe>
`);
  const { result } = await office.ok('files.pdf', { files: [source] });
  assert.deepEqual(requests, [], 'printing must not request remote images, CSS or frames');
  const pdf = await PDFDocument.load(fs.readFileSync(result.path));
  const widths = pdf.context.enumerateIndirectObjects()
    .map(([_ref, obj]) => obj)
    .filter((obj) => obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'))
    .map((obj) => obj.dict.get(PDFName.of('Width')).asNumber());
  assert.ok(widths.includes(13), 'the relative local PNG remains in the printed PDF');
  assert.ok(widths.includes(17), 'the embedded data PNG remains in the printed PDF');
  console.log('PASS: offline PDF printing blocks network resources and preserves local/data images');
} finally {
  await office?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (office && !process.env.KEEP) fs.rmSync(office.work, { recursive: true, force: true });
}
