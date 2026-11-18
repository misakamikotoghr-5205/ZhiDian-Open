// Compact settings with persistent model downloads inside advanced settings.
const api = window.zhidian.settings;
const $ = (id) => document.getElementById(id);
let view = null;
let chosen = '';
let installing = false;
let installPending = false; // the request from this window has not settled yet
let directoryDraft = null; // null follows the saved path; a draft survives unrelated updates
let directoryBusy = false;
let directoryMessage = '';
let directoryError = false;
let discoveredCloud = [];
let discoveredLocal = [];
let cloudEndpoint = '';
let localEndpoint = '';
let voiceEndpoint = '';
let voiceQueue = Promise.resolve();
let voiceSecretBusy = false;
let voiceRevision = 0;
const voicePending = new Map();
let deleteProfileId = '';
let deleteProfileTimer = 0;
const LOCAL_PRESETS = { ollama: 'http://127.0.0.1:11434/v1', lmstudio: 'http://127.0.0.1:1234/v1' };

const visionLabel = (vision) => vision === true ? '支持图片' : vision === false ? '仅文字' : '能力未知';
function modelOptions(select, models, selected, empty) {
  select.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: empty }), ...models.map((m) => Object.assign(document.createElement('option'), { value: m.id, textContent: `${m.label || m.id} · ${visionLabel(m.vision)}` })));
  select.value = models.some((m) => m.id === selected) ? selected : '';
}

const gb = (bytes) => (bytes / 1e9).toFixed(2) + ' GB';
const pill = (node, text, cls) => {
  node.textContent = text;
  node.className = 'pill ' + (cls ?? '');
};

function render(v) {
  view = v;
  const st = v.local.status;
  installing = installPending || Boolean(st.installing);
  if (st.installing?.modelId) chosen = st.installing.modelId;
  renderProgress(st.installing);
  $('ver').textContent = 'v' + v.version + (v.rehearse ? ' · 排练模式' : '');

  // ---- local model
  const external = v.local.mode === 'external';
  if (!st.models.some((m) => m.id === chosen)) chosen = st.configuredModel || st.activeModel || st.recommended;
  const recommended = st.models.find((m) => m.id === st.recommended);
  $('modelchoice').value = st.configuredModel || '';
  $('modelchoice').disabled = external || installing || directoryBusy || directoryChanged(v);
  $('modelselection').textContent = external ? '当前使用外部模型服务。' : st.selectionReason || '根据电脑资源自动选择模型。';
  $('loadedmodelpath').textContent = !external && st.modelPath ? `当前模型文件：${st.modelPath}` : '';
  $('basicstatus').textContent = external ? '正在使用已连接的模型服务。' : st.runtimeInstalled && st.activeModel
    ? `${st.server.state === 'ready' ? '已就绪' : st.server.state === 'starting' ? '加载中' : '模型文件已就绪'} · ${st.selectionMode === 'manual' ? '手动指定' : '自动选择'} ${st.models.find((m) => m.id === st.activeModel)?.label || '本地模型'}`
    : st.selectionMode === 'manual' && !st.activeModel ? st.selectionReason
    : `基础文件工具可直接使用。${recommended ? `当前推荐 ${recommended.label}。` : ''}需要模型时，请到高级设置 → 本地模型 → 下载模型。`;
  const serverText = { ready: '已就绪', starting: '加载中…', error: '启动失败', stopped: '未启动' }[st.server.state];
  if (external) pill($('lstate'), '使用外部本地服务', 'ok');
  else if (!st.activeModel || !st.runtimeInstalled) pill($('lstate'), '尚未安装', 'warn');
  else pill($('lstate'), `${st.models.find((m) => m.id === st.activeModel).label} · ${serverText} · ${st.accel}`, st.server.state === 'error' ? 'bad' : st.server.state === 'ready' ? 'ok' : '');

  $('downloadmodel').replaceChildren(...st.models.map(m => Object.assign(document.createElement('option'), {
    value: m.id, textContent: `${m.label} · ${gb(m.bytes)}${m.installed ? ' · 文件已齐全' : ''}`,
  })));
  $('downloadmodel').value = chosen;
  const src = $('source');
  if (!src.childElementCount) {
    for (const s of st.sources) src.append(Object.assign(document.createElement('option'), { value: s.id, textContent: s.label }));
    src.value = v.local.source;
  }
  renderLocalDirectory(v);
  renderInstallButton(v);
  $('cancel').hidden = !installing;
  if (st.server.state === 'error' && !installing) showError(st.server.error);
  $('external').checked = external;
  $('localpreset').value = v.local.externalPreset || 'custom';
  $('extvision').value = v.local.externalVision || 'auto';
  if (localEndpoint !== v.local.externalUrl) {
    localEndpoint = v.local.externalUrl;
    discoveredLocal = [];
  }
  modelOptions($('extmodels'), discoveredLocal, v.local.externalModel, '读取列表后选择，或手动填写模型名');
  if (document.activeElement !== $('exturl')) $('exturl').value = v.local.externalUrl;
  if (document.activeElement !== $('extmodel')) $('extmodel').value = v.local.externalModel;
  if (document.activeElement !== $('ghmirror')) $('ghmirror').value = v.local.ghMirror;
  $('ldir').textContent = `内置运行时：llama.cpp ${st.runtimeTag}。安装位置见上方“模型与运行时目录”。`;
  $('adapter').textContent = external
    ? (v.local.externalVision === 'text' ? '当前使用纯文字模型，可处理文字上下文；截图问答需要切换到视觉模型。' : '当前使用已有的本地服务，无需下载上方内置模型。')
    : st.adapter ? '已加载指针适配器：回答和定位一趟完成。' : '未找到指针适配器，回答和定位分两趟进行（功能相同，慢一些）。';

  renderCloud(v.cloud);
  renderVoice(v.voice);

  // ---- hotkeys
  if (document.activeElement !== $('hk1')) $('hk1').value = v.hotkeys.point;
  if (document.activeElement !== $('hk2')) $('hk2').value = v.hotkeys.pointAlt;
  const hk = (node, accel) => {
    if (!accel) return pill(node, '未设置', '');
    const detail = v.hotkeyDetail?.[accel];
    if (detail === 'invalid') return pill(node, '格式无效', 'bad');
    const ok = Boolean(v.hotkeyStatus[accel]);
    pill(node, ok ? '已生效' : '被占用', ok ? 'ok' : 'bad');
  };
  hk($('hk1s'), v.hotkeys.point);
  hk($('hk2s'), v.hotkeys.pointAlt);

  // ---- permission (macOS only)
  $('sec-permission').hidden = v.platform !== 'darwin';
  pill($('perm'), v.permission === 'granted' ? '已授权' : '未授权', v.permission === 'granted' ? 'ok' : 'warn');

  // ---- options and MCP
  $('pointback').checked = v.pointBack;
  $('naturalwheel').checked = Boolean(v.naturalWheel);
  $('wiggle').checked = v.wiggle;
  $('launchlogin').checked = Boolean(v.launchAtLogin);
  $('ambient').checked = v.actions.ambient;
  $('compact').checked = v.actions.compact !== false;
  $('compact').disabled = !v.actions.ambient;
  if (document.activeElement !== $('ignoredapps')) $('ignoredapps').value = v.actions.ignoredApps ?? '';
  $('translateto').value = v.actions.translateTo ?? 'auto';
  const w = v.actions.watcher;
  const how = v.platform === 'win32' ? '在资源管理器里选中文件，或在支持的应用里选中文字' : v.platform === 'darwin' ? '在访达里选中文件，或在应用里选中文字（第一次使用时系统会询问权限）' : '选中文字即可；文件可直接拖入下方虚线框，或点「选择文件」';
  $('ambientnote').textContent = !v.actions.ambient ? '' : w?.status === 'failed' ? `没能启动选区监听：${w.error}` : `${how}。${v.actions.office ? '本机装有 LibreOffice，Word 转 PDF 会保持原版式，也能读 doc、xlsx、pptx。' : '全部在本机完成。'}`;
  pill($('mcpstate'), v.mcpRunning ? `运行中 · 端口 ${v.mcpPort}` : v.mcpError ? '未启动' : '已关闭', v.mcpRunning ? 'ok' : 'warn');
  $('cmd1').textContent = v.commands.claudeCode;
  $('cmd2').textContent = v.commands.claudeDesktop;
  const templates = v.actions.templates ?? [];
  $('doctemplate').replaceChildren(...templates.map((t) => Object.assign(document.createElement('option'), { value: t.id, textContent: t.label })));
  $('doctemplate').value = v.actions.template || 'business';
  $('templatenote').textContent = templates.find((t) => t.id === $('doctemplate').value)?.description || '用于支持样式的文档转换和演示导出。';
  renderMcp(v);
}

function directoryChanged(v = view) {
  if (directoryDraft === null || !v || v.local.directoryLocked) return false;
  const draft = directoryDraft.trim();
  return draft !== v.local.status.dir && !(draft === '' && !v.local.directory);
}

const directoryRestartMessage = '目录设置功能已更新，请在任务栏托盘选择“退出指点”，再重新打开软件；只关闭设置窗口不会完成重启。';
const directoryNeedsRestart = (v = view) => typeof v?.local?.directory !== 'string';
function directoryFailure(error) {
  const message = error?.message || String(error);
  return /No handler registered for ['"]c:local:(pickDir|setDir)['"]/.test(message) ? directoryRestartMessage : message;
}

function renderInstallButton(v = view) {
  const st = v.local.status;
  const picked = st.models.find((m) => m.id === chosen);
  const done = picked?.installed && st.runtimeInstalled;
  const locked = installing || directoryBusy || directoryChanged(v);
  const btn = $('install');
  btn.disabled = locked || done || !picked;
  btn.title = directoryChanged(v) ? '请先保存下载目录。' : done ? '已找到完整模型和运行时，无需重复下载。' : '';
  btn.textContent = installing ? '正在下载…' : done ? '已安装，无需下载' : picked?.installed ? '下载并安装运行时' : '下载并安装';
  $('downloadmodel').disabled = locked;
  $('source').disabled = locked;
  $('modelchoice').disabled = locked || v.local.mode === 'external';
  $('downloadnote').textContent = directoryChanged(v) ? '请先保存上方目录，再开始下载。'
    : done ? '模型和运行时已齐全，无需重复下载。要切换模型，请使用上方“使用模型”。'
    : `模型文件下载到：${st.modelDir || st.dir}。缺失的运行时也会安装到上方目录；完成后仍按“使用模型”设置加载。`;
}

function renderLocalDirectory(v = view) {
  const restart = directoryNeedsRestart(v);
  const locked = restart || Boolean(v.local.directoryLocked);
  const busy = installing || directoryBusy;
  const input = $('localdir');
  if (directoryDraft === null || locked) input.value = v.local.status.dir;
  else if (input.value !== directoryDraft) input.value = directoryDraft;
  input.disabled = locked || busy;
  input.setAttribute('aria-invalid', directoryError ? 'true' : 'false');
  $('choosedir').disabled = locked || busy;
  $('savedir').disabled = locked || busy || !directoryChanged(v);
  $('savedir').textContent = directoryBusy ? '正在处理…' : '保存目录';
  $('resetdir').disabled = locked || busy || (!v.local.directory && directoryDraft === null);
  $('opendir').disabled = busy;
  $('localdireffective').textContent = `当前生效目录：${v.local.status.dir}`;
  const message = restart ? directoryRestartMessage : locked ? '安装目录由启动环境指定，当前无法在设置中修改。'
    : directoryMessage || (directoryChanged(v) ? '目录尚未保存，请先点击“保存目录”，再下载或切换模型。' : '');
  $('localdirout').textContent = message;
  $('localdirout').hidden = !message;
  $('localdirout').className = directoryError && !locked ? 'note error' : 'note';
}

async function saveLocalDirectory(directory) {
  if (installing || directoryBusy || view.local.directoryLocked || directoryNeedsRestart()) return;
  directoryBusy = true;
  directoryError = false;
  directoryMessage = '';
  render(view);
  try {
    const result = await api.setLocalDir(directory);
    if (!result?.ok) throw new Error(result?.error || '目录未保存，请重试。');
    directoryDraft = null;
    directoryMessage = '目录已保存，后续下载与模型加载将使用当前目录。';
    render(result.view || await api.get());
  } catch (err) {
    directoryError = true;
    directoryMessage = directoryFailure(err);
  } finally {
    directoryBusy = false;
    render(view);
  }
}

// ---- the optional network model
function renderCloud(c) {
  const presets = c.presets ?? [];
  $('cpreset').replaceChildren(...presets.map((p) => Object.assign(document.createElement('option'), { value: p.id, textContent: p.label })));
  $('cpreset').value = c.presetId || (c.provider === 'anthropic' ? 'anthropic' : 'custom');
  $('cvision').value = c.vision || 'auto';
  const endpoint = `${c.provider}:${c.baseUrl}`;
  if (cloudEndpoint !== endpoint) { cloudEndpoint = endpoint; discoveredCloud = []; }
  modelOptions($('cmodelselect'), discoveredCloud, c.model, '读取列表后选择，或在上方手动输入');
  renderProfiles(c);
  const sel = $('cprovider');
  if (!sel.childElementCount) for (const p of c.providers) sel.append(Object.assign(document.createElement('option'), { value: p.id, textContent: p.label }));
  sel.value = c.provider;
  const preset = c.providers.find((p) => p.id === c.provider);
  const servicePreset = presets.find((p) => p.id === c.presetId && p.provider === c.provider);
  const claude = c.provider === 'anthropic';
  $('cmodels').replaceChildren(...(servicePreset?.models ?? preset.models).map((m) => Object.assign(document.createElement('option'), { value: m })));
  if (document.activeElement !== $('cmodel')) $('cmodel').value = c.model;
  $('cmodel').placeholder = preset.model ? `留空即 ${preset.model}` : '服务商文档里能看图的模型名';
  if (document.activeElement !== $('curl')) $('curl').value = c.baseUrl;
  $('curl').placeholder = claude ? '留空即 https://api.anthropic.com' : '例如 https://服务商的域名/v1';
  $('curlnote').textContent = claude
    ? 'Anthropic 协议；官方地址可留空。使用公司网关时填写其 API 根地址。'
    : '预设地址和模型可修改。地址应以 /v1 等 API 路径结尾，不含 /chat/completions；以服务商账户实际可用模型为准。';
  $('ceffortbox').hidden = !claude;
  $('ceffort').value = c.effort;
  $('ckey').placeholder = c.hasKey ? `已保存（尾号 ${c.keyHint || '····'}），要换就在这里填新的` : '只保存在这台电脑上';
  $('ckdel').hidden = !c.hasKey && !c.keyLost;
  $('ckeynote').textContent = c.keyLost
    ? '之前保存的密钥在这台电脑上读不出来了（系统钥匙串变了），请重新填写。'
    : c.hasKey
      ? `密钥只用于 ${c.host}，换了服务地址就要重新填。` + (c.protection === 'keychain' ? '已用系统钥匙串加密保存。' : '这台电脑没有可用的系统钥匙串：密钥保存在只有你能读的设置文件里，没有加密。')
      : c.problem && c.baseUrl ? c.problem : '';
  $('cenabled').checked = c.enabled;
  $('cenabled').disabled = !c.configured;
  $('cdefault').checked = c.byDefault;
  $('cdefault').disabled = !c.enabled;
  $('cweb').checked = c.webSearch;
  $('cweb').disabled = !c.webSearchPossible;
  pill($('cstate'), !c.configured ? '未设置' : !c.enabled ? '已设置 · 关闭' : c.byDefault ? `默认使用 · ${c.label}` : `需要时使用 · ${c.label}`, c.enabled ? 'warn' : '');
}

// Speech has its own service and credential; a chat connection is never reused here.
function renderVoice(c = {}) {
  c ||= {};
  const draft = { ...c, ...Object.fromEntries([...voicePending].map(([key, pending]) => [key, pending.value])) };
  const presets = c.presets ?? [];
  $('vpreset').replaceChildren(...presets.map((p) => Object.assign(document.createElement('option'), { value: p.id, textContent: p.label })));
  $('vpreset').value = draft.preset || 'openai';
  for (const [id, name] of [['vurl', 'baseUrl'], ['vmodel', 'model'], ['vlanguage', 'language']]) {
    if (document.activeElement !== $(id)) $(id).value = draft[name] ?? '';
  }
  if (voiceEndpoint !== draft.baseUrl) {
    voiceEndpoint = draft.baseUrl ?? '';
    $('vkey').value = '';
  }
  const supported = typeof window.zhidian.voiceUpdate === 'function';
  $('venabled').checked = Boolean(draft.enabled);
  $('venabled').disabled = !supported;
  $('basicvoicehint').textContent = c.configured ? c.enabled ? '已启用，输入框旁会显示麦克风。' : '' : '首次使用请在高级设置中连接语音识别服务。';
  $('vpreset').disabled = !supported;
  $('vkey').placeholder = c.hasKey ? `已保存（尾号 ${c.keyHint || '····'}），填写新密钥可替换` : c.local ? '本机服务不需要认证时可留空' : '填写这个语音服务的 API key';
  $('vkeydelete').hidden = !c.hasKey;
  renderVoiceKeyButtons();
  $('vkeynote').textContent = c.hasKey
    ? `语音密钥只用于 ${c.host}，切换到其他服务地址后需重新填写。` + (c.protection === 'keychain' ? '已用系统钥匙串加密保存。' : '这台电脑没有可用的系统钥匙串：密钥保存在只有你能读的设置文件里，没有加密。')
    : '与聊天模型的密钥分开保存，不会自动使用“API 连接”里的密钥。';
  $('vproblem').textContent = c.problem || '';
  $('vproblem').hidden = !c.problem;
  pill($('vstate'), !c.configured ? '配置待完善' : c.enabled ? '已启用' : '已设置 · 关闭', c.enabled ? 'ok' : c.problem ? 'warn' : '');
  $('vwherehost').textContent = c.host ? `${c.local ? '本机服务' : '云端服务'} · ${c.host}` : '请先填写服务地址';
  $('vwherehint').textContent = c.host
    ? c.local
      ? '结束录音后，音频交给这个本机语音识别服务处理。转写文字先进入输入框，由你确认后发送。'
      : '结束录音后，音频会上传到这个服务进行识别。转写文字先进入输入框，由你确认后发送。'
    : '选择服务后，这里会显示音频的处理位置。';
  $('vlimit').textContent = `每次最多录制 ${c.maxDurationSeconds || 60} 秒，到时自动停止并识别。首次录音时，请允许系统访问麦克风；按 Esc 可以取消。`;
}

function renderVoiceKeyButtons() {
  $('vkeysave').disabled = voiceSecretBusy || !$('vkey').value.trim() || typeof window.zhidian.voiceUpdate !== 'function';
  $('vkeydelete').disabled = voiceSecretBusy;
}

function updateVoice(patch, success = '') {
  const revision = ++voiceRevision;
  for (const [name, value] of Object.entries(patch)) {
    if (name !== 'key') voicePending.set(name, { value, revision });
  }
  // Keep quick edits ordered, including an address change immediately followed by key save.
  voiceQueue = voiceQueue.then(async () => {
    let res;
    try { res = await window.zhidian.voiceUpdate(patch); }
    catch { res = { error: '语音设置未能保存，请重试。' }; }
    for (const name of Object.keys(patch)) {
      if (voicePending.get(name)?.revision === revision) voicePending.delete(name);
    }
    if (res?.view) render(res.view);
    $('vout').textContent = res?.error || success;
  });
  return voiceQueue;
}

function renderProfiles(c) {
  const profiles = c.profiles ?? [];
  const active = profiles.find((p) => p.id === c.activeProfileId);
  $('ceditname').textContent = active ? `编辑 · ${active.name}` : '当前连接';
  $('profilelist').replaceChildren(...profiles.map((p) => {
    const card = Object.assign(document.createElement('div'), { className: 'profile-card' + (p.id === c.activeProfileId ? ' active' : '') });
    const name = Object.assign(document.createElement('div'), { className: 'profile-name', textContent: p.name });
    if (p.id === c.activeProfileId) name.append(Object.assign(document.createElement('span'), { className: 'pill', textContent: '当前' }));
    const meta = Object.assign(document.createElement('div'), { className: 'profile-meta', textContent: `${p.model || '尚未选择模型'} · ${p.hasKey ? '密钥已保存' : '未保存密钥'}` });
    const actions = Object.assign(document.createElement('div'), { className: 'profile-actions' });
    const use = Object.assign(document.createElement('button'), { type: 'button', textContent: '切换', disabled: p.id === c.activeProfileId });
    use.addEventListener('click', () => profileAction('select', { id: p.id }));
    const rename = Object.assign(document.createElement('button'), { type: 'button', textContent: '重命名' });
    rename.addEventListener('click', () => {
      const input = Object.assign(document.createElement('input'), { type: 'text', value: p.name, maxLength: 60, ariaLabel: '连接名称' });
      const save = Object.assign(document.createElement('button'), { type: 'button', textContent: '保存名称' });
      const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: '取消' });
      const commit = () => profileAction('rename', { id: p.id, name: input.value.trim() });
      save.addEventListener('click', commit);
      cancel.addEventListener('click', () => renderProfiles(view.cloud));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') renderProfiles(view.cloud); });
      name.replaceChildren(input); actions.replaceChildren(save, cancel); input.focus(); input.select();
    });
    const del = Object.assign(document.createElement('button'), { type: 'button', className: 'danger-sm', textContent: deleteProfileId === p.id ? '确认删除' : '删除' });
    del.addEventListener('click', () => {
      if (deleteProfileId === p.id) { deleteProfileId = ''; return profileAction('delete', { id: p.id }); }
      deleteProfileId = p.id; renderProfiles(c); clearTimeout(deleteProfileTimer);
      deleteProfileTimer = setTimeout(() => { deleteProfileId = ''; if (view) renderProfiles(view.cloud); }, 4000);
    });
    actions.append(use, rename, del); card.append(name, meta, actions); return card;
  }));
  if (!profiles.length) $('profilelist').append(Object.assign(document.createElement('p'), { className: 'note', textContent: '还没有保存连接。新建一个连接，或将当前设置另存为连接。' }));
}

async function profileAction(action, payload = {}) {
  try {
    const res = await api.cloud.profile(action, payload);
    $('cout').textContent = res.error || '';
    if (res.view) render(res.view);
  } catch (err) { $('cout').textContent = err?.message ?? String(err); }
}

function renderMcp(v) {
  const clients = v.mcpClients ?? [];
  const selected = $('mcpclient').value || 'cursor';
  $('mcpclient').replaceChildren(...clients.map((client) => Object.assign(document.createElement('option'), { value: client.id, textContent: client.label })));
  $('mcpclient').value = clients.some((c) => c.id === selected) ? selected : (clients[0]?.id || '');
  const client = clients.find((c) => c.id === $('mcpclient').value);
  $('mcphelp').textContent = client?.description || '';
  $('mcpconfig').textContent = client ? JSON.stringify(client.config, null, 2) : '';
}

async function updateCloud(patch) {
  const res = await window.zhidian.settings.cloud.update(patch);
  $('cout').textContent = res.error ?? '';
  render(res.view);
}

function showError(text) {
  $('lerror').hidden = !text;
  $('lerror').textContent = text ?? '';
}

function renderProgress(p) {
  const box = $('progress');
  box.hidden = !p;
  if (!p) return;
  box.replaceChildren(
    ...p.steps.map((s) => {
      const pct = s.total ? Math.min(100, (s.received / s.total) * 100) : 0;
      const row = document.createElement('div');
      row.className = 'bar';
      const state = s.key === p.current && p.phase === 'unpack' ? '解压中…' : s.total ? `${gb(s.received)} / ${gb(s.total)}` : '等待中';
      row.textContent = `${s.label}　${state}`;
      const bar = document.createElement('i');
      bar.style.setProperty('--p', pct.toFixed(1) + '%');
      row.append(bar);
      return row;
    }),
  );
}

async function update(patch) {
  render(await api.update(patch));
}

// ---- interactive hotkey recorder
const CODE_KEY = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space',
  Tab: 'Tab', Enter: 'Return', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete',
};

function eventToAccelerator(e) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(e.key)) return null;
  let key = '';
  if (/^Key([A-Z])$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit([0-9])$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key;
  else if (CODE_KEY[e.code]) key = CODE_KEY[e.code];
  else if (e.key && e.key.length === 1 && e.key !== ' ') key = e.key.toUpperCase();
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push(view?.platform === 'darwin' ? 'Command' : 'Super');
  // Require a modifier unless it is a function key (F1–F24), so normal typing never hijacks a letter key.
  if (!mods.length && !/^F\d+$/.test(key)) return null;
  return [...mods, key].join('+');
}

function wireHotkeyRecorder(input, field) {
  let prev = '';
  input.addEventListener('focus', () => {
    prev = input.value;
    input.classList.add('recording');
    input.placeholder = '请按下组合键（Backspace 清空，Esc 取消）';
    input.select();
  });
  input.addEventListener('blur', () => {
    input.classList.remove('recording');
    input.placeholder = '';
    if (view) input.value = view.hotkeys[field] ?? prev;
  });
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      input.value = prev;
      input.blur();
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      input.value = '';
      await update({ hotkeys: { [field]: '' } });
      input.blur();
      return;
    }
    const accel = eventToAccelerator(e);
    if (!accel) return;
    e.preventDefault();
    input.value = accel;
    await update({ hotkeys: { [field]: accel } });
    input.blur();
  });
}
wireHotkeyRecorder($('hk1'), 'point');
wireHotkeyRecorder($('hk2'), 'pointAlt');

$('modelchoice').addEventListener('change', async () => {
  const modelId = $('modelchoice').value;
  $('modelchoice').disabled = true;
  try { await update({ local: { modelId, mode: 'managed' } }); }
  catch (err) { showError(err?.message ?? String(err)); render(await api.get()); }
});

$('downloadmodel').addEventListener('change', () => {
  chosen = $('downloadmodel').value;
  showError('');
  renderInstallButton();
});

$('install').addEventListener('click', async () => {
  if (installing || directoryBusy || directoryChanged()) return;
  const st = view.local.status;
  const picked = st.models.find((m) => m.id === chosen);
  if (!picked || (picked.installed && st.runtimeInstalled)) return;
  const modelId = chosen;
  const source = $('source').value;
  showError('');
  installPending = true;
  render(view);
  try {
    const res = await api.install({ modelId, source });
    if (!res.ok && res.kind !== 'aborted') showError(res.error);
  } catch (err) {
    showError(err?.message ?? String(err));
  } finally {
    installPending = false;
    render(await api.get());
  }
});
$('cancel').addEventListener('click', () => api.cancelInstall());
$('opendir').addEventListener('click', () => api.openLocalDir());
$('localdir').addEventListener('input', () => {
  directoryDraft = $('localdir').value;
  directoryError = false;
  directoryMessage = '';
  renderLocalDirectory();
  renderInstallButton();
});
$('localdir').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (directoryChanged()) void saveLocalDirectory($('localdir').value.trim()); }
  if (e.key === 'Escape') {
    e.preventDefault();
    directoryDraft = null;
    directoryError = false;
    directoryMessage = '';
    render(view);
  }
});
$('savedir').addEventListener('click', () => saveLocalDirectory($('localdir').value.trim()));
$('resetdir').addEventListener('click', () => saveLocalDirectory(''));
$('choosedir').addEventListener('click', async () => {
  if (installing || directoryBusy || view.local.directoryLocked || directoryNeedsRestart()) return;
  directoryBusy = true;
  directoryError = false;
  directoryMessage = '';
  render(view);
  try {
    const result = await api.pickLocalDir();
    if (result?.canceled) return;
    if (!result?.ok) throw new Error(result?.error || '无法选择目录，请重试。');
    if (result.path) directoryDraft = result.path;
  } catch (err) {
    directoryError = true;
    directoryMessage = directoryFailure(err);
  } finally {
    directoryBusy = false;
    render(view);
  }
});
$('source').addEventListener('change', () => update({ local: { source: $('source').value } }));
$('external').addEventListener('change', () => update({ local: { mode: $('external').checked ? 'external' : 'managed', externalUrl: $('exturl').value.trim(), externalModel: $('extmodel').value.trim() } }));
$('localpreset').addEventListener('change', async () => {
  const preset = $('localpreset').value;
  await update({ local: { externalPreset: preset, ...(LOCAL_PRESETS[preset] ? { externalUrl: LOCAL_PRESETS[preset] } : {}), externalModel: '', externalVision: 'auto' } });
  $('probeout').textContent = '启动本地服务后，点击“读取模型列表”选择已安装的模型。';
});
$('extvision').addEventListener('change', () => update({ local: { externalVision: $('extvision').value } }));
$('extmodels').addEventListener('change', () => {
  const m = discoveredLocal.find((m) => m.id === $('extmodels').value);
  if (m) void update({ local: { externalModel: m.id, externalVision: m.vision === true ? 'vision' : m.vision === false ? 'text' : 'auto' } });
});
for (const id of ['exturl', 'extmodel', 'ghmirror']) {
  $(id).addEventListener('change', () => update({ local: { externalUrl: $('exturl').value.trim(), externalModel: $('extmodel').value.trim(), ghMirror: $('ghmirror').value.trim(), ...(id !== 'ghmirror' ? { externalVision: 'auto' } : {}) } }));
}
$('probe').addEventListener('click', async () => {
  const endpoint = $('exturl').value.trim();
  $('probeout').textContent = '正在读取模型…';
  $('probe').disabled = true;
  try {
    const r = await api.probe(endpoint);
    if ($('exturl').value.trim() !== endpoint) return;
    discoveredLocal = r.details ?? (r.models ?? []).map((id) => ({ id, vision: null }));
    modelOptions($('extmodels'), discoveredLocal, view.local.externalModel, r.ok ? '选择一个已安装的模型' : '未读取到模型');
    $('probeout').textContent = r.ok ? `已连接，找到 ${discoveredLocal.length} 个模型。${discoveredLocal.length ? '从上方列表选择，也可手动填写名称。' : '请先在本地服务中下载或加载模型。'}` : `连不上：${r.error}`;
  } catch (err) { $('probeout').textContent = err?.message ?? String(err); }
  finally { $('probe').disabled = false; }
});
$('cpreset').addEventListener('change', () => {
  const p = view.cloud.presets?.find((p) => p.id === $('cpreset').value);
  if (p) void updateCloud({ provider: p.provider, presetId: p.id, model: p.model, baseUrl: p.baseUrl, vision: p.vision, webSearch: false });
});
$('cprovider').addEventListener('change', () => updateCloud({ provider: $('cprovider').value, presetId: $('cprovider').value === 'anthropic' ? 'anthropic' : 'custom', model: '', baseUrl: '', vision: 'auto' }));
$('cvision').addEventListener('change', () => updateCloud({ vision: $('cvision').value }));
$('cnew').addEventListener('click', () => profileAction('new'));
$('cprofilesave').addEventListener('click', async () => {
  const name = $('cprofilename').value.trim();
  if (!name) { $('cout').textContent = '先给这个连接起个名字。'; $('cprofilename').focus(); return; }
  await profileAction('save', { name });
  $('cprofilename').value = '';
});
$('cmodelselect').addEventListener('change', () => {
  const m = discoveredCloud.find((m) => m.id === $('cmodelselect').value);
  if (m) void updateCloud({ model: m.id, vision: m.vision === true ? 'vision' : m.vision === false ? 'text' : 'auto' });
});
$('cdiscover').addEventListener('click', async () => {
  const endpoint = cloudEndpoint;
  $('cdiscover').disabled = true;
  $('cout').textContent = '正在读取服务中的模型…';
  try {
    const r = await api.cloud.models();
    if (endpoint !== cloudEndpoint) return;
    discoveredCloud = r.models ?? [];
    modelOptions($('cmodelselect'), discoveredCloud, view.cloud.model, r.ok ? '选择可用模型' : '可以手动填写模型名');
    $('cout').textContent = r.ok ? `找到 ${discoveredCloud.length} 个模型。图片能力未知时，请根据服务商说明选择。` : r.error || '无法读取模型列表，可以手动填写模型名。';
  } catch (err) { $('cout').textContent = err?.message ?? String(err); }
  finally { $('cdiscover').disabled = false; }
});
$('cmodel').addEventListener('change', () => updateCloud({ model: $('cmodel').value, vision: 'auto' }));
$('curl').addEventListener('change', () => updateCloud({ baseUrl: $('curl').value }));
$('ceffort').addEventListener('change', () => updateCloud({ effort: $('ceffort').value }));
$('cksave').addEventListener('click', async () => {
  const key = $('ckey').value.trim();
  if (!key) return;
  // The address and the model typed so far go along, so the key is saved for the right host.
  await updateCloud({ model: $('cmodel').value, baseUrl: $('curl').value, key });
  $('ckey').value = '';
});
$('ckdel').addEventListener('click', () => updateCloud({ key: null }));
$('ctest').addEventListener('click', async () => {
  $('cout').textContent = '正在连接…';
  const r = await window.zhidian.settings.cloud.test();
  $('cout').textContent = (r.ok ? '✓ ' : '✗ ') + r.message;
});
$('cenabled').addEventListener('change', () => updateCloud({ enabled: $('cenabled').checked, ...($('cenabled').checked ? {} : { byDefault: false }) }));
$('cdefault').addEventListener('change', () => updateCloud({ byDefault: $('cdefault').checked }));
$('cweb').addEventListener('change', () => updateCloud({ webSearch: $('cweb').checked }));

$('vpreset').addEventListener('change', () => {
  const preset = view.voice?.presets?.find((p) => p.id === $('vpreset').value);
  if (!preset) return;
  $('vkey').value = '';
  renderVoiceKeyButtons();
  const patch = { preset: preset.id };
  if (preset.id !== 'custom') {
    patch.baseUrl = $('vurl').value = preset.baseUrl;
    patch.model = $('vmodel').value = preset.model;
    voiceEndpoint = preset.baseUrl;
  }
  if (preset.id === 'local-openai') $('vlocalhelp').open = true;
  void updateVoice(patch);
});
$('vurl').addEventListener('change', () => {
  $('vkey').value = '';
  renderVoiceKeyButtons();
  voiceEndpoint = $('vurl').value.trim();
  void updateVoice({ baseUrl: voiceEndpoint });
});
$('vmodel').addEventListener('change', () => updateVoice({ model: $('vmodel').value.trim() }));
$('vlanguage').addEventListener('change', () => {
  $('vlanguage').value = $('vlanguage').value.trim().toLowerCase();
  void updateVoice({ language: $('vlanguage').value });
});
$('venabled').addEventListener('change', () => {
  if ($('venabled').checked && !view.voice?.configured) {
    $('venabled').checked = false;
    focusSection('voice');
    return;
  }
  void updateVoice({ enabled: $('venabled').checked });
});
$('vkey').addEventListener('input', renderVoiceKeyButtons);
$('vkey').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('vkeysave').click(); }
});
$('vkeysave').addEventListener('click', async () => {
  const key = $('vkey').value.trim();
  if (!key || voiceSecretBusy) return;
  voiceSecretBusy = true;
  $('vkey').value = '';
  renderVoiceKeyButtons();
  try {
    await updateVoice({ preset: $('vpreset').value, baseUrl: $('vurl').value.trim(), model: $('vmodel').value.trim(), language: $('vlanguage').value.trim().toLowerCase(), key }, '语音密钥已保存。');
  } finally { voiceSecretBusy = false; renderVoiceKeyButtons(); }
});
$('vkeydelete').addEventListener('click', async () => {
  if (voiceSecretBusy) return;
  voiceSecretBusy = true;
  $('vkey').value = '';
  renderVoiceKeyButtons();
  try { await updateVoice({ key: null }, '语音密钥已清除。'); }
  finally { voiceSecretBusy = false; renderVoiceKeyButtons(); }
});
$('hksave').addEventListener('click', () => update({ hotkeys: { point: $('hk1').value.trim(), pointAlt: $('hk2').value.trim() } }));
$('pointback').addEventListener('change', () => update({ pointBack: $('pointback').checked }));
$('naturalwheel').addEventListener('change', () => update({ naturalWheel: $('naturalwheel').checked }));
$('wiggle').addEventListener('change', () => update({ wiggle: $('wiggle').checked }));
$('launchlogin').addEventListener('change', () => update({ launchAtLogin: $('launchlogin').checked }));
$('ambient').addEventListener('change', () => update({ actions: { ambient: $('ambient').checked } }));
$('compact').addEventListener('change', () => update({ actions: { compact: $('compact').checked } }));
$('ignoredapps').addEventListener('change', () => update({ actions: { ignoredApps: $('ignoredapps').value.trim() } }));
$('translateto').addEventListener('change', () => update({ actions: { translateTo: $('translateto').value } }));
$('doctemplate').addEventListener('change', () => update({ actions: { template: $('doctemplate').value } }));
$('mcpclient').addEventListener('change', () => renderMcp(view));
$('ignorechips').addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-ignore]');
  if (!btn) return;
  const cur = $('ignoredapps').value.split(/[,，;\n]+/).map((s) => s.trim()).filter(Boolean);
  const add = btn.dataset.ignore.split(',').map((s) => s.trim()).filter(Boolean);
  const merged = [...new Set([...cur, ...add])].join(', ');
  $('ignoredapps').value = merged;
  void update({ actions: { ignoredApps: merged } });
});

function showDropNote(msg) {
  const out = $('dropout');
  out.hidden = !msg;
  out.textContent = msg || '';
}

const dz = $('dropzone');
dz.addEventListener('dragover', (e) => {
  e.preventDefault();
  dz.classList.add('over');
});
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', async (e) => {
  e.preventDefault();
  dz.classList.remove('over');
  if (!e.dataTransfer?.files?.length) return;
  const res = await api.dropFiles(e.dataTransfer.files);
  showDropNote(res?.ok ? '已在屏幕中央弹出文件操作面板。' : '这些文件暂时没有可执行的操作。');
});
$('pickfiles').addEventListener('click', () => api.pickFiles());
$('actclip').addEventListener('click', async () => {
  const res = await api.actClipboard();
  showDropNote(res?.ok ? '已在屏幕中央弹出剪贴板操作面板。' : '');
});
$('openperm').addEventListener('click', () => api.openPermission());
$('try').addEventListener('click', () => {
  api.seen();
  api.tryPointing();
});
document.addEventListener('click', (e) => {
  const id = e.target.dataset?.copy;
  if (!id) return;
  window.zhidian.copy($(id).textContent);
  e.target.textContent = '已复制';
  setTimeout(() => (e.target.textContent = '复制'), 1200);
});

window.zhidian.on('settings:changed', render);
window.zhidian.on('local:progress', (p) => {
  if (view) {
    view.local.status.installing = p;
    // Keep progress cheap, but update the controls when a background installation ends
    // (including one started in a settings window that has since been closed).
    if (installing !== (installPending || Boolean(p))) return render(view);
  }
  renderProgress(p);
});
function focusSection(which) {
  if (!which || which === 'general') {
    $('advancedSettings').open = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  $('advancedSettings').open = true;
  document.getElementById('sec-' + which)?.scrollIntoView({ behavior: 'smooth' });
  for (const button of document.querySelectorAll('.nav-item')) {
    const active = button.dataset.section === which;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'location'); else button.removeAttribute('aria-current');
  }
}
for (const button of document.querySelectorAll('.nav-item')) button.addEventListener('click', () => focusSection(button.dataset.section));
window.zhidian.on('focus', focusSection);

render(await api.get());
api.seen();
const hash = location.hash.slice(1);
if (hash) focusSection(hash);
