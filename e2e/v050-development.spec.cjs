// Developmentの動作確認。独立Testの受け入れテストは後続で追加する。
const { test, expect, seed, join } = require('./support/harness.cjs');

test('v.05.0: 条件名だけの試行・管理ダイアログ・編集削除と実行の分離', async ({ page, context, appServer }, testInfo) => {
  const passphrase = 'v050-patterns';
  const room = await seed(page, appServer, { passphrase, catalog: [] });
  page.on('dialog', dialog => dialog.accept());
  await page.evaluate(() => {
    localStorage.setItem('okulab-time/random/sets', '{broken');
    localStorage.setItem('okulab-time/random/' + 'unrelated', '{pending');
  });
  await join(page, appServer, { passphrase, role: 'start' });
  await page.locator('#measurement-mode').check(); await page.click('#random-open');
  for (const condition of ['赤', '白', '白点滅']) {
    await page.fill('#sequence-condition', condition); await page.click('#random-add');
    await expect(page.locator('#sequence-condition')).toHaveValue('');
  }
  await page.fill('#sequence-sets', '5'); await page.fill('#random-name', '色パターン');
  await page.click('#random-save'); await page.click('#random-import');
  await expect(page.locator('#sequence-next')).toContainText('赤');
  expect(await page.locator('#btn-start').evaluate(e => e.previousElementSibling.id)).toBe('sequence-next');
  const runKey = 'okulab-time/sequence/' + room;
  const frozen = await page.evaluate(key => localStorage.getItem(key), runKey);
  await page.click('#btn-patterns'); await expect(page.locator('#patterns-dialog')).toBeVisible();
  await page.getByRole('button', { name: '「色パターン」を編集', exact: true }).click();
  await page.getByLabel('保存名(40文字まで)', { exact: true }).fill('改名');
  await page.getByLabel('条件 1 の条件名(80文字まで)', { exact: true }).fill('青');
  await page.locator('#patterns-editor').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#patterns-message')).toContainText('保存しました');
  expect(await page.evaluate(key => localStorage.getItem(key), runKey)).toBe(frozen);
  await page.screenshot({ path: testInfo.outputPath('patterns-managed.png') });
  await page.click('#patterns-close'); await expect(page.locator('#btn-patterns')).toBeFocused();
  await expect(page.locator('#random-saved option')).toHaveText(['改名']);
  const end = await context.newPage(); await join(end, appServer, { passphrase, role: 'end' });
  await expect(end.locator('#btn-patterns')).toBeHidden();
  await page.click('#btn-start'); await expect(end.locator('#status-label')).toHaveText('計測中');
  await page.click('#btn-patterns');
  await expect(page.locator('#patterns-lock')).toContainText('計測と判定');
  await expect(page.getByRole('button', { name: '「改名」を削除', exact: true })).toBeDisabled();
  await page.click('#patterns-close'); await end.click('#btn-end');
  await expect(page.locator('#random-confirm')).toBeVisible();
  await expect(page.locator('#sequence-next-title')).toContainText('現在の試行');
  await page.click('#random-no'); await expect(page.locator('#sequence-next-title')).toHaveText('次の試行');
  await expect(page.locator('#sequence-next')).toContainText('赤');
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), runKey);
  expect(saved.done).toBe(0); expect(saved.attempts).toBe(1);
  await page.click('#btn-patterns'); await page.getByRole('button', { name: '「改名」を削除', exact: true }).click();
  await expect(page.locator('#patterns-list')).toHaveText('保存済みパターンはありません');
  await page.click('#patterns-close'); await expect(page.locator('#random-load')).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem('okulab-time/random/sets'))).toBe('{broken');
  const width = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(width.actual).toBeLessThanOrEqual(width.viewport);
});
