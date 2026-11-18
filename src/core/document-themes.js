// Shared by settings and the local document exporters. Colors are plain RGB hex so the
// same palette works in CSS, Office XML and slides without loading any external assets.
export const DEFAULT_DOCUMENT_THEME = 'business';
export const DOCUMENT_THEMES = Object.freeze([
  Object.freeze({ id: 'business', label: '商务蓝', description: '适合报告、方案与正式演示', accent: '2563EB', ink: '172554', muted: '64748B', paper: 'FFFFFF', surface: 'EFF6FF', line: 'DCE5F2', cover: '142647', coverInk: 'FFFFFF', font: 'Microsoft YaHei', bodyFont: 'Microsoft YaHei', serif: false }),
  Object.freeze({ id: 'clean', label: '极简灰', description: '适合技术说明与清晰的数据呈现', accent: '18181B', ink: '18181B', muted: '71717A', paper: 'FFFFFF', surface: 'F4F4F5', line: 'E4E4E7', cover: 'F4F4F5', coverInk: '18181B', font: 'Microsoft YaHei', bodyFont: 'Microsoft YaHei', serif: false }),
  Object.freeze({ id: 'warm', label: '暖调纸', description: '适合阅读、分享与创意提案', accent: 'B65C3A', ink: '40352F', muted: '857569', paper: 'FFFDFA', surface: 'F5ECE1', line: 'E5D9CB', cover: 'F5ECE1', coverInk: '40352F', font: 'Microsoft YaHei', bodyFont: '宋体', serif: true }),
]);

export function documentTheme(id) {
  return DOCUMENT_THEMES.find((theme) => theme.id === id) ?? DOCUMENT_THEMES[0];
}
