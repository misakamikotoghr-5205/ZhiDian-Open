// Writes train/prompt.json from the app's own prompt module, so the adapter is trained on the
// exact text the app sends. Run after changing src/core/prompt.js:  node train/export_prompt.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUNDING_TEMPLATES, LOCATE_SCHEMA, LOCATE_TEMPLATES, SYSTEM_PROMPT, SYSTEM_PROMPT_POINTER } from '../src/core/prompt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = { system: SYSTEM_PROMPT, system_pointer: SYSTEM_PROMPT_POINTER, grounding: GROUNDING_TEMPLATES, locate: LOCATE_TEMPLATES, locate_schema: LOCATE_SCHEMA, ref_label: '@{n}：' };
fs.writeFileSync(path.join(here, 'prompt.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote train/prompt.json');
