// A compact office product: both the UI and execution use this same capability boundary.
export const BASIC_ACTIONS = Object.freeze([
  'files.pdf', 'files.pptx', 'word.restyle', 'pdf.split', 'pdf.extract',
  'sheets.merge', 'images.shrink', 'text.typeset',
]);
export const ADVANCED_ACTIONS = Object.freeze([
  ...BASIC_ACTIONS, 'pdf.word', 'pdf.text', 'word.text', 'word.markdown',
  'file.typeset', 'sheet.xlsx', 'sheet.csv', 'text.translate', 'text.polish',
  'text.summary', 'doc.summary', 'image.ocr',
]);
const basic = new Set(BASIC_ACTIONS), advanced = new Set(ADVANCED_ACTIONS);
export function officeActionAllowed(id, tier = 'small') {
  return (tier === 'large' ? advanced : basic).has(id);
}
