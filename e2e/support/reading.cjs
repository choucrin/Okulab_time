// F-15-1: 段落追加/分割を許可し、表示された本文を同梱原文と題別範囲に照合する。
async function expectLongPassage(page, expect) {
  const { LONG_PASSAGES } = await import('../../js/passages-long.js');
  const { passageRange } = await import('../../tools/passage-baseline.mjs');
  const text = page.locator('#passage-text');
  await expect(text.locator('p').first()).not.toBeEmpty();
  const first = await text.locator('p').first().textContent();
  const passage = LONG_PASSAGES.find(p => p.paragraphs[0] === first);
  expect(passage).toBeTruthy();
  await expect(text.locator('p')).toHaveText(passage.paragraphs);
  const length = [...(await text.textContent()).replace(/\s/gu, '')].length;
  const range = passageRange(passage.id);
  expect(length).toBeGreaterThanOrEqual(range.min);
  expect(length).toBeLessThanOrEqual(range.max);
}
module.exports = { expectLongPassage };
