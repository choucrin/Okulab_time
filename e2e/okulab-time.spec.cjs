// v.03.2(F-11)の案件固有ブラウザ E2E(RSD 7-3)。
//
// 実アプリ(index.html / js / css)を 127.0.0.1 で配信し、Firebase SDK は e2e/stubs の
// インメモリ実装へ差し替える(本番 Firebase には接続しない。support/harness.cjs 参照)。
// Ubuntu 上の WebKit / Chromium による端末エミュレーションであり、iPhone・iPad・Windows
// 実機での合格を意味しない(A-29 は実機で別途確認する)。
const fs = require('node:fs');
const { test, expect, seed, join, pageWidth, recordTags, parseCsv, storedSessions } = require('./support/harness.cjs');

const HEADINGS = ['ラベル', '経過(秒)', '選択式ラベル', '方式 / 判定', '開始', '終了', '操作'];
const LONG_GENRE = 'G'.repeat(40);
const LONG_ITEM = 'V'.repeat(40);
const LONG_LABEL = '長いラベル' + 'L'.repeat(75);

// 順序が逆に保存された記録・片方のみ・その他のジャンル・旧形式・タグ無しが混在するルーム
const SESSIONS = [
  { label: '逆順保存', tags: ['パターン:縞', '色:白'], chips: [['色', '白'], ['パターン', '縞']] },
  { label: '正順保存', tags: ['色:赤', 'パターン:水玉'], chips: [['色', '赤'], ['パターン', '水玉']] },
  { label: 'パターンのみ', tags: ['パターン:格子'], chips: [['パターン', '格子']] },
  { label: '色のみ', tags: ['色:青'], chips: [['色', '青']] },
  { label: 'その他含む', tags: ['音:低', 'パターン:縞', '形:丸', '色:白'],
    chips: [['色', '白'], ['パターン', '縞'], ['形', '丸'], ['音', '低']] },
  { label: '旧形式', tags: ['メモ', '色:黒'], chips: [['色', '黒'], ['ラベル', 'メモ']] },
  { label: 'タグなし', tags: [], chips: [] },
  { label: LONG_LABEL, tags: [`${LONG_GENRE}:${LONG_ITEM}`, `パターン:${'P'.repeat(40)}`, '色:白'],
    chips: [['色', '白'], ['パターン', 'P'.repeat(40)], [LONG_GENRE, LONG_ITEM]] },
].map((s, i) => {
  const startMs = Date.UTC(2026, 9, 1, 1, 0, 0) + i * 60000;
  const durationMs = 1500 + i * 111;
  return {
    ...s,
    doc: {
      id: `seed-${i}`, status: 'done', label: s.label, tags: s.tags, mode: 'free',
      randomBatchId: null, randomOutcome: null,
      startMs, startRawMs: startMs, startOffsetMs: 0, startAccuracyMs: 5, startSynced: true, startedBy: 'seed',
      endMs: startMs + durationMs, endRawMs: startMs + durationMs, endOffsetMs: 0, endAccuracyMs: 5,
      endSynced: true, endedBy: 'seed', durationMs, durationSec: durationMs / 1000,
    },
    seconds: (durationMs / 1000).toFixed(3),
  };
});

const CATALOG_PATTERN_FIRST = [
  { name: 'パターン', items: ['縞', '水玉'] },
  { name: '色', items: ['白', '赤'] },
  { name: LONG_GENRE, items: [LONG_ITEM] },
];

async function press(page, selector, isMobile) {
  if (isMobile) await page.locator(selector).tap();
  else await page.locator(selector).click();
}

async function expectNoOverflow(page, state) {
  const w = await pageWidth(page);
  const viewport = page.viewportSize().width;
  const detail = `${state}: ${JSON.stringify(w)} viewport=${viewport}`;
  expect.soft(w.html, detail).toBeLessThanOrEqual(w.inner + 1);
  expect.soft(w.body, detail).toBeLessThanOrEqual(w.inner + 1);
  expect.soft(w.inner, detail).toBeLessThanOrEqual(viewport + 1);
  return w;
}

async function snap(page, testInfo, name) {
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

async function exportCsv(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-csv')]);
  const file = await download.path();
  return parseCsv(fs.readFileSync(file, 'utf8'));
}

for (const [condition, catalog] of [['カタログ無し(カタログを持たない端末相当)', null], ['パターン→色の順のカタログ', CATALOG_PATTERN_FIRST]]) {
  test(`A-25/A-26/A-27: 記録一覧の列順・表示順・1行表示と CSV の保存順(${condition})`, async ({ page, appServer, blocked }, testInfo) => {
    const passphrase = 'e2e-records';
    const roomId = await seed(page, appServer, { catalog, passphrase, sessions: SESSIONS.map((s) => s.doc) });
    await join(page, appServer, { passphrase, role: 'start' });
    await expect(page.locator('#record-body tr')).toHaveCount(SESSIONS.length);
    await expect(page.locator('#version')).toHaveText('v.03.2');

    // A-25: 見出しとセルの対応
    const headings = await page.locator('.table thead th').allTextContents();
    expect(headings.map((h) => h.trim())).toEqual(HEADINGS);
    const rows = await page.locator('#record-body tr').evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((td) => ({
      text: td.textContent, className: td.className, align: getComputedStyle(td).textAlign,
    }))));
    for (const row of rows) {
      expect(row).toHaveLength(HEADINGS.length);
      const seeded = SESSIONS.find((s) => s.label === row[0].text);
      expect(seeded, row[0].text).toBeTruthy();
      expect(row[1].text).toBe(seeded.seconds);
      expect(row[1].className).toContain('num');
      expect(row[1].align).toBe('right');
      expect(row[2].className).toBe('tags-cell');
      expect(row[3].text).toBe('任意');
      expect(row[6].text).toBe('×');
    }

    // A-26: 色 → パターン → その他、タグの欠落なし
    const shown = await recordTags(page);
    for (const s of SESSIONS) {
      const row = shown.find((r) => r.label === s.label);
      expect(row.chips, s.label).toEqual(s.chips);
      if (!s.tags.length) expect(row.tagsText).toBe('—');
    }

    // A-27: 1 行表示(チップの上端が揃い、チップ内もジャンルと内容が横並び、行が 2 行分にならない)
    const layout = await page.locator('#record-body tr').evaluateAll((trs) => trs.map((tr) => ({
      label: tr.cells[0].textContent,
      rowHeight: tr.getBoundingClientRect().height,
      chips: [...tr.querySelectorAll('.tag-chip')].map((chip) => {
        const c = chip.getBoundingClientRect();
        const g = chip.querySelector('small').getBoundingClientRect();
        const v = chip.querySelector('strong').getBoundingClientRect();
        return { top: c.top, height: c.height, genreBottom: g.bottom, valueTop: v.top, genreRight: g.right, valueLeft: v.left };
      }),
    })));
    const plain = layout.find((r) => r.label === 'タグなし');
    for (const row of layout.filter((r) => r.chips.length)) {
      const tops = row.chips.map((c) => c.top);
      expect(Math.max(...tops) - Math.min(...tops), `${row.label} のチップが同じ行にない`).toBeLessThanOrEqual(1);
      for (const chip of row.chips) {
        expect(chip.genreBottom, `${row.label}: ジャンルと内容が縦に積まれている`).toBeGreaterThan(chip.valueTop);
        expect(chip.genreRight, `${row.label}: ジャンルが内容の左にない`).toBeLessThanOrEqual(chip.valueLeft + 0.5);
      }
      expect(row.rowHeight, `${row.label} の行高さがタグ無しの行の 1.5 倍以上`).toBeLessThan(plain.rowHeight * 1.5);
    }

    // F-11-1: 長いラベル・長いジャンル名があってもページ全体は広がらず、表の内部でスクロールする
    await expectNoOverflow(page, '記録多数・長いラベル');
    await snap(page, testInfo, 'records');

    // CSV の tags 列は保存順のまま(表示の整列で書き換えない)
    const csv = await exportCsv(page);
    expect(csv).toHaveLength(SESSIONS.length);
    for (const s of SESSIONS) {
      const line = csv.find((r) => r.session_id === s.doc.id);
      expect(line.tags, s.label).toBe(s.tags.join('; '));
    }
    const stored = await storedSessions(page, roomId);
    for (const s of SESSIONS) expect(stored.find((d) => d.id === s.doc.id).tags).toEqual(s.tags);
    expect(blocked).toEqual([]);
  });
}

test('A-24: 計測者画面の全状態でページ全体が画面幅を超えない', async ({ page, appServer, blocked }, testInfo) => {
  page.on('dialog', (dialog) => dialog.accept());
  const passphrase = 'e2e-width';
  const catalog = [
    { name: '色', items: ['白', '赤'] },
    { name: 'パターン', items: ['縞'] },
    { name: LONG_GENRE, items: [LONG_ITEM, 'W'.repeat(40)] },
  ];
  await seed(page, appServer, { catalog, passphrase });
  await join(page, appServer, { passphrase, role: 'start' });
  const widths = testInfo.project.name === 'iphone-portrait' ? [null, 375] : [null];

  const check = async (state) => {
    for (const width of widths) {
      if (width) await page.setViewportSize({ width, height: 667 });
      await expectNoOverflow(page, `${state}${width ? ` (${width}px)` : ''}`);
      if (width) await page.setViewportSize(testInfo.project.use.viewport);
    }
  };

  await expect(page.locator('#record-empty')).toBeVisible();
  await check('記録0件・任意方式');
  await page.locator('#catalog-options label', { hasText: LONG_ITEM }).locator('input').check();
  await page.locator('details summary').click();
  await expect(page.locator('#catalog-editor')).toBeVisible();
  await check('カタログ編集表示中');
  await page.locator('details summary').click();

  await page.locator('#measurement-mode').check();
  await expect(page.locator('#random-presets')).toBeVisible();
  await check('ランダム方式・保存済みセットなし');
  await page.click('#random-open');
  await expect(page.locator('#random-settings')).toBeVisible();
  await check('ランダム条件設定ページ表示');
  for (const item of ['白', '縞', LONG_ITEM]) {
    await page.locator('#random-options label', { hasText: item }).first().locator('input').check();
  }
  await page.fill('#random-count', '2');
  await page.click('#random-add');
  await page.locator('#random-options label', { hasText: '赤' }).locator('input').check();
  await page.click('#random-add');
  await expect(page.locator('#random-items .random-item')).toHaveCount(2);
  await check('ランダム設定・項目追加後');
  await page.fill('#random-name', 'S'.repeat(40));
  await page.click('#random-save');
  await expect(page.locator('#random-message')).toHaveText('ランダム条件セットを保存しました。');
  await check('保存済みセットあり');
  await snap(page, testInfo, 'random-settings');
  await page.click('#random-import');
  await expect(page.locator('#random-settings')).toBeHidden();
  await expect(page.locator('#random-progress')).toBeVisible();
  await check('実行中バッチ(試行状況)表示');
  await page.click('#random-open');
  await check('実行中バッチ+設定ページ再表示');
  await page.click('#random-open');
  await snap(page, testInfo, 'random-progress');
  expect(blocked).toEqual([]);
});

test('A-28: 任意方式の開始→終了→一覧反映と中止(開始端末・終了端末の 2 ページ)', async ({ page, context, appServer, blocked, isMobile }, testInfo) => {
  page.on('dialog', (dialog) => dialog.accept());
  const passphrase = 'e2e-free';
  const catalog = [{ name: 'パターン', items: ['縞'] }, { name: '色', items: ['白'] }];
  const roomId = await seed(page, appServer, { catalog, passphrase });
  await join(page, appServer, { passphrase, role: 'start' });
  const end = await context.newPage();
  await join(end, appServer, { passphrase, role: 'end' });

  await page.fill('#input-label', '任意A');
  await page.locator('#catalog-options label', { hasText: '縞' }).locator('input').check();
  await page.locator('#catalog-options label', { hasText: '白' }).locator('input').check();
  await press(page, '#btn-start', isMobile);
  await expect(page.locator('#status-label')).toHaveText('計測中');
  await expect(page.locator('#record-body tr').first().locator('td').nth(1)).toHaveText('計測中');
  await expectNoOverflow(page, '計測中');
  await expect(end.locator('#status-label')).toHaveText('計測中');
  await end.waitForTimeout(300);
  await press(end, '#btn-end', isMobile);
  await expect(end.locator('#status-label')).toHaveText('待機中');
  await expect(page.locator('#status-label')).toHaveText('待機中');

  const first = page.locator('#record-body tr').first();
  await expect(first.locator('td').nth(0)).toHaveText('任意A');
  await expect(first.locator('td').nth(1)).toHaveText(/^\d+\.\d{3}$/);
  await expect(first.locator('td').nth(3)).toHaveText('任意');
  expect((await recordTags(page))[0].chips).toEqual([['色', '白'], ['パターン', '縞']]);
  const [doc] = await storedSessions(page, roomId);
  expect(doc.status).toBe('done');
  // 送信 tags は従来どおり端末カタログ順(F-10-6。今回変更しない)
  expect(doc.tags).toEqual(['パターン:縞', '色:白']);
  expect(Number(await first.locator('td').nth(1).textContent())).toBeCloseTo(doc.durationMs / 1000, 3);
  await expect(end.locator('#record-body tr').first().locator('td').nth(1)).toHaveText(doc.durationSec.toFixed(3));

  // 中止
  await page.fill('#input-label', '中止する計測');
  await press(page, '#btn-start', isMobile);
  await expect(page.locator('#btn-abort')).toBeVisible();
  await page.click('#btn-abort');
  await expect(page.locator('#status-label')).toHaveText('待機中');
  await expect(page.locator('#record-body tr').first().locator('td').nth(0)).toHaveText('中止する計測');
  await expect(page.locator('#record-body tr').first().locator('td').nth(1)).toHaveText('中止');
  await expectNoOverflow(page, '記録あり・中止後');
  await snap(page, testInfo, 'free-start');
  await snap(end, testInfo, 'free-end');

  const csv = await exportCsv(page);
  expect(csv.map((r) => [r.label, r.status, r.tags])).toEqual([
    ['任意A', 'done', 'パターン:縞; 色:白'],
    ['中止する計測', 'aborted', 'パターン:縞; 色:白'],
  ]);
  expect(blocked).toEqual([]);
});

test('A-28: ランダム方式の開始→終了→Yes/No 確認後の一覧表示', async ({ page, context, appServer, blocked, isMobile }, testInfo) => {
  page.on('dialog', (dialog) => dialog.accept());
  const passphrase = 'e2e-random';
  // カタログ順が「パターン → 色」の端末。送信 tags はこの順で保存される
  const catalog = [{ name: 'パターン', items: ['縞'] }, { name: '色', items: ['白'] }];
  const roomId = await seed(page, appServer, { catalog, passphrase });
  await join(page, appServer, { passphrase, role: 'start' });
  const end = await context.newPage();
  await join(end, appServer, { passphrase, role: 'end' });

  await page.locator('#measurement-mode').check();
  await page.click('#random-open');
  await page.locator('#random-options label', { hasText: '白' }).locator('input').check();
  await page.locator('#random-options label', { hasText: '縞' }).locator('input').check();
  await page.fill('#random-count', '2');
  await page.click('#random-add');
  await page.click('#random-import');
  await expect(page.locator('#random-message')).toHaveText('ランダムバッチを確定しました。');
  await expect(page.locator('#random-progress')).toContainText('残り試行回数2 回');

  for (const [answer, outcome, remaining] of [['#random-yes', '有効', '1 回'], ['#random-no', 'ランダム試行内のエラーデータ', '1 回']]) {
    await expect(page.locator('#btn-start')).toBeEnabled();
    await press(page, '#btn-start', isMobile);
    await expect(end.locator('#status-label')).toHaveText('計測中');
    await end.waitForTimeout(300);
    await press(end, '#btn-end', isMobile);
    await expect(page.locator('#random-confirm')).toBeVisible();
    await expect(page.locator('#record-body tr').first().locator('td').nth(3)).toHaveText('ランダム / 未確定');
    await expectNoOverflow(page, `計測後確認(${answer})`);
    if (answer === '#random-yes') await snap(page, testInfo, 'random-confirm');
    await page.click(answer);
    await expect(page.locator('#random-confirm')).toBeHidden();
    const row = page.locator('#record-body tr').first();
    await expect(row.locator('td').nth(3)).toHaveText(`ランダム / ${outcome}`);
    await expect(row.locator('td').nth(1)).toHaveText(/^\d+\.\d{3}$/);
    await expect(page.locator('#random-progress')).toContainText(`残り試行回数${remaining}`);
  }

  for (const r of await recordTags(page)) expect(r.chips).toEqual([['色', '白'], ['パターン', '縞']]);
  const stored = await storedSessions(page, roomId);
  expect(stored.map((d) => [d.mode, d.randomOutcome, d.tags]).sort()).toEqual([
    ['random', 'confirmed', ['パターン:縞', '色:白']],
    ['random', 'discarded', ['パターン:縞', '色:白']],
  ]);
  const csv = await exportCsv(page);
  expect(csv.map((r) => [r.mode, r.random_outcome, r.tags])).toEqual([
    ['ランダム', '有効', 'パターン:縞; 色:白'],
    ['ランダム', 'ランダム試行内のエラーデータ', 'パターン:縞; 色:白'],
  ]);
  await snap(page, testInfo, 'random-done');
  expect(blocked).toEqual([]);
});

test('A-24: 終了担当・閲覧のみの画面もページ全体が画面幅を超えない', async ({ page, context, appServer, blocked }, testInfo) => {
  const passphrase = 'e2e-roles';
  await seed(page, appServer, { passphrase, sessions: SESSIONS.map((s) => s.doc) });
  await join(page, appServer, { passphrase, role: 'end' });
  await expect(page.locator('#record-body tr')).toHaveCount(SESSIONS.length);
  await expectNoOverflow(page, '終了担当・記録多数');
  const view = await context.newPage();
  await join(view, appServer, { passphrase, role: 'view' });
  await expect(view.locator('#record-body tr')).toHaveCount(SESSIONS.length);
  await expectNoOverflow(view, '閲覧のみ・記録多数');
  expect((await recordTags(view)).find((r) => r.label === '逆順保存').chips).toEqual([['色', '白'], ['パターン', '縞']]);
  await snap(view, testInfo, 'view-role');
  expect(blocked).toEqual([]);
});
