// Settings live in one JSON file under the app's userData directory.
import electron from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { migrateLegacyProfiles } from './cloud/profiles.js';
import { VOICE_DEFAULTS } from './voice/config.js';

const userDataDir = () =>
  typeof electron === 'object' && electron?.app
    ? electron.app.getPath('userData')
    : process.env.ZHIDIAN_USER_DATA || path.join(os.tmpdir(), 'zhidian-userdata');

const DEFAULTS = {
  hotkeys: { point: 'Alt+`', pointAlt: 'F8' },
  pointBack: true,
  wiggle: false,
  naturalWheel: false, // invert wheel direction when stepping through snap scopes
  launchAtLogin: false, // start automatically on OS login when packaged
  maxImageEdge: 1024,
  local: {
    mode: 'managed', // 'managed': the bundled llama.cpp runtime; 'external': a local server the user already runs
    directory: '', // empty: the default local directory under userData
    modelId: '', // empty: automatic resource-based choice; a supported id is an explicit override
    source: 'huggingface',
    variant: 'auto', // 'auto' | 'vulkan'
    adapter: 'auto', // 'auto': use the pointer adapter when present; 'off': never
    // Without the adapter, where the answer is has to be asked separately. 'precise' sends an
    // enlarged copy of the screenshot on its own: slower (about 9 to 25 s on a 4-core CPU) but
    // it is the only way the stock model points usefully (3 to 4 of 8 on the test page).
    // 'fast' asks as a follow-up in the same conversation: 2 to 4 s, but it missed 8 of 8.
    locate: 'precise',
    groundPixels: 0, // size of that enlarged copy in pixels; 0: the model's own default
    ghMirror: '', // optional URL prefix for the runtime download, for networks where github.com is slow
    binaryPath: '', // optional: a llama-server the user installed themselves
    extraArgs: [],
    externalUrl: 'http://127.0.0.1:11434/v1',
    externalModel: '',
    externalKey: '',
    externalPreset: 'ollama',
    externalVision: 'auto',
  },
  // Office actions: when files or text are selected in another application, offer what can be
  // done with them (merge to PDF, make slides, tidy the text ...) in a small panel by the cursor.
  actions: {
    ambient: true,
    compact: true, // show a tiny non-intrusive pill first; hover or click expands the full panel
    ignoredApps: '', // comma- or newline-separated foreground app names to ignore
    translateTo: 'auto', // 'auto' | 'en' | 'zh' | 'ja' | 'ko' | 'fr' | 'de'
    template: 'business',
  },
  // Optional: a model service on the network, for what the local model answers badly. Off by
  // default; with it off the app contacts no model service at all.
  cloud: {
    enabled: false, // the master switch
    byDefault: false, // true: every question goes there; false: only when asked to ("联网重答")
    provider: 'anthropic', // 'anthropic' | 'openai' (any service speaking that chat format)
    presetId: 'anthropic',
    vision: 'auto',
    model: '', // empty: the provider's default
    baseUrl: '', // empty: the provider's own address; required for 'openai'
    effort: 'low', // how hard the model thinks before answering: 'low' | 'medium' | 'high'
    webSearch: false, // Claude only: let the model search the web while answering
    key: '', // the API key, encrypted (see cloud/secrets.js); never sent to a window
    keyHost: '', // the host that key was typed in for; it is not sent anywhere else
    keyHint: '', // its last four characters, for the settings window
  },
  apiProfiles: [],
  activeApiProfile: '',
  apiProfilesMigrated: false,
  voice: { ...VOICE_DEFAULTS },
  mcp: { enabled: true, port: 47600, token: '' },
  seenIntro: false,
};

let cache = null;
const file = () => path.join(userDataDir(), 'settings.json');

export function resetForTest() {
  cache = null;
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (!(k in base)) continue; // drop unknown keys
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] ?? {}, v) : v;
  }
  return out;
}

export function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    // First run, or an unreadable file: start from defaults.
  }
  const needsMigration = !stored.apiProfilesMigrated;
  cache = migrateLegacyProfiles(merge(DEFAULTS, stored));
  if (!stored.cloud?.presetId) cache.cloud.presetId = cache.cloud.provider === 'anthropic' ? 'anthropic' : 'custom';
  if (!cache.mcp.token) {
    cache.mcp.token = crypto.randomBytes(24).toString('hex');
    save();
  }
  else if (needsMigration) save();
  return cache;
}

export function save() {
  const destination = file();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    fs.writeFileSync(fd, JSON.stringify(cache, null, 2));
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, destination);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function update(patch) {
  const previous = load();
  cache = merge(DEFAULTS, merge(load(), patch));
  try { save(); }
  catch (err) { cache = previous; throw err; }
  return cache;
}

/** Where the runtime and the model files are kept. */
export function localDir() {
  return process.env.ZHIDIAN_LOCAL_DIR || load().local.directory || defaultLocalDir();
}

export function defaultLocalDir() {
  return path.join(userDataDir(), 'local');
}

/** Discovery file for the stdio bridge (bin/zhidian-mcp.mjs). */
export function writeDiscovery(port) {
  const dir = path.join(os.homedir(), '.zhidian');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ port, token: load().mcp.token, pid: process.pid }), { mode: 0o600 });
}
