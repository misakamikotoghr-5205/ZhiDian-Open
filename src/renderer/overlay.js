// Overlay UI. While pointing, the window shows a frozen frame of the screen and takes the mouse
// and keyboard; while idle it is transparent and click-through except over its own panels.
import { snapLadder } from '../core/snap.js';
import { boxFromPoints, clamp, contains, iou, placeNear } from '../core/geometry.js';
import { badgeToken, renderMarkdown } from '../core/markdown.js';
import { VoiceInput } from './voice-input.js';
import { insertDictation } from './voice-draft.js';

const api = window.zhidian;
const $ = (id) => document.getElementById(id);
const el = {
  frame: $('frame'), snap: $('snap'), tag: document.querySelector('#snap .tag'), drag: $('drag'), halo: $('halo'),
  pins: $('pins'), marks: $('marks'), ai: $('aicursor'), ask: $('ask'), sendlist: $('sendlist'), q: $('q'),
  presets: $('presets'), asktools: $('asktools'), hud: $('hud'), bubble: $('bubble'), bwho: $('bwho'), bscripted: $('bscripted'),
  bstop: $('bstop'), bcopy: $('bcopy'), bclose: $('bclose'), bhistory: $('bhistory'), bq: $('bq'), btext: $('btext'), bstatus: $('bstatus'),
  bfoot: $('bfoot'), snapshot: $('snapshot'), stitle: $('stitle'), sclose: $('sclose'), simg: $('simg'),
  smarks: $('smarks'), dock: $('dock'), chips: $('chips'), dclear: $('dclear'), hint: $('hint'), toasts: $('toasts'),
  act: $('act'), actwhat: $('actwhat'), actclose: $('actclose'), actbtns: $('actbtns'), actparam: $('actparam'),
  actstatus: $('actstatus'), actmsg: $('actmsg'), actdone: $('actdone'), actpill: $('actpill'),
  askhead: $('askhead'), contextcard: $('contextcard'), contextactions: $('contextactions'),
  contextmode: $('contextmode'), screenmode: $('screenmode'), qsend: $('qsend'),
  qmic: $('qmic'), voicepanel: $('voicepanel'), voicestatus: $('voice-status'), voicedetail: $('voice-detail'),
  voicetime: $('voice-time'), voicestop: $('voice-stop'), voicecancel: $('voice-cancel'), voicesettings: $('voice-settings'),
};

const S = {
  mode: 'idle',
  W: window.innerWidth,
  H: window.innerHeight,
  displayId: null,
  bitmap: null,
  cursor: { x: -100, y: -100 },
  overPanel: false,
  ladder: null,
  index: 0,
  bias: 0, // wheel steps away from the default scope
  biasAt: null,
  box: null,
  // 'track': the box follows the cursor. 'hover': the cursor rested, the dialog is showing for
  // `target`. 'fixed': something is pinned and the dialog stays put. 'after': an answer was
  // given; the dialog stays for follow-ups but a new hover may claim it.
  phase: 'track',
  target: null,
  hoverFrom: null,
  dwellTimer: 0,
  drag: null,
  refs: [],
  fresh: [], // handles pinned since the last question
  extra: new Set(), // older handles the user clicked back in
  anchor: null,
  asked: [], // boxes of what the last question was about
  pinnedAt: new Map(), // handle -> the box it was pinned from, known before the store reports back
  bubbleFit: null, // how the answer bubble is anchored, so it can be re-fitted as it grows
  wheel: { acc: 0, at: 0 },
  autoPinning: null,
  answer: null,
  history: [], // completed { q, streamText, text } turns in the active topic
  lastTurn: null,
  marks: [],
  markQueue: Promise.resolve(),
  markGeneration: 0, // invalidates queued animations and image requests when marks are cleared
  aiAt: null,
  config: {},
  context: null,
  inputMode: 'screen',
  contextBusy: false,
  contextStopping: false,
  contextRequest: 0,
  contextResult: null,
  contextParam: null,
  selectionMessage: '',
  resolvingFiles: false,
  selectionGeneration: 0,
  voice: { state: 'idle' },
  voiceNote: '',
  lastInput: Date.now(),
  timers: { marks: 0, bubble: 0, act: 0, pill: 0 },
  act: null, // the office-action panel: { id, state: 'pill' | 'offer' | 'working' | 'done', offer, at }
};

const ASK_W = 340;
const DWELL_MS = 380;
const DWELL_AFTER_MS = 650; // after an answer the dialog is in use: a new rest has to be more deliberate
const kb = (bytes) => (bytes < 10240 ? (bytes / 1024).toFixed(1) : Math.round(bytes / 1024)) + ' KB';
const refOf = (handle) => S.refs.find((r) => r.handle === handle);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

// ------------------------------------------------------------------ explicit voice input

let voiceAnchor = null;
let voiceGesture = null;
let voiceDoneTimer = 0;
let voiceFocusTimer = 0;
let voiceScrollFrame = 0;
const voiceActive = () => ['starting', 'listening', 'transcribing'].includes(S.voice.state);
const voice = new VoiceInput({
  begin: () => api.voiceBegin(),
  transcribe: (request) => api.voiceTranscribe(request),
  cancel: (id) => api.voiceCancel(id),
  onState: (status) => {
    const previous = S.voice.state;
    S.voice = status;
    S.lastInput = Date.now();
    if (status.state === 'listening' && previous !== 'listening') {
      // macOS may briefly blur us for its initial permission prompt. If focus does not
      // return after permission was granted, do not leave the microphone running unseen.
      clearTimeout(voiceFocusTimer);
      voiceFocusTimer = setTimeout(() => {
        if (S.voice.state === 'listening' && !document.hasFocus()) cancelVoice();
      }, 250);
    }
    if (status.state === 'success') {
      clearTimeout(voiceDoneTimer);
      voiceDoneTimer = setTimeout(() => { if (S.voice.state === 'success') cancelVoice(); }, 3600);
    }
    renderVoice();
    if (['starting', 'listening', 'transcribing'].includes(status.state) && previous !== status.state) {
      cancelAnimationFrame(voiceScrollFrame);
      voiceScrollFrame = requestAnimationFrame(() => {
        voiceScrollFrame = 0;
        if (voiceActive()) el.qmic.scrollIntoView({ block: 'nearest' });
      });
    }
  },
  onAmplitude: (level) => el.voicepanel.style.setProperty('--voice-level', String(Math.max(0, Math.min(1, level)))),
  onTranscript: (text) => {
    const at = voiceAnchor?.value === el.q.value ? voiceAnchor.at : el.q.selectionEnd;
    const result = insertDictation(el.q.value, text, { at, maxLength: el.q.maxLength });
    el.q.value = result.value;
    el.q.setSelectionRange(result.caret, result.caret);
    S.voiceNote = result.inserted
      ? result.truncated ? '已填入输入框；超出字数上限的部分未加入。' : '已填入输入框，确认后再发送。'
      : '输入框已满，请先整理文字后再试。';
    el.q.dispatchEvent(new Event('input', { bubbles: true }));
    el.q.focus();
    renderVoice();
  },
});

function renderVoice() {
  const state = S.voice.state;
  const active = voiceActive();
  const available = Boolean(S.config.voice?.available);
  $('quickvoice').checked = Boolean(S.config.voice?.enabled);
  el.qmic.hidden = !S.config.voice?.enabled && !active;
  const where = S.voice.where || S.config.voice?.where || 'local';
  const destination = where === 'local' ? '在本机转写' : `转写服务：${where}`;
  el.voicepanel.hidden = state === 'idle';
  el.voicepanel.dataset.state = state;
  el.qmic.dataset.state = state;
  el.qmic.classList.toggle('unconfigured', !available && !active);
  el.qmic.setAttribute('aria-pressed', String(active));
  el.qmic.setAttribute('aria-label', state === 'listening' ? '结束录音并转写' : active ? '取消语音输入' : available ? '开始语音输入' : '设置语音输入');
  el.qmic.title = available ? `语音输入 · ${destination}；单击切换，或按住说话` : (S.config.voice?.problem || '先在设置中启用语音输入');
  const labels = { starting: '正在连接麦克风', listening: '正在听你说', transcribing: '正在转写', success: '文字已就位', error: '语音输入未完成' };
  const label = labels[state] || '语音输入';
  if (el.voicestatus.textContent !== label) el.voicestatus.textContent = label;
  el.voicedetail.textContent = state === 'error' ? S.voice.error : state === 'success' ? S.voiceNote || '正在填入输入框…' : state === 'starting' ? `请允许麦克风访问 · ${destination}` : destination;
  el.voicetime.textContent = state === 'listening' ? `${String(Math.floor(S.voice.elapsedSeconds || 0)).padStart(2, '0')} / ${S.voice.maxSeconds || 60} 秒` : '';
  el.voicestop.hidden = state !== 'listening';
  el.voicesettings.hidden = state !== 'error';
  el.voicecancel.title = active ? '取消语音输入（Esc）' : '收起';
  el.voicecancel.setAttribute('aria-label', active ? '取消语音输入' : '收起语音状态');
  el.voicepanel.closest('.composer').classList.toggle('voice-success', state === 'success' && Boolean(S.voiceNote));
  if (state !== 'idle' && S.mode === 'pointing') {
    el.ask.classList.remove('quiet');
    placeAsk(S.anchor ?? S.target ?? S.box ?? { x: S.cursor.x, y: S.cursor.y, w: 1, h: 1 });
  }
  reportIdle();
}

function startVoice() {
  if (S.mode !== 'pointing') return;
  if (!S.config.voice?.available) {
    api.openSettings('voice');
    return;
  }
  clearTimeout(voiceDoneTimer);
  clearTimeout(S.dwellTimer);
  S.voiceNote = '';
  voiceAnchor = { value: el.q.value, at: el.q.selectionEnd };
  void voice.start();
}

function cancelVoice() {
  clearTimeout(voiceDoneTimer);
  clearTimeout(voiceFocusTimer);
  cancelAnimationFrame(voiceScrollFrame);
  voiceScrollFrame = 0;
  if (voiceGesture) {
    const gesture = voiceGesture;
    voiceGesture = null;
    clearTimeout(gesture.timer);
    if (el.qmic.hasPointerCapture?.(gesture.id)) el.qmic.releasePointerCapture(gesture.id);
  }
  voiceAnchor = null;
  S.voiceNote = '';
  voice.cancel();
}

function toggleVoice() {
  if (S.voice.state === 'listening') void voice.stop();
  else if (voiceActive()) cancelVoice();
  else startVoice();
}

el.qmic.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  if (voiceActive()) { toggleVoice(); return; }
  const gesture = voiceGesture = { id: event.pointerId, held: false, timer: 0, startedAt: performance.now() };
  el.qmic.setPointerCapture?.(event.pointerId);
  gesture.timer = setTimeout(() => { if (voiceGesture === gesture) gesture.held = true; }, 250);
  startVoice();
});
el.qmic.addEventListener('pointerup', (event) => {
  const gesture = voiceGesture;
  if (!gesture || gesture.id !== event.pointerId) return;
  clearTimeout(gesture.timer);
  voiceGesture = null;
  if (el.qmic.hasPointerCapture?.(event.pointerId)) el.qmic.releasePointerCapture(event.pointerId);
  if (gesture.held || performance.now() - gesture.startedAt >= 250) {
    if (S.voice.state === 'listening') void voice.stop();
    else if (S.voice.state === 'starting') cancelVoice();
  }
});
el.qmic.addEventListener('pointercancel', cancelVoice);
el.qmic.addEventListener('lostpointercapture', (event) => {
  if (voiceGesture?.id === event.pointerId) cancelVoice();
});
el.qmic.addEventListener('click', (event) => { if (event.detail === 0) toggleVoice(); });
el.voicestop.addEventListener('click', () => { void voice.stop(); });
el.voicecancel.addEventListener('click', cancelVoice);
el.voicesettings.addEventListener('click', () => { cancelVoice(); api.openSettings('voice'); });
window.addEventListener('blur', () => { if (['listening', 'transcribing'].includes(S.voice.state)) cancelVoice(); });
window.addEventListener('pagehide', () => { cancelVoice(); voice.destroy(); });

document.addEventListener('pointerdown', (event) => {
  const button = event.target.closest?.('.mode-tabs button, #presets button, .context-action, #qsend, #qmic, .primary-button');
  if (!button || button.disabled || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rect = button.getBoundingClientRect();
  button.style.setProperty('--ripple-x', `${event.clientX - rect.left}px`);
  button.style.setProperty('--ripple-y', `${event.clientY - rect.top}px`);
  button.classList.remove('press-ripple');
  void button.offsetWidth;
  button.classList.add('press-ripple');
  button.addEventListener('animationend', () => button.classList.remove('press-ripple'), { once: true });
});
document.addEventListener('animationend', (event) => { if (event.target.matches?.('.panel')) reportIdle(); });

// ------------------------------------------------------------------ mode

function enterPointing(p) {
  cancelVoice();
  S.selectionGeneration++;
  S.mode = 'pointing';
  S.W = p.display.w;
  S.H = p.display.h;
  S.displayId = p.display.id;
  S.bitmap = { data: p.bitmap.data, width: p.bitmap.width, height: p.bitmap.height };
  S.cursor = { ...p.cursor };
  S.fresh = [];
  S.extra.clear();
  S.bias = 0;
  S.biasAt = null;
  S.drag = null;
  S.autoPinning = null;
  S.anchor = null;
  S.asked = [];
  S.pinnedAt.clear();
  S.phase = 'track';
  S.target = null;
  S.answer = null;
  S.contextRequest++;
  S.contextBusy = false;
  S.contextStopping = false;
  S.contextResult = null;
  S.context = null; // a fresh foreground snapshot follows the mode event
  S.contextParam = null;
  S.selectionMessage = '';
  S.resolvingFiles = false;
  S.inputMode = 'screen';
  // The last pointer event of the previous session was very likely on one of our own panels
  // (an option, a button). This is a new screen: nothing is under the cursor until it moves.
  S.overPanel = false;
  S.wheel = { acc: 0, at: 0 };
  S.lastInput = Date.now();
  delete el.ask.dataset.moved;
  delete el.bubble.dataset.moved;
  delete el.snapshot.dataset.moved;
  clearTimeout(S.timers.marks);
  clearTimeout(S.timers.bubble);
  clearTimeout(S.timers.act); // an action panel that is up stays while pointing
  if (S.act?.state === 'pill') expandActPill();
  clearMarks();
  el.bubble.hidden = true;
  // Draw the frame at exactly the display's size, not the window's: on X11 Chromium makes a
  // window that matches the screen one pixel smaller, and stretching the screenshot to fit
  // that would blur every pixel of it.
  el.frame.style.width = S.W + 'px';
  el.frame.style.height = S.H + 'px';
  el.frame.src = p.frame;
  document.body.classList.remove('idle', 'blank');
  document.body.classList.add('pointing');
  el.q.value = '';
  el.ask.hidden = false;
  el.ask.classList.remove('quiet');
  $('quickadvanced').open = false;
  el.hint.hidden = false;
  renderAll();
  moveHalo();
  snapNow();
  armDwell();
  showDialog({ x: S.cursor.x, y: S.cursor.y, w: 1, h: 1 });
  el.q.focus();
}

function enterIdle() {
  cancelVoice();
  S.selectionGeneration++;
  S.mode = 'idle';
  S.bitmap = null;
  S.drag = null;
  S.autoPinning = null;
  S.box = null;
  S.target = null;
  clearTimeout(S.dwellTimer);
  el.frame.removeAttribute('src');
  document.body.classList.remove('pointing');
  document.body.classList.add('idle');
  el.snap.classList.remove('on');
  el.drag.style.display = 'none';
  el.ask.hidden = true;
  el.hint.hidden = true;
  el.q.blur();
  // The answer and the marks stay for a while: "press Retry" is most useful once the person
  // is back in their app. They time out because the live screen moves on.
  clearTimeout(S.timers.marks);
  S.timers.marks = setTimeout(() => fadeMarks(), 14000);
  clearTimeout(S.timers.bubble);
  S.timers.bubble = setTimeout(() => { el.bubble.hidden = true; reportIdle(); }, 90000);
  if (S.act && S.act.state !== 'working') actTimeout(S.act.state === 'done' ? 30000 : S.act.state === 'pill' ? 4500 : 9000);
  renderAll();
}

// ------------------------------------------------------------------ snapping

function moveHalo() {
  el.halo.style.transform = `translate(${S.cursor.x}px, ${S.cursor.y}px)`;
}

function renderSnapBox(b, n, repositionAsk = true) {
  Object.assign(el.snap.style, { left: b.x - 2 + 'px', top: b.y - 2 + 'px', width: b.w + 4 + 'px', height: b.h + 4 + 'px' });
  el.snap.classList.add('on');
  el.snap.classList.toggle('flip', b.y < 30);
  el.snap.classList.toggle('inside', b.y < 30 && b.y + b.h > S.H - 30);
  el.snap.classList.toggle('big', b.w * b.h > S.W * S.H * 0.3);
  el.tag.textContent = b.kind === 'screen' ? `整个屏幕 · ${S.index + 1}/${n}` : `范围 ${S.index + 1}/${n} · ${b.w}×${b.h}`;
  if (S.phase === 'hover' && S.inputMode === 'screen' && !voiceActive()) {
    S.target = b;
    if (repositionAsk) {
      placeAsk(b);
      const d = distToDialog(S.cursor.x, S.cursor.y);
      S.hoverFrom = { x: S.cursor.x, y: S.cursor.y, start: d, min: d };
    }
  }
}

function snapNow() {
  if (S.mode !== 'pointing' || !S.bitmap) return;
  if (S.drag?.active) {
    el.snap.classList.remove('on');
    return;
  }
  if (S.overPanel) return; // over our own dialog: keep whatever is boxed
  if (S.biasAt && Math.hypot(S.cursor.x - S.biasAt.x, S.cursor.y - S.biasAt.y) > 90) {
    S.bias = 0;
    S.biasAt = null;
  }
  S.ladder = snapLadder(S.bitmap, S.cursor.x, S.cursor.y);
  const n = S.ladder.boxes.length;
  S.index = clamp(S.ladder.defaultIndex + S.bias, 0, n - 1);
  S.box = S.ladder.boxes[S.index];
  renderSnapBox(S.box, n, true);
}

function changeScope(step) {
  if (!S.ladder) return;
  const n = S.ladder.boxes.length;
  const next = clamp(S.index + step, 0, n - 1);
  S.bias = next - S.ladder.defaultIndex;
  S.biasAt = { ...S.cursor };
  if (S.overPanel) {
    S.index = next;
    S.box = S.ladder.boxes[S.index];
    renderSnapBox(S.box, n, false);
    return;
  }
  snapNow();
}

let snapQueued = false;
function queueSnap() {
  if (snapQueued) return;
  snapQueued = true;
  requestAnimationFrame(() => {
    snapQueued = false;
    snapNow();
  });
}

// ------------------------------------------------------------------ hover dialog

/** Start (or restart) the rest timer: when the cursor stays put, the dialog comes up by itself. */
function armDwell() {
  clearTimeout(S.dwellTimer);
  if (S.mode !== 'pointing') return;
  S.dwellTimer = setTimeout(onDwell, S.phase === 'after' ? DWELL_AFTER_MS : DWELL_MS);
}

function onDwell() {
  if (S.mode !== 'pointing' || S.inputMode === 'context' || voiceActive() || S.drag || S.overPanel || !S.box) return;
  if (S.phase !== 'track' && S.phase !== 'after') return;
  if (el.q.value) return; // a half-typed follow-up keeps its dialog
  // Resting on the very thing that was just asked about is not a new target: the dialog stays
  // where it is, ready for a follow-up, instead of starting over on the same block.
  if (S.phase === 'after' && S.asked.some((b) => iou(b, S.box) > 0.9)) return;
  S.phase = 'hover';
  S.target = S.box;
  showDialog(S.box);
  const d = distToDialog(S.cursor.x, S.cursor.y);
  S.hoverFrom = { x: S.cursor.x, y: S.cursor.y, start: d, min: d };
}

function showDialog(box) {
  el.hint.hidden = true;
  el.ask.classList.remove('quiet');
  renderSendList();
  renderHud();
  placeAsk(box);
}

function hideDialog() {
  if (S.inputMode === 'context' || voiceActive()) return;
  el.ask.classList.add('quiet');
}

/**
 * The dialog has lost what it was about (the hover was left, the last pin was removed). Before
 * any answer it disappears and the box follows the cursor again. After an answer it goes back to
 * where the question was asked and offers follow-ups, so there is always a visible place to type.
 */
function releaseDialog() {
  S.target = null;
  if (S.answer) {
    S.phase = 'after';
    showDialog(S.anchor ?? { x: S.cursor.x, y: S.cursor.y, w: 1, h: 1, kind: 'window' });
  } else {
    S.phase = 'track';
    S.anchor = null;
    hideDialog();
  }
}

/** Distance from a point to the dialog (0 inside it). */
function distToDialog(x, y) {
  const a = el.ask.getBoundingClientRect();
  const dx = Math.max(a.left - x, 0, x - a.right);
  const dy = Math.max(a.top - y, 0, y - a.bottom);
  return Math.hypot(dx, dy);
}

/**
 * While the dialog floats, the cursor may travel to it without losing it. Anything else, such
 * as drifting off to look at something different, lets go: the cursor has to be getting
 * closer to the dialog for the distance it has covered since it came to rest.
 */
function headingToDialog(x, y) {
  const h = S.hoverFrom;
  if (!h) return false;
  const d = distToDialog(x, y);
  if (d === 0) return true;
  h.min = Math.min(h.min, d);
  if (d > h.min + 16) return false;
  const moved = Math.hypot(x - h.x, y - h.y);
  return moved < 40 || h.start - d >= moved * 0.35;
}

// ------------------------------------------------------------------ pinning

/** Fix the dialog: what it was floating next to becomes a referent (@n) and it stops moving. */
async function pin(box, kind) {
  const generation = S.selectionGeneration;
  const displayId = S.displayId;
  const first = !S.fresh.length && !S.extra.size;
  const handle = await api.pin({ box: { x: box.x, y: box.y, w: box.w, h: box.h }, kind });
  if (!handle) return null;
  if (S.mode !== 'pointing' || generation !== S.selectionGeneration || displayId !== S.displayId) {
    api.unpin(handle);
    return null;
  }
  S.pinnedAt.set(handle, { x: box.x, y: box.y, w: box.w, h: box.h });
  S.fresh.push(handle);
  S.phase = 'fixed';
  S.target = null;
  el.hint.hidden = true;
  el.ask.classList.remove('quiet');
  if (first) {
    S.anchor = box;
    placeAsk(box);
  }
  renderAll();
  return handle;
}

/** A left click captures the tracked region; coalesce clicks while its IPC is pending. */
function pinCurrent() {
  if (S.autoPinning) return S.autoPinning;
  const box = S.phase === 'hover' && S.target ? S.target : S.box;
  if (!box) return null;
  const generation = S.selectionGeneration;
  const pending = pin(box, box.kind).catch(err => {
    if (S.mode === 'pointing' && generation === S.selectionGeneration) toast({ text: err?.message || '截图失败，请重试。', kind: 'error' });
    return null;
  });
  S.autoPinning = pending;
  void pending.then(() => {
    if (S.autoPinning === pending) S.autoPinning = null;
  });
  return pending;
}

function unpinLastFresh() {
  const handle = S.fresh.pop();
  if (handle) api.unpin(handle);
  if (!S.fresh.length && !S.extra.size) releaseDialog();
  renderAll();
}

function placeAsk(box) {
  if (el.ask.dataset.moved) return;
  el.ask.style.maxHeight = '';
  const hgt = el.ask.offsetHeight || 168;
  const width = el.ask.offsetWidth || ASK_W;
  const anchor = box.kind === 'screen' ? { x: S.cursor.x, y: S.cursor.y, w: 1, h: 1 } : box;
  let pos;
  if (S.inputMode === 'screen') {
    // A richer dialog should not hide the neighbouring item someone wants to pin next.
    // Keep useful space below/above the target by scrolling a small overflow instead of
    // moving the entire dialog over the content immediately to its right.
    const below = S.H - 8 - (anchor.y + anchor.h + 14);
    const above = anchor.y - 14 - 8;
    const useful = (room) => room >= 380 && room >= hgt * 0.7;
    if (useful(below) || useful(above)) {
      const down = useful(below);
      const height = Math.min(hgt, down ? below : above);
      el.ask.style.maxHeight = height + 'px';
      pos = { x: clamp(anchor.x, 8, Math.max(8, S.W - width - 8)), y: down ? anchor.y + anchor.h + 14 : anchor.y - 14 - height };
    }
  }
  pos ??= placeNear(anchor, width, hgt, S.W, S.H, 14);
  el.ask.style.left = pos.x + 'px';
  el.ask.style.top = pos.y + 'px';
}

function mdOpts() {
  return {
    isRef: (x) => Boolean(refOf(x)),
    onCopyCode: (code) => {
      api.copy(code);
      toast({ text: '已复制代码' });
    },
  };
}

function renderHistory() {
  if (!S.history.length) {
    el.bhistory.hidden = true;
    el.bhistory.textContent = '';
    return;
  }
  el.bhistory.hidden = false;
  el.bhistory.replaceChildren(
    ...S.history.map((turn, idx) => {
      const body = h('div', { class: 'bturn-body' }, renderMarkdown(turn.streamText || turn.text, mdOpts()));
      return h('details', { class: 'bturn' }, h('summary', {}, `第 ${idx + 1} 问：${turn.q}`), body);
    }),
  );
}

// ------------------------------------------------------------------ asking

async function submit(text) {
  if (S.mode !== 'pointing') return;
  if (S.resolvingFiles) return;
  if (voiceActive()) cancelVoice();
  if (S.inputMode === 'context') {
    if (!contextHasSelection()) return toast({ text: '请先框住需要处理的文件。' });
    const instruction = (text ?? el.q.value).trim();
    if (!instruction) return el.q.focus();
    await runContext({ instruction });
    return;
  }
  const generation = S.selectionGeneration;
  if (S.autoPinning) {
    await S.autoPinning;
    if (S.mode !== 'pointing' || generation !== S.selectionGeneration) return;
  }
  if (!S.fresh.length && !S.extra.size && !S.answer) return toast({ text: '请先左键点击截图，或拖拽框选文件和截图区域。' });
  const question = (text ?? el.q.value).trim();
  if (!S.fresh.length && !S.extra.size) {
    if (S.phase === 'hover' && S.target) {
      if (!(await pin(S.target, S.target.kind))) return;
    } else if (!S.answer) {
      if (!S.box || !(await pin(S.box, S.box.kind))) return;
    } else if (!question) {
      return; // a follow-up needs words
    }
    // Otherwise: a follow-up on what was already asked about, with nothing new pinned.
  }
  const handles = [...S.fresh, ...S.extra];
  if (handles.length) S.asked = handles.map((x) => S.pinnedAt.get(x) ?? refOf(x)?.box).filter(Boolean);
  S.fresh = [];
  S.extra.clear();
  S.phase = 'after';
  S.target = null;
  el.q.value = '';
  clearMarks();
  api.ask({ question, handles });
  renderAll();
}

function onAnswerStart(a) {
  const qLabel = `${a.handles.join(' ')}  ${a.question || (a.handles.length > 1 ? '这些分别是什么？' : '这是什么？')}`.trim();
  if (!a.redo && S.lastTurn && S.lastTurn.text) {
    S.history.push(S.lastTurn);
    if (S.history.length > 6) S.history.shift();
    S.lastTurn = null;
  }
  renderHistory();
  S.answer = { id: a.id, q: qLabel, text: '', streamText: '', done: false, firstMs: null, bytes: a.bytes, fraction: a.fraction, marks: 0, where: a.where ?? 'local', cloud: Boolean(a.cloud) };
  el.bwho.textContent = a.brain;
  el.bscripted.hidden = !a.scripted;
  el.bscripted.textContent = a.badge || '排练脚本';
  el.bq.textContent = qLabel;
  el.btext.textContent = '';
  el.btext.classList.remove('error', 'md');
  el.bstatus.hidden = true;
  el.bfoot.textContent = '';
  el.bstop.hidden = false;
  el.bubble.classList.add('busy');
  el.bubble.hidden = false;
  placeBubble();
  reportIdle();
}

function placeBubble() {
  if (el.bubble.dataset.moved) return;
  const w = el.bubble.offsetWidth || Math.min(ASK_W, S.W - 24);
  // The bubble is empty now and grows as the answer streams in, so decide which way it may
  // grow and how tall it may get; fitBubble() keeps it there.
  el.btext.style.maxHeight = '';
  const chrome = Math.max(el.bubble.offsetHeight, 70) + 40; // header, padding, and the footer still to come
  const cap = (room) => Math.max(72, Math.min(S.H * 0.46, room - chrome)) + 'px';
  let x;
  if (!el.ask.hidden && !el.ask.classList.contains('quiet')) {
    const r = el.ask.getBoundingClientRect();
    const below = S.H - 8 - (r.bottom + 10), above = r.top - 10 - 8;
    x = r.left;
    const sideX = r.right + 14 + w <= S.W - 8 ? r.right + 14 : r.left - 14 - w >= 8 ? r.left - 14 - w : null;
    if (below < 250 && above < 250 && sideX !== null) {
      x = sideX;
      S.bubbleFit = { side: 'below', edge: Math.max(8, Math.min(r.top, S.H - 250)) };
      el.btext.style.maxHeight = cap(S.H - 8 - S.bubbleFit.edge);
    } else if (below >= 250 || below >= above) {
      S.bubbleFit = { side: 'below', edge: r.bottom + 10 };
      el.btext.style.maxHeight = cap(below);
    } else {
      S.bubbleFit = { side: 'above', edge: r.top - 10 }; // anchored by its bottom edge: grows upwards
      el.btext.style.maxHeight = cap(above);
    }
  } else {
    const pos = placeNear(S.anchor ?? { x: S.W / 2 - 1, y: S.H / 3, w: 2, h: 2 }, w, 170, S.W, S.H, 14);
    x = pos.x;
    S.bubbleFit = { side: 'below', edge: pos.y };
    el.btext.style.maxHeight = cap(S.H - 8 - pos.y);
  }
  el.bubble.style.left = clamp(x, 8, Math.max(8, S.W - w - 8)) + 'px';
  fitBubble();
}

/** Keep the whole bubble on screen, and clear of the dialog, whatever its height is now. */
function fitBubble() {
  if (el.bubble.dataset.moved) return;
  const fit = S.bubbleFit;
  if (!fit || el.bubble.hidden) return;
  const hgt = el.bubble.offsetHeight;
  const top = fit.side === 'above' ? fit.edge - hgt : Math.min(fit.edge, S.H - 8 - hgt);
  el.bubble.style.top = Math.max(8, top) + 'px';
}

function appendAnswerText(text) {
  // Handles such as @2 are tinted so the answer visibly refers to what was pinned.
  for (const part of text.split(/(@\d{1,3})/)) {
    if (!part) continue;
    if (/^@\d{1,3}$/.test(part) && refOf(part)) el.btext.append(h('span', { class: 'ref' }, part));
    else el.btext.append(part);
  }
  el.btext.scrollTop = el.btext.scrollHeight;
  fitBubble();
}

function renderFinishedAnswer() {
  if (!S.answer) return;
  el.btext.classList.add('md');
  el.btext.replaceChildren(renderMarkdown(S.answer.streamText || S.answer.text, mdOpts()));
}

function onAnswerDone(d) {
  if (!S.answer || S.answer.id !== d.id) return;
  S.answer.done = true;
  el.bubble.classList.remove('busy');
  el.bstop.hidden = true;
  el.bstatus.hidden = true;
  if (S.answer.text) {
    renderFinishedAnswer();
    S.lastTurn = { q: S.answer.q, streamText: S.answer.streamText, text: S.answer.text };
  }
  const parts = [];
  if (d.copied) parts.push(h('span', { class: 'copied' }, '✓ 已自动复制结果（按 Ctrl+V 粘贴）'));
  if (d.firstMs != null) parts.push(h('span', {}, '首字 ', h('b', {}, (d.firstMs / 1000).toFixed(1) + ' 秒')));
  if (d.totalMs != null) parts.push(h('span', {}, '共 ', h('b', {}, (d.totalMs / 1000).toFixed(1) + ' 秒'), d.locateMs > 300 ? `（其中定位 ${(d.locateMs / 1000).toFixed(1)} 秒）` : ''));
  const out = S.answer.where !== 'local'; // the question left this computer
  // What actually went with the question, which can be more than was announced when it was
  // asked (a conversation too long for the model is asked again with its screenshots).
  const bytes = d.sentBytes ?? S.answer.bytes;
  const fraction = d.sentFraction ?? S.answer.fraction;
  if (bytes) parts.push(h('span', {}, out ? '发送了 ' : '读入 ', h('b', {}, kb(bytes)), fraction ? `（屏幕的 ${Math.max(1, Math.round(fraction * 100))}%）` : ''));
  parts.push(h('span', { class: out ? 'out' : '' }, S.config.badge === '回放' ? '回放：真实模型在另一台机器上的回答与耗时' : out ? `已发送到 ${S.answer.where}` : '全程在本机'));
  if (d.note) parts.push(h('span', {}, d.note));
  // The local model's answer not good enough: the same question, to the network model. Only
  // offered when that is set up and switched on; the button says where the question would go.
  if (!S.answer.cloud && S.config.cloud && !S.config.scripted) parts.push(h('button', { class: 'link', dataset: { reask: 'cloud' }, title: `把这个问题和它的截图发送到 ${S.config.cloud.host}` }, `${S.config.cloud.name} 重答`));
  el.bfoot.replaceChildren(...parts);
  fitBubble();
  reportIdle();
}

function onAnswerError(e) {
  if (!S.answer || S.answer.id !== e.id) return;
  S.answer.done = true;
  el.bubble.classList.remove('busy');
  el.bstop.hidden = true;
  el.bstatus.hidden = true;
  if (e.kind === 'aborted') {
    el.bfoot.textContent = '已停止';
    return;
  }
  if (!S.answer.text) el.btext.textContent = '';
  el.btext.classList.remove('md');
  el.btext.classList.toggle('error', !S.answer.text);
  el.btext.append(S.answer.text ? '\n\n' + e.message : e.message);
  if (e.kind === 'nomodel' || e.kind === 'local') {
    el.btext.append(' ', h('button', { class: 'link', onclick: () => api.openSettings('local') }, '打开设置'));
    if (S.config.cloud) el.btext.append(' ', h('button', { class: 'link', dataset: { reask: 'cloud' }, title: `把这个问题和它的截图发送到 ${S.config.cloud.host}` }, `改用${S.config.cloud.name}`));
  } else if (e.kind === 'cloud' || e.kind === 'refusal') {
    el.btext.append(' ', h('button', { class: 'link', onclick: () => api.openSettings('cloud') }, '打开设置'), ' ', h('button', { class: 'link', dataset: { reask: 'local' } }, '改用本机模型'));
  }
  fitBubble();
  reportIdle();
}

// ------------------------------------------------------------------ the AI points back

function clearMarks() {
  S.markGeneration++;
  S.markQueue = Promise.resolve();
  clearTimeout(S.timers.marks);
  for (const m of S.marks) m.el.remove();
  S.marks = [];
  S.aiAt = null;
  el.ai.classList.remove('on');
  el.snapshot.hidden = true;
  el.smarks.textContent = '';
}

function fadeMarks() {
  const generation = S.markGeneration;
  for (const m of S.marks) m.el.classList.add('fade');
  el.ai.classList.remove('on');
  setTimeout(() => {
    if (S.mode === 'idle' && generation === S.markGeneration) {
      clearMarks();
      reportIdle();
    }
  }, 900);
}

function onMark(m) {
  if (S.answer && m.answerId === S.answer.id) {
    S.answer.streamText += badgeToken(m.n);
    S.answer.marks++;
    if (S.answer.done) {
      renderFinishedAnswer();
      if (S.lastTurn) S.lastTurn.streamText = S.answer.streamText;
    } else {
      el.btext.append(h('span', { class: 'badge' }, String(m.n)));
    }
    fitBubble();
  }
  if (S.mode === 'idle') {
    clearTimeout(S.timers.marks);
    S.timers.marks = setTimeout(() => fadeMarks(), 14000);
  }
  // Marks arrive faster than the cursor can fly: play them one after another.
  const generation = S.markGeneration;
  S.markQueue = S.markQueue.then(() => {
    if (generation !== S.markGeneration) return;
    return m.where === 'snapshot' ? showOnSnapshot(m, generation) : flyTo(m, generation);
  }).catch(() => {});
}

async function flyTo(m, generation) {
  const node = h('div', { class: 'mark' + (m.x > S.W - 240 ? ' left' : '') + (m.y < 60 ? ' low' : '') });
  node.style.transform = `translate(${m.x}px, ${m.y}px)`;
  if (m.box) {
    const area = h('div', { class: 'area' });
    Object.assign(area.style, { left: m.box.x - m.x - 4 + 'px', top: m.box.y - m.y - 4 + 'px', width: m.box.w + 8 + 'px', height: m.box.h + 8 + 'px' });
    node.append(area);
  } else {
    node.append(h('div', { class: 'ring' }));
  }
  node.append(h('div', { class: 'lab' }, h('span', { class: 'n' }, String(m.n)), m.label || m.handle));
  el.marks.append(node);
  S.marks.push({ el: node, mark: m });
  reportIdle();

  // The AI's cursor starts from the answer bubble (or from where it last was) and flies over.
  if (!S.aiAt) {
    const r = el.bubble.hidden ? { left: S.W / 2, top: S.H / 2, width: 0, height: 0 } : el.bubble.getBoundingClientRect();
    S.aiAt = { x: r.left + r.width / 2, y: r.top + 14 };
    el.ai.style.transition = 'none';
    el.ai.style.transform = `translate(${S.aiAt.x}px, ${S.aiAt.y}px)`;
    el.ai.classList.add('on');
    await nextFrame();
    await nextFrame();
    if (generation !== S.markGeneration) return;
    el.ai.style.transition = '';
  }
  el.ai.style.transform = `translate(${m.x}px, ${m.y}px)`;
  S.aiAt = { x: m.x, y: m.y };
  await new Promise((r) => setTimeout(r, 720));
  if (generation !== S.markGeneration) return;
  node.classList.add('on');
  await new Promise((r) => setTimeout(r, 380));
}

async function showOnSnapshot(m, generation) {
  const url = await api.referentImage(m.handle);
  if (!url || generation !== S.markGeneration) return;
  if (el.snapshot.dataset.handle !== m.handle || el.snapshot.hidden) {
    el.smarks.textContent = '';
    el.simg.src = url;
    el.snapshot.dataset.handle = m.handle;
  }
  el.stitle.textContent = `${m.handle} 已悬空 · ${m.who} 指在快照上`;
  const px = (v, total) => (v / total) * 100 + '%';
  if (m.kind === 'box') {
    const ar = h('div', { class: 'ar' });
    Object.assign(ar.style, { left: px(m.image.x, m.image.iw), top: px(m.image.y, m.image.ih), width: px(m.image.w, m.image.iw), height: px(m.image.h, m.image.ih) });
    el.smarks.append(ar);
  }
  const cx = m.kind === 'box' ? m.image.x + m.image.w / 2 : m.image.x;
  const cy = m.kind === 'box' ? m.image.y + m.image.h / 2 : m.image.y;
  const pt = h('div', { class: 'pt' }, m.kind === 'box' ? null : h('div', { class: 'ring' }), h('span', { class: 'n' }, String(m.n)));
  Object.assign(pt.style, { left: px(cx, m.image.iw), top: px(cy, m.image.ih) });
  el.smarks.append(pt);
  el.snapshot.hidden = false;
  if (!el.snapshot.dataset.moved) {
    const r = el.bubble.hidden ? null : el.bubble.getBoundingClientRect();
    const pos = r
      ? placeNear({ x: r.left, y: r.top, w: r.width, h: r.height }, 440, 300, S.W, S.H, 12)
      : { x: S.W - 460, y: 70 };
    el.snapshot.style.left = clamp(pos.x, 8, S.W - 448) + 'px';
    el.snapshot.style.top = clamp(pos.y, 8, S.H - 200) + 'px';
  }
  reportIdle();
}

// ------------------------------------------------------------------ rendering

function renderAll() {
  renderDock();
  renderPins();
  renderSendList();
  renderHud();
  renderHint();
  renderContext();
  reportIdle();
}

function renderDock() {
  el.dock.hidden = S.refs.length === 0;
  const pointing = S.mode === 'pointing';
  el.chips.replaceChildren(
    ...S.refs.map((r) => {
      const selected = S.fresh.includes(r.handle) || S.extra.has(r.handle);
      return h(
        'div',
        { class: 'chip' + (r.state === 'dangling' ? ' dangling' : '') + (selected && pointing ? ' sel' : ''), dataset: { handle: r.handle }, title: chipTitle(r) },
        h('img', { src: r.thumb, alt: '' }),
        h('b', {}, r.handle),
        r.label ? h('span', { class: 'l' }, r.label) : null,
        h('i', { class: 'st' }),
        r.readers.length ? h('span', { class: 'use' }, `已读 ${r.readers.length}`) : null,
        h('button', { class: 'ghost', title: '释放这个引用', dataset: { release: r.handle } }, '✕'),
      );
    }),
  );
}

function chipTitle(r) {
  const lines = [`${r.handle} · ${r.imageSize.w}×${r.imageSize.h} · ${kb(r.bytes)}`];
  lines.push(r.state === 'dangling' ? '悬空：屏幕上这里已经变了' : '有效：屏幕上还是这个内容');
  if (r.readers.length) lines.push('读过它的：' + r.readers.join('、'));
  return lines.join('\n');
}

function renderPins() {
  if (S.mode !== 'pointing') {
    el.pins.textContent = '';
    return;
  }
  el.pins.replaceChildren(
    ...S.refs
      .filter((r) => r.displayId === S.displayId && r.kind !== 'screen')
      .map((r) => {
        const active = S.fresh.includes(r.handle) || S.extra.has(r.handle);
        const node = h('div', { class: 'pin' + (active ? '' : ' old') + (r.state === 'dangling' ? ' dangling' : '') }, h('b', {}, r.handle));
        Object.assign(node.style, { left: r.box.x - 2 + 'px', top: r.box.y - 2 + 'px', width: r.box.w + 4 + 'px', height: r.box.h + 4 + 'px' });
        return node;
      }),
  );
}

function renderSendList() {
  const handles = [...S.fresh, ...S.extra].filter(refOf);
  // "Read" on this computer; "sent" when the next question goes to the network model.
  const nodes = [h('span', { class: 'lead' }, S.config.where && S.config.where !== 'local' ? '将发送' : '将读入')];
  if (!handles.length) {
    nodes.push(h('span', { class: 'send ghostchip' }, S.phase === 'after' ? '接着上面的话题' : '你正指着的这一块 · 左键截图'));
    // A follow-up names nothing, but it may still take screenshots along: the ones the topic is
    // about, when the model that answers next has not been shown them. They are listed.
    if (S.phase === 'after') {
      for (const c of S.config.carry ?? []) {
        const r = refOf(c.handle);
        nodes.push(h('span', { class: 'send carried', title: '这个话题的截图，会随这次提问一起' + (S.config.where && S.config.where !== 'local' ? '发送' : '读入') }, r ? h('img', { src: r.thumb, alt: '' }) : null, h('b', {}, c.handle)));
      }
    }
  }
  for (const handle of handles) {
    const r = refOf(handle);
    nodes.push(
      h(
        'span',
        { class: 'send' + (r.state === 'dangling' ? ' dangling' : '') },
        h('img', { src: r.thumb, alt: '' }),
        h('b', {}, handle),
        h('button', { class: 'ghost', title: '不带它', dataset: { drop: handle } }, '✕'),
      ),
    );
  }
  el.sendlist.replaceChildren(...nodes);
  el.sendlist.hidden = S.inputMode === 'context' || (!handles.length && S.phase !== 'after');
  const followUp = !handles.length && S.phase === 'after';
  const selected = handles.length || followUp;
  const tools = selected ? [h('button', { type: 'button', dataset: { qact: 'copy' } }, '复制截图'), h('button', { type: 'button', dataset: { qact: 'save' } }, '保存截图')] : [];
  if (selected && S.config.local?.tier === 'large') tools.push(h('button', { type: 'button', dataset: { qact: 'ocr' } }, '提取文字'));
  el.presets.replaceChildren(...(tools.length ? [h('div', { class: 'quick-group' }, ...tools)] : []));
  el.presets.hidden = S.inputMode === 'context' || !tools.length;
  document.querySelector('.section-label').hidden = S.inputMode !== 'context' && !tools.length;
}

function contextHasSelection() {
  return Boolean(S.context?.files?.length || S.context?.selectedText?.trim());
}

function setInputMode(mode) {
  if (voiceActive()) cancelVoice();
  S.inputMode = mode === 'context' ? 'context' : 'screen';
  if (S.inputMode === 'screen' && !S.fresh.length && !S.extra.size && !S.answer && S.box) {
    S.phase = 'hover';
    S.target = S.box;
  }
  renderContext();
  renderHud();
  showDialog(S.anchor ?? S.target ?? S.box ?? { x: S.cursor.x, y: S.cursor.y, w: 1, h: 1 });
  const d = distToDialog(S.cursor.x, S.cursor.y);
  S.hoverFrom = { x: S.cursor.x, y: S.cursor.y, start: d, min: d };
  el.q.focus();
}

function renderContext() {
  const active = S.inputMode === 'context';
  const c = S.context;
  const hasSelection = Boolean(c?.files?.length || c?.selectedText?.trim());
  const basic = S.config.local?.tier !== 'large';
  $('compactmode').textContent = `${basic ? '基础办公' : '文档助手'} · ${S.config?.local?.selectionMode === 'manual' ? '使用指定模型' : '自动匹配本机资源'}`;
  $('selectionhint').hidden = active && hasSelection && !S.selectionMessage;
  $('selectionhint').textContent = S.resolvingFiles ? '正在查找框内的真实文件…' : S.selectionMessage || '拖动框住桌面或文件夹里的文件图标';
  el.screenmode.setAttribute('aria-selected', String(!active));
  el.contextmode.setAttribute('aria-selected', String(active));
  el.contextcard.hidden = !active;
  el.contextactions.hidden = !active;
  el.sendlist.hidden = active || (!S.fresh.length && !S.extra.size && S.phase !== 'after');
  el.presets.hidden = active || !el.presets.childElementCount;
  el.asktools.hidden = active;
  el.asktools.querySelector('[data-qact="ocr"]').hidden = basic;
  el.qsend.disabled = S.resolvingFiles || (active ? S.contextBusy || !hasSelection : !S.fresh.length && !S.extra.size && !S.answer);
  document.querySelector('.section-label').hidden = active ? !hasSelection : el.presets.hidden;
  $('quicklabel').textContent = active ? '处理这些文件' : '截图工具';
  $('quicknote').textContent = '';
  el.q.placeholder = active
    ? c?.files?.length ? '例如：合并成 PDF' : '例如：整理这段文字'
    : S.fresh.length || S.extra.size || S.answer ? '输入与截图有关的问题' : '先框住文件，再输入操作';
  if (!active) return;

  const files = c?.files ?? [];
  const text = c?.selectedText ?? '';
  const fileNodes = files.slice(0, 3).map((f) => h('div', { class: 'context-file', title: f.path ?? f.name },
    h('span', { class: 'file-type' }, (f.kind || f.name?.split('.').pop() || '文件').slice(0, 5).toUpperCase()),
    h('span', {}, f.name || f.path?.split(/[/\\]/).pop() || '已选文件')));
  el.contextcard.replaceChildren(...[
    h('div', { class: 'context-source' }, h('span', { class: 'context-dot' }), h('b', {}, files.length ? `已找到 ${files.length} 个文件` : '已选文字'), h('span', { class: 'grow' })),
    ...fileNodes,
    files.length > 3 ? h('div', { class: 'context-more' }, `另有 ${files.length - 3} 个文件`) : null,
    text ? h('blockquote', { class: 'context-selection' }, text.length > 220 ? text.slice(0, 220) + '…' : text) : null,
    !files.length && !text ? h('div', { class: 'context-empty' }, '拖动框住文件图标，显示对应操作。') : null,
    ...(c?.warnings ?? []).slice(0, 1).map((warning) => h('div', { class: 'context-warning' }, warning)),
  ].filter((node) => node != null));

  const actions = (c?.availableActions ?? []).filter((action) => action.category !== 'controls' && !action.id.startsWith('file.'));
  const button = (action) => h('button', {
    type: 'button', class: 'context-action', disabled: S.contextBusy, title: action.hint || action.label,
    dataset: { contextAction: action.id },
    onclick: () => {
      if (action.param) {
        S.contextParam = action;
        renderContext();
        requestAnimationFrame(() => el.contextactions.querySelector('.context-param input, .context-param select')?.focus());
      } else void runContext({ actionId: action.id });
    },
  }, h('span', {}, action.label), h('span', { class: 'action-arrow', 'aria-hidden': 'true' }, '↗'));
  const nodes = [];
  if (actions.length) {
    const groups = [
      { label: '文件与内容', actions: actions.filter((a) => a.category !== 'controls') },
    ].filter((group) => group.actions.length);
    for (const group of groups) {
      nodes.push(h('div', { class: 'context-action-section' },
        groups.length > 1 ? h('div', { class: 'quick-group-label' }, group.label) : null,
        h('div', { class: 'context-action-grid' }, ...group.actions.slice(0, 4).map(button)),
        group.actions.length > 4 ? h('details', { class: 'more-prompts' }, h('summary', {}, `查看全部${group.label}（${group.actions.length}）`), h('div', { class: 'context-action-grid' }, ...group.actions.slice(4).map(button))) : null,
      ));
    }
  } else if (text && !basic) {
    nodes.push(h('div', { class: 'context-action-grid' }, ...['总结选中的文字', '翻译成中文', '提炼待办事项', '润色表达'].map((instruction) => h('button', { type: 'button', class: 'context-action', disabled: S.contextBusy, onclick: () => runContext({ instruction }) }, instruction))));
  }
  if (S.contextParam) {
    const action = S.contextParam, p = action.param;
    const input = p.kind === 'select'
      ? h('select', {}, ...(p.options ?? []).map((o) => h('option', { value: o.value, selected: o.value === p.defaultValue }, o.label)))
      : h('input', { type: 'text', value: p.defaultValue ?? '', placeholder: p.placeholder ?? '输入操作参数' });
    nodes.push(h('div', { class: 'context-param' }, h('label', {}, action.label), input,
      h('button', { type: 'button', class: 'primary-button', disabled: S.contextBusy, onclick: () => runContext({ actionId: action.id, param: input.value.trim() }) }, p.submitLabel || '执行'),
      h('button', { type: 'button', class: 'ghost', onclick: () => { S.contextParam = null; renderContext(); } }, '取消')));
  }
  const result = S.contextResult;
  if (S.contextBusy) nodes.push(h('div', { class: 'context-status busy', role: 'status' }, h('span', { class: 'spin' }), h('span', { class: 'grow' }, result?.text || '正在处理…'), h('button', { type: 'button', class: 'ghost', disabled: S.contextStopping, onclick: cancelContext }, S.contextStopping ? '停止中' : '停止')));
  else if (result) {
    const plan = result.plan;
    nodes.push(h('div', { class: 'context-status ' + result.kind, role: 'status' },
      h('b', {}, plan ? '操作预览' : result.kind === 'error' ? '需要调整一下' : '处理结果'),
      h('div', { class: 'context-result-text' }, plan?.summary || result.text),
      plan ? h('ol', {}, ...(plan.steps ?? []).map((step) => h('li', {}, step.label || step.description || step.actionId, step.param != null ? h('div', { class: 'plan-param' }, String(step.param)) : null))) : null,
      plan ? h('div', { class: 'context-plan-buttons' },
        h('button', { class: 'primary-button', type: 'button', dataset: { executePlan: plan.id }, onclick: () => runContext(null, plan.id) }, '确认执行'),
        h('button', { class: 'ghost', type: 'button', onclick: cancelContext }, '取消')) : null,
    ));
  }
  el.contextactions.replaceChildren(...nodes);
  if (S.mode === 'pointing' && !el.ask.classList.contains('quiet')) placeAsk(S.anchor ?? S.target ?? S.box ?? { x: S.cursor.x, y: S.cursor.y, w: 1, h: 1 });
  reportIdle();
}

function cancelContext() {
  api.contextCancel();
  if (S.contextBusy) {
    S.contextStopping = true;
    S.contextResult = { text: '正在停止…' };
  } else {
    S.contextResult = null;
  }
  renderContext();
}

async function runContext(request, planId) {
  if (S.contextBusy) return;
  const generation = ++S.contextRequest;
  S.contextBusy = true;
  S.contextStopping = false;
  S.contextResult = { text: planId ? '正在执行已确认的操作…' : request?.actionId ? '正在执行操作…' : '正在理解你的需求…' };
  renderContext();
  try {
    const result = planId ? await api.contextExecute(planId) : await api.contextRun(request);
    if (generation !== S.contextRequest) return;
    S.contextResult = result?.ok
      ? { kind: 'success', text: result.message || (result.plan ? '' : '操作已完成。'), plan: result.plan }
      : { kind: 'error', text: result?.error || result?.message || '暂时未能完成，请换一种方式描述需求。' };
    if (result?.ok) {
      el.q.value = '';
      S.contextParam = null;
    }
  } catch (error) {
    if (generation !== S.contextRequest) return;
    S.contextResult = { kind: 'error', text: error.message || '操作失败，请重试。' };
  } finally {
    if (generation === S.contextRequest) {
      S.contextBusy = false;
      S.contextStopping = false;
      renderContext();
    }
  }
}

function renderHud() {
  const handles = [...S.fresh, ...S.extra].filter(refOf);
  const c = S.config;
  if (S.inputMode === 'context') {
    const where = c.where || S.context?.where || 'local';
    const out = where !== 'local';
    const nodes = [h('span', {}, h('b', {}, c.brain || S.context?.model || '本地模型')),
      h('span', { class: out ? 'lock out' : 'lock' }, out ? `模型任务发送到 ${where}` : '文件操作在本机完成')];
    if (c.cloud) nodes.push(h('button', { class: 'switch', dataset: { via: c.cloud.on ? 'local' : 'cloud' } }, c.cloud.on ? '换回本机模型' : `换${c.cloud.name}`));
    el.hud.replaceChildren(...nodes);
    return;
  }
  // Nothing pinned after an answer: what goes along is what the follow-up carries, if anything.
  const carry = !handles.length && S.phase === 'after' ? (c.carry ?? []) : [];
  const bytes = handles.reduce((n, x) => n + refOf(x).bytes, 0) + carry.reduce((n, x) => n + x.bytes, 0);
  const area = handles.reduce((n, x) => n + (refOf(x).box.w * refOf(x).box.h) / (S.W * S.H), 0) + carry.reduce((n, x) => n + x.fraction, 0);
  const nodes = [h('span', {}, h('b', {}, c.brain ?? '本地模型'), c.scripted && c.badge !== '回放' ? '（排练脚本）' : '')];
  const out = c.where && c.where !== 'local'; // the next question goes to the network
  if (bytes) nodes.push(h('span', {}, out ? '只发送 ' : '只读入 ', h('b', {}, kb(bytes)), area ? `，屏幕的 ${Math.max(1, Math.round(area * 100))}%` : ''));
  nodes.push(h('span', { class: out ? 'lock out' : 'lock' }, c.badge === '回放' ? '回放真实模型的记录' : c.scripted ? '不调用任何模型' : out ? `发送到 ${c.where}` : '不出本机'));
  if (c.brainAvailable === false) nodes.push(h('span', {}, '模型未安装'));
  // With the network model switched on in the settings: one click changes who answers this topic.
  if (c.cloud) nodes.push(h('button', { class: 'switch', dataset: { via: c.cloud.on ? 'local' : 'cloud' } }, c.cloud.on ? '换回本机模型' : `换${c.cloud.name}`));
  el.hud.replaceChildren(...nodes);
}

function renderHint() {
  if (el.hint.hidden) return;
  const sep = () => h('i', {}, '·');
  el.hint.replaceChildren(
    '左键 ', h('b', {}, '截图'), sep(), '右键或 Esc ', h('b', {}, '取消截图'), sep(),
    '滚轮或 [ ] ', h('b', {}, '换范围'), sep(), 'Ctrl+C ', h('b', {}, '复制截图'), sep(),
    '左键拖拽 ', h('b', {}, '框选'),
  );
}

function toast({ text, kind }) {
  const node = h('div', { class: 'toast ' + (kind ?? 'info') }, text);
  el.toasts.append(node);
  reportIdle();
  setTimeout(() => node.classList.add('out'), 3200);
  setTimeout(() => {
    node.remove();
    reportIdle();
  }, 3800);
}

// Tell the main process whether the idle overlay has anything to show, and where its
// clickable panels are, so the window can stay hidden or click-through everywhere else.
let idleQueued = false;
function reportIdle() {
  if (idleQueued) return;
  idleQueued = true;
  requestAnimationFrame(() => {
    idleQueued = false;
    const panels = [el.dock, el.bubble, el.snapshot, el.act, el.actpill].filter((p) => !p.hidden);
    api.idleContent(panels.length > 0 || S.marks.length > 0 || el.toasts.childElementCount > 0);
    api.rects(panels.map((p) => {
      const r = p.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }));
  });
}

// Native history disclosure changes the bubble without going through a render function.
// Keep both its screen position and the main process's click-through regions in sync.
const panelObserver = new ResizeObserver(() => {
  fitBubble();
  reportIdle();
});
for (const panel of [el.ask, el.bubble, el.snapshot, el.act, el.dock]) panelObserver.observe(panel);

function makeDraggable(panel, grip) {
  let drag = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest?.('button,input,textarea,select,a,summary')) return;
    const r = panel.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height, moved: false };
    grip.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) <= 4) return;
    drag.moved = true;
    panel.dataset.moved = '1';
    const W = S.W || window.innerWidth, H = S.H || window.innerHeight;
    panel.style.left = clamp(drag.left + dx, 4, Math.max(4, W - drag.w - 4)) + 'px';
    panel.style.top = clamp(drag.top + dy, 4, Math.max(4, H - drag.h - 4)) + 'px';
  });
  const finish = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const wasMoved = drag.moved;
    drag = null;
    if (wasMoved) reportIdle();
  };
  grip.addEventListener('pointerup', finish);
  grip.addEventListener('pointercancel', finish);
}
makeDraggable(el.ask, el.sendlist);
makeDraggable(el.ask, el.askhead);
makeDraggable(el.bubble, el.bubble.querySelector('header'));
makeDraggable(el.snapshot, el.snapshot.querySelector('header'));
makeDraggable(el.act, el.act.querySelector('header'));

function currentTargetPayload() {
  const box = S.phase === 'track' ? S.box : (S.phase === 'hover' && S.target) ? S.target : (S.anchor ?? S.box);
  return box ? { box: { x: box.x, y: box.y, w: box.w, h: box.h } } : {};
}

function pinnedUnder(x, y, curBox) {
  const candidates = S.refs.filter((r) => r.displayId === S.displayId && r.kind !== 'screen');
  if (curBox) {
    const exact = candidates.find((r) => iou(curBox, r.box) > 0.72);
    if (exact) return exact;
    const inside = candidates.find((r) => contains(r.box, x, y) && iou(curBox, r.box) > 0.45);
    if (inside) return inside;
  }
  return null;
}

// ------------------------------------------------------------------ input

function cancelScreenshot() {
  // Stop local gestures immediately, before the main-process exit acknowledgement arrives.
  // A late left-button release or pending screenshot must not create another capture.
  enterIdle();
  api.exit();
}

// Pointer Events emits no second pointerdown when right is pressed while left is held.
// Listen for that mouse-button chord too, so right-click can cancel an active drag.
window.addEventListener('mousedown', (e) => {
  if (S.mode !== 'pointing' || e.button !== 2) return;
  e.preventDefault();
  cancelScreenshot();
});

window.addEventListener('pointermove', (e) => {
  if (S.mode !== 'pointing') return;
  S.lastInput = Date.now();
  // Chromium reports an additional pressed button as pointermove. Cancelling the
  // initial pointerdown may also suppress compatibility mousedown during this drag.
  if (e.pointerType === 'mouse' && (e.buttons & 2)) {
    e.preventDefault();
    cancelScreenshot();
    return;
  }
  const moved = Math.hypot(e.clientX - S.cursor.x, e.clientY - S.cursor.y);
  S.cursor = { x: e.clientX, y: e.clientY };
  S.overPanel = Boolean(e.target.closest?.('.panel'));
  moveHalo();
  if (S.drag && !(e.buttons & 1)) {
    // The left button is no longer down, but no release reached us (two buttons were pressed
    // together and the other one came up last): this is not a drag any more.
    S.drag = null;
    el.drag.style.display = 'none';
  }
  if (S.drag) {
    const d = Math.hypot(e.clientX - S.drag.x, e.clientY - S.drag.y);
    if (d > 6) S.drag.active = true;
    if (S.drag.active) {
      const b = boxFromPoints(S.drag, S.cursor);
      Object.assign(el.drag.style, { display: 'block', left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' });
      el.snap.classList.remove('on');
      return;
    }
  }
  if (S.phase === 'hover' && S.inputMode === 'screen' && !voiceActive()) {
    // The dialog floats beside its target. Travelling between the two keeps both; leaving
    // lets the box follow the cursor again and the dialog wait for the next rest.
    if (headingToDialog(e.clientX, e.clientY)) return;
    releaseDialog();
  }
  queueSnap();
  if (moved > 2) armDwell();
});

window.addEventListener('pointerdown', (e) => {
  if (S.mode !== 'pointing') return;
  S.lastInput = Date.now();
  if (e.button === 2) {
    e.preventDefault();
    cancelScreenshot();
    return;
  }
  if (e.target.closest?.('.panel')) return;
  e.preventDefault(); // keep the keyboard focus in the question field
  if (S.inputMode === 'context') setInputMode('screen');
  clearTimeout(S.dwellTimer);
  if (e.button === 0) S.drag = { x: e.clientX, y: e.clientY, active: false };
});

async function resolveFileRegion(box) {
  if (S.resolvingFiles) return;
  const generation = ++S.selectionGeneration;
  const displayId = S.displayId;
  S.anchor = box;
  S.target = box;
  S.phase = 'fixed';
  S.selectionMessage = '';
  S.resolvingFiles = true;
  renderContext();
  showDialog(box);
  try {
    const result = await api.resolveFiles({ box });
    if (generation !== S.selectionGeneration || S.mode !== 'pointing' || S.displayId !== displayId) return;
    if (result?.ok && result.matched) {
      S.inputMode = 'context';
      S.selectionMessage = '';
    } else {
      S.selectionMessage = result?.error || result?.warnings?.[0] || '框内没有找到可确认的文件。请框住文件图标和名称。';
      // The screenshot stays usable, but no ambiguous path becomes an executable file action.
      await pin({ ...box, kind: 'region' }, 'region');
    }
  } catch (err) {
    if (generation === S.selectionGeneration) S.selectionMessage = /No handler/.test(err?.message || '') ? '文件框选功能已更新，请完整退出并重新打开指点。' : '暂时无法读取这些文件，请回到文件夹后重新按 F8。';
  } finally {
    if (generation === S.selectionGeneration) {
      S.resolvingFiles = false;
      if (S.mode === 'pointing') { renderContext(); showDialog(box); }
    }
  }
}

window.addEventListener('pointerup', (e) => {
  if (S.mode !== 'pointing' || e.button !== 0 || !S.drag) return;
  const drag = S.drag;
  S.drag = null;
  el.drag.style.display = 'none';
  if (drag.active) {
    const b = boxFromPoints(drag, { x: e.clientX, y: e.clientY });
    if (b.w >= 8 && b.h >= 8) void resolveFileRegion(b);
  } else {
    const curBox = S.phase === 'hover' && S.target ? S.target : S.box;
    const existing = pinnedUnder(e.clientX, e.clientY, curBox);
    if (existing) {
      if (!S.fresh.includes(existing.handle)) S.extra.add(existing.handle);
      S.phase = 'fixed';
      showDialog(S.anchor ?? existing.box);
      renderAll();
    } else void pinCurrent();
  }
  queueSnap();
  el.q.focus();
});

window.addEventListener('pointercancel', () => {
  S.drag = null;
  el.drag.style.display = 'none';
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('wheel', (e) => {
  if (S.mode !== 'pointing' || e.target.closest?.('.panel')) return;
  e.preventDefault();
  S.lastInput = Date.now();
  // A mouse wheel sends one event of about 100 per notch; a touchpad sends dozens of small
  // ones per swipe, and sideways swipes with no vertical part at all. One notch, or that much
  // travel, is one step.
  if (!e.deltaY) return;
  const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
  const now = Date.now();
  if (now - S.wheel.at > 220 || Math.sign(dy) !== Math.sign(S.wheel.acc)) S.wheel.acc = 0;
  S.wheel.at = now;
  S.wheel.acc += dy;
  if (Math.abs(S.wheel.acc) < 40) return;
  const dir = (S.wheel.acc < 0 ? 1 : -1) * (S.config.naturalWheel ? -1 : 1);
  changeScope(dir);
  S.wheel.acc = 0;
  if (S.phase === 'track' || S.phase === 'after') armDwell();
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // an input method is composing: not ours
  if (S.mode !== 'pointing') {
    if (e.key === 'Escape' && S.act && S.act.state !== 'working') {
      e.preventDefault();
      hideAct(true);
    }
    return;
  }
  S.lastInput = Date.now();
  if (e.key === 'Escape' && voiceActive()) {
    e.preventDefault();
    cancelVoice();
    return;
  }
  if (e.key === 'Enter' && voiceActive() && !e.target?.closest?.('button')) {
    e.preventDefault();
    if (S.voice.state === 'listening') void voice.stop();
    return;
  }
  if (e.target?.closest?.('.context-param')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      S.contextParam = null;
      renderContext();
      el.q.focus();
    } else if (e.key === 'Enter' && e.target.matches('input')) {
      e.preventDefault();
      e.target.closest('.context-param').querySelector('.primary-button')?.click();
    }
    return;
  }
  const inParamInput = e.target?.closest?.('#actparam input');
  if (inParamInput) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeActParam();
    }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (S.inputMode === 'context' && (S.contextBusy || S.contextResult?.plan)) {
      cancelContext();
      return;
    }
    // First Esc stops an answer that is still coming; if it is already stopping (or there is
    // none), Esc clears what was typed, or dismisses an open action card, and then leaves.
    if (S.answer && !S.answer.done && !S.answer.stopping) {
      S.answer.stopping = true;
      api.stop();
    } else if (el.q.value) el.q.value = '';
    else if (S.act && S.act.state !== 'working') hideAct(true);
    else cancelScreenshot();
    return;
  }
  if (e.key === 'Enter') {
    if ((e.shiftKey && e.target === el.q) || e.target?.closest?.('button,select,summary')) return;
    e.preventDefault();
    submit();
    return;
  }
  if (e.key === 'Tab') {
    if (S.inputMode === 'context') return;
    e.preventDefault();
    changeScope(e.shiftKey ? -1 : 1);
    return;
  }
  if (S.inputMode === 'screen' && (e.key === '[' || e.key === ']') && !el.q.value && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    changeScope(e.key === ']' ? 1 : -1);
    return;
  }
  if (e.key === 'Backspace' && S.inputMode === 'screen' && !el.q.value && S.fresh.length) {
    e.preventDefault();
    unpinLastFresh();
    return;
  }
  if (S.inputMode === 'screen' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
    const qSel = document.activeElement === el.q && el.q.selectionStart !== el.q.selectionEnd;
    if (!qSel && !String(window.getSelection())) {
      e.preventDefault();
      void api.captureCopy(currentTargetPayload()).then((res) => { if (res?.ok) api.exit(); });
      return;
    }
  }
  if (S.inputMode === 'screen' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void api.captureSave(currentTargetPayload());
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    api.newThread();
    forgetAnswer();
    toast({ text: '已开始新话题' });
    return;
  }
  if (document.activeElement !== el.q && !e.target?.closest?.('button,select,summary')) el.q.focus();
});

/** A new topic: the next question is a first question again and needs something to be about. */
function forgetAnswer() {
  cancelVoice();
  S.answer = null;
  S.history = [];
  S.lastTurn = null;
  S.asked = [];
  delete el.bubble.dataset.moved;
  renderHistory();
  el.bubble.hidden = true;
  clearMarks();
  if (S.mode === 'pointing' && S.phase === 'after') {
    S.phase = 'track';
    hideDialog();
  }
  renderAll();
}

el.q.addEventListener('input', () => {
  S.lastInput = Date.now();
});

document.addEventListener('click', (e) => {
  const t = e.target.closest?.('[data-release],[data-drop],[data-preset],[data-via],[data-reask],[data-qact],[data-scope],.chip');
  if (!t) return;
  if (t.dataset.via) {
    api.via(t.dataset.via);
  } else if (t.dataset.reask) {
    clearMarks();
    api.reask(t.dataset.reask);
  } else if (t.dataset.release) {
    api.unpin(t.dataset.release);
  } else if (t.dataset.drop) {
    const handle = t.dataset.drop;
    if (S.fresh.includes(handle)) {
      S.fresh = S.fresh.filter((x) => x !== handle);
      api.unpin(handle);
    }
    S.extra.delete(handle);
    if (!S.extra.size && !S.fresh.length && S.phase === 'fixed') releaseDialog();
    renderAll();
  } else if (t.dataset.preset) {
    submit(t.dataset.preset);
  } else if (t.dataset.qact === 'copy') {
    void api.captureCopy(currentTargetPayload()).then((res) => { if (res?.ok) api.exit(); });
  } else if (t.dataset.qact === 'save') {
    void api.captureSave(currentTargetPayload());
  } else if (t.dataset.qact === 'ocr') {
    api.ocr(currentTargetPayload());
  } else if (t.dataset.scope) {
    changeScope(Number(t.dataset.scope));
  } else if (t.classList.contains('chip') && S.mode === 'pointing') {
    const handle = t.dataset.handle;
    if (S.fresh.includes(handle)) return;
    if (S.extra.has(handle)) S.extra.delete(handle);
    else S.extra.add(handle);
    if (S.extra.size || S.fresh.length) {
      S.phase = 'fixed';
      showDialog(S.anchor ?? S.box ?? { x: S.cursor.x, y: S.cursor.y, w: 1, h: 1, kind: 'window' });
    } else if (S.phase === 'fixed') {
      releaseDialog();
    }
    renderAll();
  }
});

// A click on one of our panels takes the keyboard focus away from the question field. Give it
// back straight away: with an input method, a key typed while nothing editable has the focus
// would arrive as a raw letter instead of starting a composition.
document.addEventListener('click', (e) => {
  if (S.mode === 'pointing' && !String(window.getSelection()) && !e.target?.closest?.('input,textarea,select,summary')) el.q.focus();
});

$('inputmodes').addEventListener('click', (e) => {
  const mode = e.target.closest('[data-input-mode]')?.dataset.inputMode;
  if (mode) setInputMode(mode);
});
el.qsend.addEventListener('click', () => submit());
$('asksettings').addEventListener('click', () => api.openSettings('general'));
$('quickvoice').addEventListener('change', async () => {
  const enabled = $('quickvoice').checked;
  $('quickvoice').disabled = true;
  try {
    const result = await api.voiceToggle(enabled);
    if (result?.error) toast({ text: result.error });
  } catch { toast({ text: '语音设置未保存，请重新启动指点后再试。' }); }
  finally { $('quickvoice').disabled = false; renderVoice(); }
});
$('quickadvanced').addEventListener('toggle', () => {
  if (S.mode === 'pointing') placeAsk(S.anchor ?? S.target ?? { x: S.cursor.x, y: S.cursor.y, w: 1, h: 1 });
});
$('askclose').addEventListener('click', () => api.exit());

el.dclear.addEventListener('click', () => api.clear());
el.bstop.addEventListener('click', () => api.stop());
el.bcopy.addEventListener('click', () => {
  api.copy(S.answer?.text ?? el.btext.textContent);
  toast({ text: '已复制回答' });
});
el.bclose.addEventListener('click', () => {
  el.bubble.hidden = true;
  clearMarks();
  reportIdle();
});
el.sclose.addEventListener('click', () => {
  el.snapshot.hidden = true;
  reportIdle();
});

// ------------------------------------------------------------------ office actions

/** Hide the panel after a while unless the cursor is on it. */
function actTimeout(ms) {
  clearTimeout(S.timers.act);
  if (ms) S.timers.act = setTimeout(() => {
    if (!el.act.hidden && (el.act.matches(':hover') || el.act.contains(document.activeElement))) return actTimeout(4000);
    if (!el.actpill.hidden && el.actpill.matches(':hover')) return actTimeout(2500);
    hideAct(true);
  }, ms);
}

function hideAct(tell = false) {
  clearTimeout(S.timers.act);
  clearTimeout(S.timers.pill);
  if (tell && S.act) api.act.dismiss(S.act.id);
  S.act = null;
  el.act.hidden = true;
  el.actpill.hidden = true;
  el.actparam.hidden = true;
  el.actparam.textContent = '';
  reportIdle();
}

function placeAct(at) {
  if (el.act.dataset.moved) return;
  const w = el.act.offsetWidth || 356, hgt = el.act.offsetHeight || 96;
  const W = S.W || window.innerWidth, H = S.H || window.innerHeight;
  let pos = placeNear({ x: at.x, y: at.y, w: 1, h: 1 }, w, hgt, W, H, 16);
  const occupied = [el.ask, el.bubble, el.snapshot]
    .filter((panel) => !panel.hidden && !panel.classList.contains('quiet'))
    .map((panel) => panel.getBoundingClientRect());
  const fits = (p) => p.x >= 8 && p.y >= 8 && p.x + w <= W - 8 && p.y + hgt <= H - 8
    && occupied.every((r) => p.x + w + 8 <= r.left || p.x >= r.right + 8 || p.y + hgt + 8 <= r.top || p.y >= r.bottom + 8);
  if (!fits(pos)) {
    const candidates = occupied.flatMap((r) => [
      { x: r.right + 14, y: clamp(r.top, 8, H - hgt - 8) },
      { x: r.left - w - 14, y: clamp(r.top, 8, H - hgt - 8) },
      { x: clamp(r.left, 8, W - w - 8), y: r.bottom + 14 },
      { x: clamp(r.left, 8, W - w - 8), y: r.top - hgt - 14 },
    ]).filter(fits);
    candidates.sort((a, b) => Math.hypot(a.x - pos.x, a.y - pos.y) - Math.hypot(b.x - pos.x, b.y - pos.y));
    if (candidates.length) pos = candidates[0];
  }
  el.act.style.left = pos.x + 'px';
  el.act.style.top = pos.y + 'px';
}

function placeActPill(at) {
  const W = S.W || window.innerWidth, H = S.H || window.innerHeight;
  el.actpill.style.left = clamp(at.x + 14, 8, Math.max(8, W - 40)) + 'px';
  el.actpill.style.top = clamp(at.y + 14, 8, Math.max(8, H - 40)) + 'px';
}

function closeActParam() {
  el.actparam.hidden = true;
  el.actparam.textContent = '';
  el.actbtns.hidden = false;
  if (S.act?.at) placeAct(S.act.at);
  reportIdle();
}

function openActParam(offer) {
  const p = offer.param;
  const input = h('input', {
    type: 'text',
    value: p.defaultValue ?? '',
    placeholder: p.placeholder ?? '',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (S.act?.state === 'offer') api.act.run(S.act.id, offer.id, input.value.trim());
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeActParam();
      }
    },
  });
  el.actbtns.hidden = true;
  el.actparam.replaceChildren(
    input,
    h('button', { class: 'main', type: 'button', onclick: () => S.act?.state === 'offer' && api.act.run(S.act.id, offer.id, input.value.trim()) }, p.submitLabel || '确定'),
    h('button', { type: 'button', onclick: closeActParam }, '返回'),
  );
  el.actparam.hidden = false;
  if (S.act?.at) placeAct(S.act.at);
  actTimeout(S.mode === 'pointing' ? 0 : 20000);
  reportIdle();
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function openActPanel(p) {
  delete el.act.dataset.moved;
  S.act = { id: p.id, state: 'offer', offer: p, at: p.at };
  el.actpill.hidden = true;
  el.actwhat.textContent = p.summary;
  el.actwhat.title = p.summary;
  // The four most likely actions show; the rest wait behind "更多".
  // A job for the model that would leave this computer is marked as one, and says where to.
  const out = p.where && p.where !== 'local';
  const leaves = (o) => out && o.usesModel;
  const renderOffer = (o) => {
    const btn = h(
      'button',
      {
        class: leaves(o) ? 'out' : '',
        title: leaves(o) ? `会把选中的内容发送到 ${p.where}，由联网模型处理` : (o.hint ?? ''),
        dataset: { act: o.id },
      },
      leaves(o) ? `${o.label} ↗` : o.label,
    );
    if (o.param?.kind === 'select' && Array.isArray(o.param.options)) {
      const def = o.id === 'text.translate' && p.translateTo ? p.translateTo : o.param.defaultValue;
      const sel = h(
        'select',
        { class: 'actselect', title: '选择目标语言', dataset: { paramFor: o.id }, onchange: () => actTimeout(S.mode === 'pointing' ? 0 : 12000) },
        ...o.param.options.map((opt) => h('option', { value: opt.value, selected: opt.value === def }, opt.label)),
      );
      return h('span', { class: 'actgroup' }, btn, sel);
    }
    return btn;
  };
  const shown = p.offers.length > 5 ? p.offers.slice(0, 4) : p.offers;
  const rest = p.offers.slice(shown.length);
  el.actbtns.replaceChildren(
    ...shown.map(renderOffer),
    ...(rest.length
      ? [
          h('button', { class: 'more', dataset: { actmore: '1' }, title: rest.map((o) => o.label).join('、') }, `更多 ${rest.length}`),
          h('div', { class: 'rest', hidden: true }, ...rest.map(renderOffer)),
        ]
      : []),
  );
  if (p.offers.some(leaves)) el.actbtns.append(h('div', { class: 'outnote' }, `带 ↗ 的会把选中的内容发送到 ${p.where}；其余都在本机完成。`));
  el.actbtns.hidden = false;
  el.actparam.hidden = true;
  el.actparam.textContent = '';
  el.actstatus.hidden = true;
  el.actdone.hidden = true;
  el.actdone.classList.remove('error');
  el.act.hidden = false;
  placeAct(p.at);
  // While pointing the panel stays until it is used or closed; over the live desktop it is a
  // suggestion and takes itself away.
  actTimeout(S.mode === 'pointing' ? 0 : 9000);
  reportIdle();
}

function expandActPill() {
  clearTimeout(S.timers.pill);
  if (S.act?.state === 'pill' && S.act.offer) openActPanel(S.act.offer);
}

function onActOffer(p) {
  clearTimeout(S.timers.pill);
  if (p.compact && S.mode === 'idle') {
    S.act = { id: p.id, state: 'pill', offer: p, at: p.at };
    el.act.hidden = true;
    el.actpill.hidden = false;
    el.actpill.title = `${p.summary} · 移上去查看操作`;
    placeActPill(p.at);
    actTimeout(4500);
    reportIdle();
    return;
  }
  openActPanel(p);
}

function armPillExpand() {
  if (!S.timers.pill) S.timers.pill = setTimeout(expandActPill, 65);
}
el.actpill.addEventListener('pointerenter', () => {
  clearTimeout(S.timers.pill);
  S.timers.pill = setTimeout(expandActPill, 65);
});
el.actpill.addEventListener('pointermove', armPillExpand);
el.actpill.addEventListener('pointerleave', () => {
  clearTimeout(S.timers.pill);
  S.timers.pill = 0;
});
el.actpill.addEventListener('click', expandActPill);

function onActProgress(p) {
  if (!S.act || S.act.id !== p.id) return;
  S.act.state = 'working';
  clearTimeout(S.timers.act);
  el.actpill.hidden = true;
  el.act.hidden = false;
  el.actbtns.hidden = true;
  el.actparam.hidden = true;
  el.actdone.hidden = true;
  el.actstatus.hidden = false;
  el.actmsg.textContent = p.total > 1 && p.done < p.total ? `正在${p.label}（${p.done + 1}/${p.total}）${p.name ? '：' + p.name : ''}` : `正在${p.label}…`;
  reportIdle();
}

function onActDone(p, failed = false) {
  if (!S.act || S.act.id !== p.id) return;
  S.act.state = 'done';
  el.actpill.hidden = true;
  el.act.hidden = false;
  el.actbtns.hidden = true;
  el.actparam.hidden = true;
  el.actstatus.hidden = true;
  el.actdone.classList.toggle('error', failed);
  const nodes = [];
  if (failed) nodes.push(h('div', { class: 'name' }, `没能${p.label || '完成'}`), h('div', { class: 'note' }, p.message));
  else {
    if (p.name) nodes.push(h('div', { class: 'name' }, p.name));
    nodes.push(h('div', { class: p.name ? 'note' : 'lines' }, p.message));
  }
  const buttons = [];
  if (!failed && p.kind === 'file') buttons.push(h('button', { class: 'main', dataset: { actdo: 'open' } }, '打开'), h('button', { dataset: { actdo: 'reveal' } }, '在文件夹中显示'));
  if (!failed && p.kind === 'folder') buttons.push(h('button', { class: 'main', dataset: { actdo: 'open' } }, '打开文件夹'));
  if (!failed && p.canCopy) buttons.push(h('button', { class: 'main', dataset: { actdo: 'copy' } }, '复制'));
  buttons.push(h('button', { dataset: { actdo: 'close' } }, !failed && (p.kind === 'file' || p.kind === 'folder') ? '关闭' : '好的'));
  nodes.push(h('div', { class: 'row' }, ...buttons));
  el.actdone.replaceChildren(...nodes);
  el.actdone.hidden = false;
  if (S.act.at) placeAct(S.act.at);
  actTimeout(S.mode === 'pointing' ? 0 : 30000);
  reportIdle();
}

el.act.addEventListener('click', (e) => {
  const t = e.target.closest?.('[data-act],[data-actdo],[data-actmore]');
  if (!t || !S.act) return;
  if (t.dataset.actmore) {
    // Unfold the rest of the actions in place.
    el.actbtns.querySelector('.rest').hidden = false;
    t.remove();
    if (S.act.at) placeAct(S.act.at);
    actTimeout(S.mode === 'pointing' ? 0 : 15000);
    reportIdle();
  } else if (t.dataset.act && S.act.state === 'offer') {
    const offer = S.act.offer?.offers?.find((o) => o.id === t.dataset.act);
    if (offer?.param?.kind === 'text') {
      openActParam(offer);
      return;
    }
    const sel = el.actbtns.querySelector(`select[data-param-for="${t.dataset.act}"]`);
    api.act.run(S.act.id, t.dataset.act, sel ? sel.value : undefined);
  } else if (t.dataset.actdo === 'copy') {
    api.act.copy(S.act.id);
    t.textContent = '已复制';
  }
  else if (t.dataset.actdo === 'open') api.act.open(S.act.id);
  else if (t.dataset.actdo === 'reveal') api.act.reveal(S.act.id);
  else if (t.dataset.actdo === 'close') hideAct(true);
});
el.actclose.addEventListener('click', () => hideAct(true));

// ------------------------------------------------------------------ messages from the main process

api.on('mode', (p) => (p.mode === 'pointing' ? enterPointing(p) : enterIdle()));
api.on('referents', (refs) => {
  S.refs = refs;
  S.fresh = S.fresh.filter(refOf);
  for (const x of [...S.extra]) if (!refOf(x)) S.extra.delete(x);
  if (!S.fresh.length && !S.extra.size && S.phase === 'fixed') releaseDialog();
  renderAll();
});
api.on('config', (c) => {
  S.config = c;
  if (voiceActive() && !c.voice?.available) cancelVoice();
  renderHud();
  renderSendList();
  renderContext();
  renderVoice();
});
api.on('voice:cancelled', ({ id }) => {
  if (voiceActive() && id === voice.currentId) cancelVoice();
});
api.on('context', (context) => {
  S.context = context;
  S.contextRequest++;
  S.contextBusy = false;
  S.contextStopping = false;
  S.contextResult = null;
  S.contextParam = null;
  if (contextHasSelection()) S.inputMode = 'context';
  renderContext();
  renderHud();
  if (S.mode === 'pointing' && S.inputMode === 'context') showDialog(S.box ?? { x: S.cursor.x, y: S.cursor.y, w: 1, h: 1 });
});
api.on('context:plan', (result) => {
  if (!result?.ok || !result.plan || S.mode !== 'pointing') return;
  S.contextRequest++;
  S.contextBusy = false;
  S.contextStopping = false;
  S.contextResult = { kind: 'success', plan: result.plan };
  setInputMode('context');
});
api.on('display', (d) => {
  S.W = d.w;
  S.H = d.h;
  S.displayId = d.id;
});
api.on('blank', async (p) => {
  document.body.classList.toggle('blank', Boolean(p.on));
  if (p.rpc) {
    await nextFrame();
    await nextFrame();
    setTimeout(() => api.rpcDone(p.rpc, true), 30);
  }
});
api.on('toast', toast);
api.on('mark', onMark);
api.on('thread:reset', forgetAnswer);
api.on('act:offer', onActOffer);
api.on('act:progress', onActProgress);
api.on('act:done', (p) => onActDone(p));
api.on('act:error', (p) => onActDone(p, true));
api.on('act:hide', () => hideAct());
api.on('idle:hover', ({ x, y }) => {
  if (S.mode === 'idle' && S.act?.state === 'pill' && !el.actpill.hidden) {
    const r = el.actpill.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      clearTimeout(S.timers.pill);
      S.timers.pill = setTimeout(expandActPill, 65);
    }
  }
});
api.on('answer:start', onAnswerStart);
api.on('answer:first', (p) => {
  if (S.answer?.id === p.id) S.answer.firstMs = p.ms;
});
api.on('answer:text', (p) => {
  if (S.answer?.id !== p.id) return;
  S.answer.text += p.text;
  S.answer.streamText += p.text;
  appendAnswerText(p.text);
});
api.on('answer:status', (p) => {
  if (S.answer?.id !== p.id) return;
  el.bstatus.hidden = !p.text;
  el.bstatus.textContent = p.text;
  fitBubble();
});
api.on('answer:done', onAnswerDone);
api.on('answer:error', onAnswerError);

// Heartbeat for the main-process watchdog, and an automatic exit if the person walked away
// while the overlay was holding their screen.
setInterval(() => {
  if (S.mode !== 'pointing') return;
  api.beat();
  if (Date.now() - S.lastInput > 150000 && (!S.answer || S.answer.done)) api.exit();
}, 1000);

// Test hook: lets the end-to-end test read the UI state without scraping pixels.
window.__overlay = { S, el, expandActPill, voice };
