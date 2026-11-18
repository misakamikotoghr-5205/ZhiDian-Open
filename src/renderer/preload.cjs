// The only bridge between the windows and the main process. The renderers are sandboxed and
// load no remote content; they get this narrow API and nothing else.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = new Set([
  'mode', 'referents', 'config', 'display', 'blank', 'toast', 'mark', 'thread:reset', 'focus',
  'answer:start', 'answer:first', 'answer:text', 'answer:status', 'answer:done', 'answer:error', 'context', 'context:plan',
  'settings:changed', 'local:progress', 'act:offer', 'act:progress', 'act:done', 'act:error', 'act:hide', 'idle:hover',
  'voice:cancelled',
]);

contextBridge.exposeInMainWorld('zhidian', {
  on(channel, fn) {
    if (!EVENTS.has(channel)) throw new Error(`unknown channel ${channel}`);
    ipcRenderer.on('c:' + channel, (_e, payload) => fn(payload));
  },
  rpcDone: (id, value) => ipcRenderer.send('c:rpc', { id, value }),
  pin: (p) => ipcRenderer.invoke('c:pin', p),
  ask: (p) => ipcRenderer.send('c:ask', p),
  ocr: (p) => ipcRenderer.send('c:ocr', p),
  captureCopy: (p) => ipcRenderer.invoke('c:capture:copy', p),
  captureSave: (p) => ipcRenderer.invoke('c:capture:save', p),
  stop: () => ipcRenderer.send('c:stop'),
  contextRun: (request) => ipcRenderer.invoke('c:context:run', request),
  resolveFiles: (request) => ipcRenderer.invoke('c:context:resolveFiles', request),
  contextExecute: (id) => ipcRenderer.invoke('c:context:execute', id),
  contextCancel: () => ipcRenderer.send('c:context:cancel'),
  voiceBegin: () => ipcRenderer.invoke('c:voice:begin'),
  voiceTranscribe: (request) => ipcRenderer.invoke('c:voice:transcribe', request),
  voiceCancel: (id) => ipcRenderer.send('c:voice:cancel', id),
  voiceUpdate: (patch) => ipcRenderer.invoke('c:voice:update', patch),
  voiceToggle: (enabled) => ipcRenderer.invoke('c:voice:toggle', Boolean(enabled)),
  unpin: (handle) => ipcRenderer.send('c:unpin', handle),
  clear: () => ipcRenderer.send('c:clear'),
  newThread: () => ipcRenderer.send('c:newThread'),
  // Which model answers this topic ('cloud' | 'local' | null), and asking the last question again of the other one.
  via: (which) => ipcRenderer.send('c:via', which),
  reask: (which) => ipcRenderer.send('c:reask', which),
  exit: () => ipcRenderer.send('c:exit'),
  beat: () => ipcRenderer.send('c:beat'),
  rects: (rects) => ipcRenderer.send('c:rects', rects),
  idleContent: (has) => ipcRenderer.send('c:idleContent', has),
  copy: (text) => ipcRenderer.send('c:copy', text),
  openSettings: (focus) => ipcRenderer.send('c:openSettings', focus),
  referentImage: (handle) => ipcRenderer.invoke('c:referentImage', handle),
  act: {
    run: (id, action, param) => ipcRenderer.send('c:act:run', { id, action, param }),
    open: (id) => ipcRenderer.send('c:act:open', id),
    reveal: (id) => ipcRenderer.send('c:act:reveal', id),
    copy: (id) => ipcRenderer.send('c:act:copy', id),
    dismiss: (id) => ipcRenderer.send('c:act:dismiss', id),
  },
  settings: {
    get: () => ipcRenderer.invoke('c:settings:get'),
    update: (patch) => ipcRenderer.invoke('c:settings:update', patch),
    install: (opts) => ipcRenderer.invoke('c:local:install', opts),
    removeModel: (modelId) => ipcRenderer.invoke('c:local:remove', modelId),
    openLocalDir: () => ipcRenderer.send('c:local:openDir'),
    pickLocalDir: () => ipcRenderer.invoke('c:local:pickDir'),
    setLocalDir: (directory) => ipcRenderer.invoke('c:local:setDir', directory),
    cancelInstall: () => ipcRenderer.send('c:local:cancel'),
    start: () => ipcRenderer.invoke('c:local:start'),
    probe: (url) => ipcRenderer.invoke('c:local:probe', url),
    openPermission: () => ipcRenderer.send('c:settings:openPermission'),
    seen: () => ipcRenderer.send('c:settings:seen'),
    tryPointing: () => ipcRenderer.send('c:settings:tryPointing'),
    pickFiles: () => ipcRenderer.send('c:settings:pickFiles'),
    dropFiles: (files) => {
      const paths = Array.from(files ?? [])
        .map((f) => {
          if (typeof f === 'string') return f;
          try {
            return webUtils.getPathForFile(f);
          } catch {
            return '';
          }
        })
        .filter(Boolean);
      return ipcRenderer.invoke('c:settings:dropFiles', paths);
    },
    actClipboard: () => ipcRenderer.invoke('c:settings:actClipboard'),
    // The optional network model. The main process accepts these from the settings window only.
    cloud: {
      update: (patch) => ipcRenderer.invoke('c:cloud:update', patch),
      test: () => ipcRenderer.invoke('c:cloud:test'),
      profile: (action, args) => ipcRenderer.invoke('c:cloud:profile', action, args),
      models: () => ipcRenderer.invoke('c:cloud:models'),
    },
  },
});
