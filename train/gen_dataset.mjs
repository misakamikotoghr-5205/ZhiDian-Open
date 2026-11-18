// Synthetic training data for the pointer model.
//
// Each example is what Zhidian sends the model: one or two cropped screenshots of interface
// content, a short question, and the reply we want back: a brief answer followed by one JSON
// line saying where the answer is, on the 0-1000 grid of the crop.
//
// Pages are generated from randomised HTML templates and rendered with headless Chromium, so the
// position of every element is known exactly. Three template families are kept out of training
// entirely and used only for evaluation ("held-out"), so the score says something about
// interfaces the adapter has never seen, not about memorised layouts.
//
//   node train/gen_dataset.mjs --out /path/to/data --n 4000 --seed 7
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const OUT = args.out ?? 'train/data';
const N = Number(args.n ?? 400);
let seed = Number(args.seed ?? 1);

// ---------------------------------------------------------------- deterministic randomness
function rnd() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const money = (n) => n.toLocaleString('en-US');

// ---------------------------------------------------------------- look and feel
const FONTS = ["'Noto Sans CJK SC'", "'WenQuanYi Micro Hei'", "'WenQuanYi Zen Hei'", "'Droid Sans Fallback'", "'Open Sans','Noto Sans CJK SC'", "'Roboto','Noto Sans CJK SC'", "'Liberation Sans','WenQuanYi Micro Hei'", "'DejaVu Sans','Noto Sans CJK SC'", "'Noto Serif CJK SC'"];
const ACCENTS = ['#1677ff', '#0f9d58', '#7c4dff', '#e8590c', '#d6336c', '#0b7285', '#364fc7', '#2b8a3e', '#c92a2a', '#5f3dc4'];
function theme() {
  const dark = chance(0.35);
  const accent = pick(ACCENTS);
  const base = dark
    ? pick([{ bg: '#15161b', card: '#1f2128', text: '#e9eaf0', dim: '#9aa0b0', line: '#33363f' }, { bg: '#0f1115', card: '#1a1d24', text: '#f1f3f5', dim: '#868e96', line: '#2c2f36' }, { bg: '#1e1e1e', card: '#252526', text: '#d4d4d4', dim: '#8a8a8a', line: '#3c3c3c' }])
    : pick([{ bg: '#f4f5f7', card: '#ffffff', text: '#1d2129', dim: '#6b7385', line: '#dfe2e8' }, { bg: '#ffffff', card: '#f8f9fa', text: '#212529', dim: '#868e96', line: '#dee2e6' }, { bg: '#eef1f5', card: '#ffffff', text: '#2b2f36', dim: '#7a8190', line: '#d5dae2' }, { bg: '#faf8f5', card: '#ffffff', text: '#2d2a26', dim: '#8a8378', line: '#e6e0d6' }]);
  return { ...base, dark, accent, font: pick(FONTS), size: int(13, 17), radius: pick([0, 4, 6, 8, 12, 16]), pad: int(12, 26), weight: pick([400, 400, 500]) };
}
function css(t) {
  return `*{box-sizing:border-box}body{margin:0;padding:${int(16, 60)}px ${int(16, 80)}px;background:${t.bg};color:${t.text};font:${t.weight} ${t.size}px/1.6 ${t.font},sans-serif}
.card{background:${t.card};border:1px solid ${t.line};border-radius:${t.radius}px;padding:${t.pad}px ${t.pad + 2}px}
.dim{color:${t.dim}} h3{margin:0 0 6px;font-size:${t.size + int(1, 4)}px} p{margin:0 0 10px}
button,.btn{font:inherit;padding:${int(5, 9)}px ${int(14, 24)}px;border-radius:${Math.min(t.radius, 10)}px;border:1px solid ${t.line};background:${t.card};color:${t.text}}
.primary{background:${t.accent};border-color:${t.accent};color:#fff}
table{border-collapse:collapse;background:${t.card}} th,td{border:1px solid ${t.line};padding:${int(5, 10)}px ${int(10, 18)}px;text-align:right} th{background:${t.dark ? '#2a2d36' : '#f0f2f5'};font-weight:600} td:first-child,th:first-child{text-align:left}
.row{display:flex;align-items:center;gap:${int(8, 16)}px}`;
}
const pageOf = (t, body) => `<!doctype html><html><head><meta charset="utf-8"><style>${css(t)}</style></head><body>${body}</body></html>`;

// ---------------------------------------------------------------- vocabulary
const ZH = {
  products: ['星河 14 轻薄本', '山岚 15 全能本', '青柠 Air 13', '极光 Pro 16', '松果 Mini 主机', '海盐 27 显示器', '白鹭 无线耳机', '云雀 机械键盘', '北辰 路由器', '苍穹 移动硬盘', '晨曦 平板 11', '流萤 手环 8'],
  buttons: [['取消', '确定'], ['取消', '重试'], ['不保存', '保存'], ['稍后', '立即更新'], ['拒绝', '允许'], ['返回', '继续'], ['取消', '删除'], ['关闭', '查看详情'], ['否', '是'], ['跳过', '下一步']],
  rows: ['第一季度', '第二季度', '第三季度', '第四季度', '华东区', '华南区', '华北区', '西南区', '线上渠道', '门店渠道', '张伟', '李娜', '王芳', '刘洋', '陈静', '一月', '二月', '三月', '四月', '五月', '六月'],
  cols: ['销售额', '订单数', '利润', '访问量', '转化率', '退货数', '库存', '评分', '用时', '成本'],
  settings: ['消息通知', '自动更新', '深色模式', '定位服务', '蓝牙', '飞行模式', '自动保存', '同步到云端', '开机启动', '省电模式', '触控板手势', '拼写检查', '显示隐藏文件', '夜览', '勿扰模式'],
  menu: ['新建文件', '打开…', '最近打开', '保存', '另存为…', '导出 PDF', '打印…', '页面设置', '撤销', '重做', '查找和替换', '偏好设置', '检查更新', '关闭窗口', '全部保存', '分享…', '重命名', '移到废纸篓', '复制链接', '显示简介'],
  files: ['年度总结.docx', '预算表.xlsx', '封面设计.png', '会议纪要.md', '合同终稿.pdf', '照片备份.zip', '演示文稿.pptx', '需求文档.txt', '数据导出.csv', '发布说明.md', '头像.jpg', '脚本.py'],
};
const EN = {
  products: ['Nimbus 14 Laptop', 'Ridge 15 Notebook', 'Lime Air 13', 'Aurora Pro 16', 'Acorn Mini PC', 'Saltwater 27 Monitor', 'Heron Earbuds', 'Lark Keyboard', 'Polaris Router', 'Vault Portable SSD', 'Dawn Tablet 11', 'Firefly Band 8'],
  buttons: [['Cancel', 'OK'], ['Cancel', 'Retry'], ["Don't Save", 'Save'], ['Later', 'Update Now'], ['Deny', 'Allow'], ['Back', 'Continue'], ['Cancel', 'Delete'], ['Close', 'View Details'], ['No', 'Yes'], ['Skip', 'Next']],
  rows: ['Q1', 'Q2', 'Q3', 'Q4', 'East', 'South', 'North', 'West', 'Online', 'Retail', 'Alice', 'Bob', 'Carol', 'David', 'Erin', 'January', 'February', 'March', 'April', 'May', 'June'],
  cols: ['Revenue', 'Orders', 'Profit', 'Visits', 'Conversion', 'Returns', 'Stock', 'Rating', 'Duration', 'Cost'],
  settings: ['Notifications', 'Automatic Updates', 'Dark Mode', 'Location Services', 'Bluetooth', 'Airplane Mode', 'Autosave', 'Sync to Cloud', 'Launch at Login', 'Battery Saver', 'Trackpad Gestures', 'Spell Check', 'Show Hidden Files', 'Night Shift', 'Do Not Disturb'],
  menu: ['New File', 'Open…', 'Open Recent', 'Save', 'Save As…', 'Export as PDF', 'Print…', 'Page Setup', 'Undo', 'Redo', 'Find and Replace', 'Preferences', 'Check for Updates', 'Close Window', 'Save All', 'Share…', 'Rename', 'Move to Trash', 'Copy Link', 'Get Info'],
  files: ['annual-review.docx', 'budget.xlsx', 'cover.png', 'meeting-notes.md', 'contract-final.pdf', 'photos.zip', 'slides.pptx', 'requirements.txt', 'export.csv', 'release-notes.md', 'avatar.jpg', 'script.py'],
};

// A template returns { html, tasks }. Each task names the crop(s) by CSS selector, the question,
// the answer, and the element the answer is about (selector inside the page).
const T = {};

T.dialog = (zh) => {
  const t = theme(), V = zh ? ZH : EN;
  const [safe, act] = pick(V.buttons);
  const cases = zh
    ? [['保存失败', '磁盘空间不足，文件没有保存。清理空间后可以重试。'], ['需要更新', '有新版本可用，更新后需要重新启动。'], ['确认操作', '此操作无法撤销，是否继续？'], ['连接中断', '与服务器的连接已断开，请检查网络。'], ['权限请求', '该应用想要访问你的照片。'], ['未保存的更改', '关闭前要保存对文档的更改吗？']]
    : [['Save failed', 'The disk is full and the file was not saved. Free up space and try again.'], ['Update available', 'A new version is ready. Updating requires a restart.'], ['Are you sure?', 'This action cannot be undone. Continue?'], ['Connection lost', 'The connection to the server was interrupted. Check your network.'], ['Permission request', 'This app would like to access your photos.'], ['Unsaved changes', 'Do you want to save the changes to this document before closing?']];
  const [title, msg] = pick(cases);
  const order = chance(0.5) ? [safe, act] : [act, safe];
  const third = chance(0.25) ? (zh ? '了解更多' : 'Learn More') : null;
  const labels = third ? shuffle([...order, third]) : order;
  const align = pick(['flex-end', 'flex-start', 'center', 'space-between']);
  const w = int(300, 520);
  const html = pageOf(t, `<div class="card" id="ref" style="width:${w}px;margin-left:${int(0, 300)}px;${chance(0.5) ? 'box-shadow:0 10px 30px rgba(0,0,0,.18)' : ''}">
    <h3>${esc(title)}</h3><p class="dim">${esc(msg)}</p>
    <div class="row" style="justify-content:${align};margin-top:${int(10, 24)}px">${labels.map((l, i) => `<button id="b${i}" class="${l === act && chance(0.8) ? 'primary' : ''}">${esc(l)}</button>`).join('')}</div></div>`);
  const want = pick(labels);
  const sel = '#b' + labels.indexOf(want);
  const q = zh ? pick([`「${want}」按钮在哪？`, `我想点${want}，在哪里？`, `哪个是${want}？`]) : pick([`Where is the "${want}" button?`, `I want to press ${want}. Where is it?`, `Which one is ${want}?`]);
  const a = zh ? pick([`点这里的「${want}」。`, `「${want}」在这里。`]) : pick([`Press "${want}" here.`, `"${want}" is here.`]);
  const go = zh ? [`这个提示是什么意思？接下来该点哪个？`, `${title}：${msg.replace(/。$/, '')}。要继续就点「${act}」。`] : [`What does this mean, and what should I press?`, `${title}: ${msg} To go ahead, press "${act}".`];
  return { html, tasks: [{ refs: ['#ref'], question: q, answer: a, target: sel, label: want }, { refs: ['#ref'], question: go[0], answer: go[1], target: '#b' + labels.indexOf(act), label: act }] };
};

T.prices = (zh) => {
  const t = theme(), V = zh ? ZH : EN;
  const names = shuffle(V.products).slice(0, 2);
  const cur = zh ? '¥' : pick(['$', '€', '£']);
  let p = [int(8, 99) * 100 - 1, int(8, 99) * 100 - 1];
  if (p[0] === p[1]) p[1] += 300;
  const kg = [int(9, 24) / 10, int(9, 24) / 10];
  if (kg[0] === kg[1]) kg[1] += 0.2;
  const card = (i) => `<div class="card" id="c${i}" style="width:${int(250, 400)}px"><h3>${esc(names[i])}</h3><p class="dim">${zh ? `重 ${kg[i].toFixed(1)} kg` : `Weight ${kg[i].toFixed(1)} kg`}<span id="w${i}"></span></p>
    <div id="p${i}" style="font-size:${t.size + int(8, 16)}px;font-weight:700;color:${pick(['#d4380d', t.accent, t.text])};display:inline-block">${cur} ${money(p[i])}</div>
    <div class="dim" style="margin-top:6px">${zh ? pick(['两年保修', '一年保修', '支持七天无理由退货']) : pick(['2-year warranty', '1-year warranty', '30-day returns'])}</div></div>`;
  const html = pageOf(t, `<div class="row" style="align-items:flex-start;gap:${int(18, 60)}px;${chance(0.3) ? 'flex-direction:column' : ''}">${card(0)}${card(1)}</div>`);
  const cheap = p[0] < p[1] ? 0 : 1;
  const diff = Math.abs(p[0] - p[1]);
  const tasks = [
    {
      refs: ['#c0', '#c1'],
      question: zh ? pick(['哪个更便宜？', '哪个更划算？', '这两个哪个价格低？']) : pick(['Which one is cheaper?', 'Which is the better deal?', 'Which costs less?']),
      answer: zh ? `@${cheap + 1} 更便宜，${cur} ${money(p[cheap])}，比另一个少 ${cur} ${money(diff)}。` : `@${cheap + 1} is cheaper at ${cur} ${money(p[cheap])}, ${cur} ${money(diff)} less than the other.`,
      target: '#p' + cheap, targetRef: cheap, label: `${cur} ${money(p[cheap])}`,
    },
    {
      refs: ['#c' + cheap],
      question: zh ? pick(['多少钱？', '这个的价格是多少？']) : pick(['How much is it?', 'What is the price?']),
      answer: zh ? `${names[cheap]}，${cur} ${money(p[cheap])}。` : `${names[cheap]} costs ${cur} ${money(p[cheap])}.`,
      target: '#p' + cheap, targetRef: 0, label: `${cur} ${money(p[cheap])}`,
    },
  ];
  return { html, tasks };
};

T.table = (zh) => {
  const t = theme(), V = zh ? ZH : EN;
  const rows = shuffle(V.rows).slice(0, int(3, 7));
  const cols = shuffle(V.cols).slice(0, int(1, 3));
  const data = rows.map(() => cols.map(() => int(12, 9800)));
  const c = int(0, cols.length - 1);
  let best = 0, worst = 0;
  data.forEach((r, i) => { if (r[c] > data[best][c]) best = i; if (r[c] < data[worst][c]) worst = i; });
  const html = pageOf(t, `<table id="ref" style="margin-left:${int(0, 200)}px"><tr><th>${zh ? '项目' : 'Item'}</th>${cols.map((x) => `<th>${esc(x)}</th>`).join('')}</tr>
    ${rows.map((r, i) => `<tr><td>${esc(r)}</td>${data[i].map((v, j) => `<td id="d${i}_${j}"><span class="t">${money(v)}</span></td>`).join('')}</tr>`).join('')}</table>`);
  const hi = chance(0.5);
  const i = hi ? best : worst;
  const many = cols.length > 1;
  const q = zh ? `${many ? cols[c] : ''}${hi ? '最高' : '最低'}的是哪个？` : `Which has the ${hi ? 'highest' : 'lowest'}${many ? ' ' + cols[c].toLowerCase() : ' value'}?`;
  const a = zh ? `${rows[i]}${hi ? '最高' : '最低'}，${cols[c]}是 ${money(data[i][c])}。` : `${rows[i]} is the ${hi ? 'highest' : 'lowest'}: ${cols[c].toLowerCase()} ${money(data[i][c])}.`;
  const k = int(0, rows.length - 1);
  return {
    html,
    tasks: [
      { refs: ['#ref'], question: q, answer: a, target: `#d${i}_${c}`, label: money(data[i][c]) },
      { refs: ['#ref'], question: zh ? `${rows[k]}的${cols[c]}是多少？` : `What is the ${cols[c].toLowerCase()} for ${rows[k]}?`, answer: zh ? `${rows[k]}的${cols[c]}是 ${money(data[k][c])}。` : `${cols[c]} for ${rows[k]} is ${money(data[k][c])}.`, target: `#d${k}_${c}`, label: money(data[k][c]) },
    ],
  };
};

T.settings = (zh) => {
  const t = theme(), V = zh ? ZH : EN;
  const items = shuffle(V.settings).slice(0, int(3, 7));
  const on = items.map(() => chance(0.5));
  const tw = int(34, 46), th = Math.round(tw * 0.56);
  const toggle = (i) => `<span id="t${i}" style="display:inline-block;width:${tw}px;height:${th}px;border-radius:${th}px;background:${on[i] ? t.accent : t.line};position:relative;flex:none"><i style="position:absolute;top:2px;${on[i] ? 'right' : 'left'}:2px;width:${th - 4}px;height:${th - 4}px;border-radius:50%;background:#fff"></i></span>`;
  const html = pageOf(t, `<div class="card" id="ref" style="width:${int(280, 480)}px;padding:6px ${t.pad}px">${items.map((x, i) => `<div class="row" style="justify-content:space-between;padding:${int(8, 14)}px 0;${i ? `border-top:1px solid ${t.line}` : ''}"><span>${esc(x)}</span>${toggle(i)}</div>`).join('')}</div>`);
  const i = int(0, items.length - 1);
  const q = zh ? pick([`怎么${on[i] ? '关掉' : '打开'}${items[i]}？`, `${items[i]}的开关在哪？`]) : pick([`How do I turn ${on[i] ? 'off' : 'on'} ${items[i]}?`, `Where is the switch for ${items[i]}?`]);
  const a = zh ? `${items[i]}现在是${on[i] ? '开' : '关'}着的，点它右边这个开关就能${on[i] ? '关掉' : '打开'}。` : `${items[i]} is currently ${on[i] ? 'on' : 'off'}. Click this switch on its right to turn it ${on[i] ? 'off' : 'on'}.`;
  const offs = items.filter((_, j) => !on[j]);
  const tasks = [{ refs: ['#ref'], question: q, answer: a, target: '#t' + i, label: items[i] }];
  if (offs.length === 1) {
    const j = on.indexOf(false);
    tasks.push({ refs: ['#ref'], question: zh ? '哪一项是关着的？' : 'Which one is turned off?', answer: zh ? `只有${items[j]}是关着的。` : `Only ${items[j]} is off.`, target: '#t' + j, label: items[j] });
  }
  return { html, tasks };
};

T.code = (zh) => {
  const t = theme();
  const samples = [
    { lang: 'python', lines: ['def total(items):', '    s = 0', '    for it in items:', '        s += it.price * it.qty', '    return s'], bugs: [[3, '        s += it.price * it.qty)', '多了一个右括号', 'has an extra closing parenthesis'], [2, '    for it in items', '末尾少了冒号', 'is missing the colon at the end'], [4, '    retrun s', 'return 拼错了', 'misspells return']] },
    { lang: 'js', lines: ['function greet(name) {', '  const msg = "Hello, " + name;', '  console.log(msg);', '  return msg;', '}'], bugs: [[1, '  const msg = "Hello, " + name', '字符串后面少了分号', 'is missing the semicolon'], [2, '  console.log(mgs);', '变量名写成了 mgs', 'uses the misspelled variable mgs'], [1, '  const msg = "Hello,  + name;', '字符串少了右引号', 'is missing the closing quote']] },
    { lang: 'json', lines: ['{', '  "name": "zhidian",', '  "version": "0.1.0",', '  "private": true', '}'], bugs: [[1, '  "name": "zhidian"', '末尾少了逗号', 'is missing the trailing comma'], [3, '  "private": ture', 'true 拼错了', 'misspells true'], [2, '  version: "0.1.0",', '键名没有加引号', 'has an unquoted key']] },
    { lang: 'sql', lines: ['SELECT name, price', 'FROM products', 'WHERE price > 100', 'ORDER BY price DESC', 'LIMIT 10;'], bugs: [[1, 'FORM products', 'FROM 拼成了 FORM', 'misspells FROM as FORM'], [3, 'ORDER price DESC', 'ORDER 后面少了 BY', 'is missing BY after ORDER'], [0, 'SELECT name price', '两个列名之间少了逗号', 'is missing the comma between the columns']] },
  ];
  const s = pick(samples);
  const [row, bad, whyZh, whyEn] = pick(s.bugs);
  const lines = s.lines.map((l, i) => (i === row ? bad : l));
  const dark = chance(0.7);
  const nums = chance(0.6);
  const html = pageOf(t, `<pre id="ref" style="margin:0 0 0 ${int(0, 200)}px;display:inline-block;min-width:${int(280, 460)}px;background:${dark ? '#1e1f26' : '#f6f8fa'};color:${dark ? '#e6e7ee' : '#24292f'};border:1px solid ${t.line};border-radius:${t.radius}px;padding:${int(10, 20)}px ${int(12, 22)}px;font:${int(12, 15)}px/1.7 'DejaVu Sans Mono','Liberation Mono',monospace">${lines.map((l, i) => `<span id="l${i}" style="display:block">${nums ? `<span style="opacity:.45;margin-right:14px">${i + 1}</span>` : ''}<span class="t">${esc(l) || ' '}</span></span>`).join('')}</pre>`);
  const q = zh ? pick(['哪一行有问题？', '这段代码错在哪？', '为什么报错？']) : pick(['Which line is wrong?', 'What is wrong with this code?', 'Why does this fail?']);
  const a = zh ? `第 ${row + 1} 行${whyZh}。` : `Line ${row + 1} ${whyEn}.`;
  return { html, tasks: [{ refs: ['#ref'], question: q, answer: a, target: '#l' + row, label: zh ? `第 ${row + 1} 行` : `line ${row + 1}` }] };
};

T.form = (zh) => {
  const t = theme();
  const fields = zh ? [['用户名', 'hengrui'], ['邮箱', 'name@example.com'], ['手机号', '138 0000 0000'], ['城市', '杭州'], ['公司', '晴空科技'], ['邮编', '310000'], ['昵称', '小北']] : [['Username', 'hengrui'], ['Email', 'name@example.com'], ['Phone', '555 0100'], ['City', 'Portland'], ['Company', 'Clearsky Labs'], ['Postcode', '97201'], ['Nickname', 'North']];
  const use = shuffle(fields).slice(0, int(3, 5));
  const empty = int(0, use.length - 1);
  const [cancel, submit] = zh ? pick([['取消', '提交'], ['重置', '保存'], ['返回', '注册']]) : pick([['Cancel', 'Submit'], ['Reset', 'Save'], ['Back', 'Sign Up']]);
  const inline = chance(0.4);
  const html = pageOf(t, `<div class="card" id="ref" style="width:${int(300, 460)}px">${use.map(([l, v], i) => `<div style="margin-bottom:${int(8, 14)}px;${inline ? 'display:flex;align-items:center;gap:10px' : ''}"><div class="dim" style="${inline ? 'width:72px;flex:none' : 'margin-bottom:3px'}">${esc(l)}</div><div id="f${i}" style="flex:1;border:1px solid ${i === empty ? '#e03131' : t.line};border-radius:${Math.min(t.radius, 8)}px;padding:${int(5, 8)}px 10px;min-height:${t.size * 2 + 6}px;background:${t.dark ? '#14151a' : '#fff'}">${i === empty ? '' : esc(v)}</div></div>`).join('')}
    <div class="row" style="justify-content:flex-end;margin-top:${int(10, 18)}px"><button id="cancel">${esc(cancel)}</button><button id="submit" class="primary">${esc(submit)}</button></div></div>`);
  return {
    html,
    tasks: [
      { refs: ['#ref'], question: zh ? pick(['哪一项还没填？', '为什么提交不了？']) : pick(['Which field is still empty?', "Why can't I submit?"]), answer: zh ? `「${use[empty][0]}」还是空的，填上它才能${submit}。` : `"${use[empty][0]}" is still empty. Fill it in before you can ${submit.toLowerCase()}.`, target: '#f' + empty, label: use[empty][0] },
      { refs: ['#ref'], question: zh ? `填完之后点哪里${submit}？` : `Where do I ${submit.toLowerCase()} when I am done?`, answer: zh ? `点右下角的「${submit}」。` : `Press "${submit}" at the bottom.`, target: '#submit', label: submit },
    ],
  };
};

// ---- held out: never trained on
T.menu = (zh) => {
  const t = theme(), V = zh ? ZH : EN;
  const items = shuffle(V.menu).slice(0, int(5, 9));
  const i = int(0, items.length - 1);
  const html = pageOf(t, `<div id="ref" style="display:inline-block;margin-left:${int(0, 400)}px;background:${t.card};border:1px solid ${t.line};border-radius:${Math.min(t.radius, 10)}px;padding:5px 0;min-width:${int(180, 280)}px;box-shadow:0 8px 24px rgba(0,0,0,.2)">${items.map((x, k) => `<div id="m${k}" style="padding:${int(4, 8)}px ${int(14, 22)}px;${k && chance(0.2) ? `border-top:1px solid ${t.line}` : ''}"><span class="t">${esc(x)}</span></div>`).join('')}</div>`);
  const name = items[i].replace('…', '');
  return { html, tasks: [{ refs: ['#ref'], question: zh ? pick([`${name}在哪？`, `我要${name}，点哪个？`]) : pick([`Where is ${name}?`, `I want to ${name.toLowerCase()}. Which one?`]), answer: zh ? `点菜单里的「${items[i]}」。` : `Choose "${items[i]}" in this menu.`, target: '#m' + i, label: items[i] }] };
};

T.files = (zh) => {
  const t = theme(), V = zh ? ZH : EN;
  const files = shuffle(V.files).slice(0, int(4, 8));
  const sizes = files.map(() => int(3, 9900));
  let big = 0;
  sizes.forEach((s, i) => { if (s > sizes[big]) big = i; });
  const fmt = (kb) => (kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB');
  const html = pageOf(t, `<div class="card" id="ref" style="width:${int(320, 520)}px;padding:4px ${t.pad}px">${files.map((f, i) => `<div id="r${i}" class="row" style="justify-content:space-between;padding:${int(6, 11)}px 0;${i ? `border-top:1px solid ${t.line}` : ''}"><span class="t">${esc(f)}</span><span class="dim" id="s${i}">${fmt(sizes[i])}</span></div>`).join('')}</div>`);
  const k = int(0, files.length - 1);
  return {
    html,
    tasks: [
      { refs: ['#ref'], question: zh ? '哪个文件最大？' : 'Which file is the largest?', answer: zh ? `${files[big]} 最大，${fmt(sizes[big])}。` : `${files[big]} is the largest at ${fmt(sizes[big])}.`, target: '#r' + big, label: files[big] },
      { refs: ['#ref'], question: zh ? `${files[k]} 有多大？` : `How big is ${files[k]}?`, answer: zh ? `${files[k]} 是 ${fmt(sizes[k])}。` : `${files[k]} is ${fmt(sizes[k])}.`, target: '#s' + k, label: fmt(sizes[k]) },
    ],
  };
};

T.toolbar = (zh) => {
  const t = theme();
  const tools = zh ? ['加粗', '斜体', '下划线', '插入图片', '插入表格', '撤销', '重做', '对齐', '字号', '高亮', '链接', '清除格式'] : ['Bold', 'Italic', 'Underline', 'Image', 'Table', 'Undo', 'Redo', 'Align', 'Font Size', 'Highlight', 'Link', 'Clear Format'];
  const use = shuffle(tools).slice(0, int(4, 8));
  const i = int(0, use.length - 1);
  const html = pageOf(t, `<div id="ref" class="row" style="display:inline-flex;margin-left:${int(0, 200)}px;background:${t.card};border:1px solid ${t.line};border-radius:${Math.min(t.radius, 10)}px;padding:${int(4, 8)}px ${int(6, 10)}px;gap:${int(2, 10)}px">${use.map((x, k) => `<span id="k${k}" style="padding:${int(3, 6)}px ${int(8, 12)}px;border-radius:6px;${chance(0.15) ? `background:${t.line}` : ''}">${esc(x)}</span>`).join('')}</div>`);
  return { html, tasks: [{ refs: ['#ref'], question: zh ? `${use[i]}在工具栏的哪里？` : `Where is ${use[i]} on this toolbar?`, answer: zh ? `「${use[i]}」在这里。` : `"${use[i]}" is here.`, target: '#k' + i, label: use[i] }] };
};

const TRAIN = ['dialog', 'prices', 'table', 'settings', 'code', 'form'];
const HELD = ['menu', 'files', 'toolbar'];

// ---------------------------------------------------------------- render
fs.mkdirSync(path.join(OUT, 'img'), { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
const out = { train: [], val: [], heldout: [] };
let made = 0, pages = 0;
const want = { train: N, val: Math.max(40, Math.round(N * 0.05)), heldout: Math.max(90, Math.round(N * 0.06)) };

async function build(split, family, zh) {
  const { html, tasks } = T[family](zh);
  await page.setContent(html);
  pages++;
  for (const task of tasks) {
    if (out[split].length >= want[split]) return;
    const margin = int(4, 22);
    const crops = [];
    for (const sel of task.refs) {
      const r = await page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, sel);
      const clip = { x: Math.max(0, Math.floor(r.x - margin)), y: Math.max(0, Math.floor(r.y - margin)), width: Math.ceil(r.w + margin * 2), height: Math.ceil(r.h + margin * 2) };
      clip.width = Math.min(clip.width, 1280 - clip.x);
      clip.height = Math.min(clip.height, 860 - clip.y);
      crops.push(clip);
    }
    const ti = task.targetRef ?? 0;
    // The hit box is the whole element (a row, a cell); the point goes on its text if marked.
    const [tr, tp] = await page.evaluate((s) => {
      const rect = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
      const e = document.querySelector(s);
      return [rect(e), rect(e.querySelector('.t') ?? e)];
    }, task.target);
    const c = crops[ti];
    const box = { x: tr.x - c.x, y: tr.y - c.y, w: tr.w, h: tr.h };
    const at = { x: tp.x - c.x + tp.w / 2, y: tp.y - c.y + tp.h / 2 };
    if (box.w < 4 || box.h < 4 || box.x < 0 || box.y < 0 || box.x + box.w > c.width + 1 || box.y + box.h > c.height + 1) continue;
    const id = `${split}-${String(made++).padStart(6, '0')}`;
    const images = [];
    for (let k = 0; k < crops.length; k++) {
      const file = `img/${id}-${k + 1}.png`;
      await page.screenshot({ path: path.join(OUT, file), clip: crops[k] });
      images.push({ file, w: crops[k].width, h: crops[k].height });
    }
    // The 0-1000 grid of the crop the target is in: the convention the Qwen-VL line is trained on.
    const px = Math.round((at.x / c.width) * 1000);
    const py = Math.round((at.y / c.height) * 1000);
    // In the app a crop keeps the handle it was pinned with, so the first image of a question
    // is not always @1. Half the examples use shifted handles so the model copies the labels
    // it is given instead of counting images.
    const shift = chance(0.5) ? 0 : int(1, 7);
    const handles = images.map((_, k) => `@${k + 1 + shift}`);
    const rename = (text) => text.replace(/@(\d)/g, (_, d) => `@${Number(d) + shift}`);
    out[split].push({
      id, family, lang: zh ? 'zh' : 'en', images, handles, question: task.question, answer: rename(task.answer),
      point: { ref: handles[ti], x: px, y: py, label: task.label },
      box: { ref: handles[ti], x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) },
    });
  }
}

while (out.train.length < want.train) await build('train', pick(TRAIN), chance(0.7));
while (out.val.length < want.val) await build('val', pick(TRAIN), chance(0.7));
while (out.heldout.length < want.heldout) await build('heldout', pick(HELD), chance(0.7));
await browser.close();

for (const [split, rows] of Object.entries(out)) fs.writeFileSync(path.join(OUT, `${split}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const count = (rows) => Object.entries(rows.reduce((m, r) => ((m[r.family] = (m[r.family] ?? 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join(', ');
console.log(`pages rendered: ${pages}`);
for (const [split, rows] of Object.entries(out)) console.log(`${split}: ${rows.length} (${count(rows)})`);
