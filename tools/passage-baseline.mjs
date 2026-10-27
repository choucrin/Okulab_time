// F-15-1。基準コミットの実測値をここだけで管理する（アプリからは読み込まない）。
export const PASSAGE_BASELINE_COMMIT = '892747ff81a60aa10ae97548f90f22b8a190dfc0';
export const PASSAGE_BASELINES = Object.freeze({
  'long-01': 10009, 'long-02': 10005, 'long-03': 10008, 'long-04': 10006,
  'long-05': 10034, 'long-06': 10157, 'long-07': 10191, 'long-08': 10080,
  'long-09': 10144, 'long-10': 10507,
});
export function passageRange(id) {
  const baseline = PASSAGE_BASELINES[id];
  if (!Number.isSafeInteger(baseline)) throw new Error(`基準文字数がありません: ${id}`);
  return { baseline, min: Math.ceil(baseline * 13 / 10), max: Math.floor(baseline * 14 / 10) };
}
export function passageCharacters(paragraphs) {
  return [...paragraphs.join('').replace(/\s/gu, '')].length;
}
