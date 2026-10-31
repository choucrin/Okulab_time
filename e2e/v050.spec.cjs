// v.05.0(F-15)の Test 工程の受け入れ E2E(RSD F-15-8 の E2E 1〜6)。Firebase はスタブ(e2e/stubs)で、本番には接続しない。
// Ubuntu 上の WebKit/Chromium による端末エミュレーションであり、iOS/iPadOS/Windows 実機の確認ではない。
const fs = require('node:fs');
const { test, expect, seed, join, pageWidth, parseCsv, storedSessions } = require('./support/harness.cjs');
const { expectLongPassage } = require('./support/reading.cjs');

const FAULT = '__okulab_e2e_tx_fault__';
const SETS = 'okulab-time/sequence/sets';
const runKey = (room) => 'okulab-time/sequence/' + room;
const readJson = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
const readRaw = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

// 確認ダイアログ(window.confirm)へ順に応答する。応答の予定が無い確認は取り消し、unexpected に記録する。
function dialogs(page) {
  const queue = [], seen = [], unexpected = [];
  page.on('dialog', async (dialog) => {
    seen.push(dialog.message());
    if (!queue.length) { unexpected.push(dialog.message()); return dialog.dismiss(); }
    if (queue.shift()) await dialog.accept(); else await dialog.dismiss();
  });
  return { answer: (...values) => queue.push(...values), seen, unexpected, pending: () => queue.length };
}

/** 被験者用画面の、読み物以外の表示文字列 */
const participantChrome = (page) => page.locator('#screen-participant').evaluate((e) => {
  const copy = e.cloneNode(true); copy.querySelector('.reading')?.remove(); return copy.textContent.replace(/\s+/g, ' ').trim();
});

async function startAndWait(page, end) {
  await expect(end.locator('#status-label')).toHaveText('待機中');
  await page.click('#btn-start');
  await expect(page.locator('#status-label')).toHaveText('計測中');
  await expect(end.locator('#status-label')).toHaveText('計測中');
}

async function exportCsv(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-csv')]);
  return parseCsv(fs.readFileSync(await download.path(), 'utf8'));
}

async function expectNoOverflow(page, state) {
  const w = await pageWidth(page);
  expect.soft(w.html, `${state}: ${JSON.stringify(w)}`).toBeLessThanOrEqual(w.inner + 1);
  expect.soft(w.body, `${state}: ${JSON.stringify(w)}`).toBeLessThanOrEqual(w.inner + 1);
}

// 要素の中心で最前面にある要素が自身(または子孫)であること = 他の要素に覆われていない
async function expectOnTop(locator, state) {
  await locator.scrollIntoViewIfNeeded();
  const top = await locator.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { ok: Boolean(hit && (hit === e || e.contains(hit))), right: r.right, width: innerWidth };
  });
  expect.soft(top.ok, `${state}: 重なり`).toBe(true);
  expect.soft(top.right, `${state}: 横はみ出し`).toBeLessThanOrEqual(top.width + 1);
}

// #sequence-next が #btn-start の直前で、画面上も間に別の要素が無い
async function expectNextAboveStart(page, state) {
  expect(await page.locator('#btn-start').evaluate((e) => e.previousElementSibling?.id), state).toBe('sequence-next');
  const gap = await page.evaluate(() => {
    const next = document.getElementById('sequence-next').getBoundingClientRect();
    const start = document.getElementById('btn-start').getBoundingClientRect();
    const between = [...document.querySelectorAll('#screen-main button, #screen-main input, #screen-main select, #screen-main a')]
      .filter((e) => e.offsetParent !== null && !e.closest('#sequence-next') && e.id !== 'btn-start')
      .filter((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.top >= next.bottom - 0.5 && r.bottom <= start.top + 0.5; })
      .map((e) => e.id || e.textContent);
    return { nextBottom: next.bottom, startTop: start.top, between };
  });
  expect(gap.nextBottom, state).toBeLessThanOrEqual(gap.startTop + 0.5);
  expect(gap.between, state).toEqual([]);
}

async function addCondition(page, condition, count = 1) {
  await page.fill('#sequence-condition', condition);
  await page.fill('#random-count', String(count));
  await page.click('#random-add');
  await expect(page.locator('#sequence-condition')).toHaveValue('');
}

test('E2E-1(A-68・A-70): 長文10題を手動変更で巡回し、各題の全段落・題別範囲・末尾までの枠内スクロール・字下げを確認', async ({ page, appServer }) => {
  test.setTimeout(300000);
  const passphrase = 'v050-long-all';
  await seed(page, appServer, { passphrase });
  await join(page, appServer, { passphrase, role: 'end' });
  const ids = new Set();
  const { LONG_PASSAGES } = await import('../js/passages-long.js');
  for (let i = 0; i < 10; i++) {
    if (i) {
      await page.click('#btn-change-passage');
      await expect(page.locator('#passage-change-hint')).toContainText('文章を変更しました');
    }
    await page.click('#btn-participant');
    await expectLongPassage(page, expect);
    const first = await page.locator('#passage-text p').first().textContent();
    ids.add(LONG_PASSAGES.find((p) => p.paragraphs[0] === first).id);
    const reading = page.locator('.reading');
    expect(await reading.evaluate((e) => e.scrollTop), '変更後は先頭から').toBe(0);
    const end = await reading.evaluate((e) => { e.scrollTop = e.scrollHeight; return { top: e.scrollTop, max: e.scrollHeight - e.clientHeight }; });
    expect(end.top).toBeGreaterThan(0);
    expect(Math.abs(end.top - end.max)).toBeLessThanOrEqual(1);
    const last = await page.locator('#passage-text p').last().evaluate((p) => {
      const r = p.getBoundingClientRect(), box = p.closest('.reading').getBoundingClientRect();
      return { bottom: r.bottom, boxBottom: box.bottom, indent: getComputedStyle(p).textIndent, size: getComputedStyle(p).fontSize };
    });
    expect(last.bottom, '最終段落が枠内に表示される').toBeLessThanOrEqual(last.boxBottom + 1);
    expect(Math.abs(parseFloat(last.indent) - parseFloat(last.size))).toBeLessThanOrEqual(0.5);
    await expectNoOverflow(page, `長文 ${i + 1}`);
    await page.click('#btn-experimenter');
  }
  expect(ids.size).toBe(10);
});

test('E2E-2・3(A-71・A-72・A-80): 空カタログで条件名だけの赤・白・白点滅×5セットを15回で完了し、記録しない・判定失敗で同じ予定に留まる', async ({ page, context, appServer }) => {
  test.setTimeout(600000);
  const passphrase = 'v050-condition-15';
  const room = await seed(page, appServer, { passphrase, catalog: [] });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  dialogs(page);
  await join(page, appServer, { passphrase, role: 'start' });
  await expect(page.locator('#sequence-next')).toBeHidden(); // 任意方式では表示しない
  await page.locator('#measurement-mode').check();
  await expect(page.locator('#sequence-next')).toBeVisible();
  await expect(page.locator('#sequence-next-body')).toContainText('次の試行はありません');
  await expect(page.locator('#sequence-next-body h3')).toHaveCount(0);
  await page.click('#random-open');
  await expect(page.locator('#random-options')).toContainText('ラベルカタログは空です');
  // 両方空だけを拒否する
  await page.fill('#sequence-condition', '   '); await page.click('#random-add');
  await expect(page.locator('#random-message')).toContainText('ラベルを選ぶか条件名を入力してください');
  await expect(page.locator('#random-items .random-item')).toHaveCount(0);
  for (const c of [' 赤 ', '白', '白点滅']) await addCondition(page, c);
  await page.fill('#sequence-sets', '5');
  await expect(page.locator('#random-total')).toContainText('総試行数: 15');
  await expectNoOverflow(page, '設定ページ');
  await page.click('#random-import');
  const run = await readJson(page, runKey(room));
  expect(run.total).toBe(15);
  expect(run.steps.map((s) => [s.condition, s.tags])).toEqual([['赤', []], ['白', []], ['白点滅', []]]);

  const end = await context.newPage();
  await join(end, appServer, { passphrase, role: 'end' });
  await expect(end.locator('#sequence-next')).toBeHidden(); // 他の役割には表示しない
  await expect(end.locator('#btn-patterns')).toBeHidden();
  const order = ['赤', '白', '白点滅'];
  const retryNo = new Set([1, 8, 15]), failJudge = new Set([2, 8, 15]);
  for (let trial = 1; trial <= 15; trial++) {
    const expected = order[(trial - 1) % 3];
    let tries = retryNo.has(trial) ? 2 : 1;
    while (tries--) {
      await expect(page.locator('#sequence-next-title')).toHaveText('次の試行');
      await expect(page.locator('#sequence-next-body h3')).toHaveText(expected);
      await expect(page.locator('#sequence-next-body')).toContainText(`試行 ${trial} / 15`);
      await expectNextAboveStart(page, `待機中 ${trial}`);
      await startAndWait(page, end);
      await expect(page.locator('#sequence-next-title')).toContainText('現在の試行');
      await expect(page.locator('#sequence-next-body h3')).toHaveText(expected);
      await end.click('#btn-end');
      await expect(page.locator('#random-confirm')).toBeVisible();
      await expect(page.locator('#sequence-next-title')).toContainText('現在の試行');
      await expect(page.locator('#sequence-next-body h3')).toHaveText(expected);
      if (trial === 8 && tries === 0) await expectOnTop(page.locator('#random-yes'), '確認カード');
      const pendingId = (await readJson(page, runKey(room))).pending.id;
      if (failJudge.has(trial) && tries === 0) {
        await page.evaluate((k) => { sessionStorage.setItem(k, JSON.stringify({ code: 'unavailable' })); document.getElementById('random-message').textContent = ''; }, FAULT);
        await page.click('#random-yes');
        await expect(page.locator('#random-message')).not.toBeEmpty();
        await page.evaluate((k) => sessionStorage.removeItem(k), FAULT);
        await expect(page.locator('#random-confirm')).toBeVisible();
        expect((await readJson(page, runKey(room))).done).toBe(trial - 1);
        expect((await storedSessions(page, room)).find((s) => s.id === pendingId).sequenceOutcome ?? null).toBeNull();
        await expect(page.locator('#sequence-next-body h3')).toHaveText(expected);
      }
      await page.click(tries ? '#random-no' : '#random-yes');
      await expect(page.locator('#random-confirm')).toBeHidden();
      await expect.poll(async () => (await readJson(page, runKey(room))).done).toBe(tries ? trial - 1 : trial);
    }
  }
  const finished = await readJson(page, runKey(room));
  expect(finished.status).toBe('completed'); expect(finished.done).toBe(15); expect(finished.attempts).toBe(18);
  // 保存済みの実行を更新する切替は非同期のため、check() の即時判定ではなく最終状態を待つ
  await page.locator('#measurement-mode').click(); await expect(page.locator('#measurement-mode')).toBeChecked();
  await expect(page.locator('#sequence-next-body')).toContainText('完了しました');
  await expect(page.locator('#sequence-next-body h3')).toHaveCount(0);

  const sessions = (await storedSessions(page, room)).filter((s) => s.mode === 'sequence');
  expect(sessions).toHaveLength(18);
  const confirmed = sessions.filter((s) => s.sequenceOutcome === 'confirmed').sort((a, b) => a.sequenceTrial - b.sequenceTrial);
  expect(confirmed.map((s) => s.sequenceCondition)).toEqual(Array.from({ length: 15 }, (_, i) => order[i % 3]));
  expect(confirmed.every((s) => Array.isArray(s.tags) && s.tags.length === 0)).toBe(true);
  expect(sessions.filter((s) => s.sequenceOutcome === 'discarded').map((s) => s.sequenceTrial).sort((a, b) => a - b)).toEqual([1, 8, 15]);

  // 記録一覧: 条件名は「方式 / 判定」列にあり、ラベル列・選択式ラベル列と区別される
  await expect(page.locator('#record-body tr')).toHaveCount(18);
  const rows = await page.locator('#record-body tr').evaluateAll((trs) => trs.map((tr) => [tr.cells[0].textContent, tr.cells[2].textContent, tr.cells[3].textContent]));
  for (const [label, tags, method] of rows) {
    expect(method).toMatch(/^順序反復 \/ (有効|順序反復試行内のエラーデータ)\s*条件名: (赤|白|白点滅)$/);
    expect(label).not.toMatch(/赤|白/); expect(tags).not.toMatch(/赤|白/);
  }
  const csv = (await exportCsv(page)).filter((r) => r.mode === '順序反復');
  expect(csv).toHaveLength(18);
  expect(Object.keys(csv[0]).at(-1)).toBe('sequence_condition');
  const csvConfirmed = csv.filter((r) => r.sequence_outcome === '有効').sort((a, b) => a.sequence_trial - b.sequence_trial);
  expect(csvConfirmed.map((r) => r.sequence_condition)).toEqual(Array.from({ length: 15 }, (_, i) => order[i % 3]));
  expect(csv.every((r) => r.tags === '' && !/赤|白/.test(r.label))).toBe(true);
  expect(errors).toEqual([]);
});

test('E2E-2・6(A-71・A-72・A-79・A-81): 80文字の条件名と20ラベルが折り返して全文読め、中断・他役割・被験者用画面で古い条件を示さない', async ({ page, context, appServer }) => {
  test.setTimeout(300000);
  const passphrase = 'v050-next-long';
  const catalog = Array.from({ length: 20 }, (_, i) => ({ name: `ジャンル${String(i + 1).padStart(2, '0')}`, items: [`長いラベル項目${i + 1}`.padEnd(30, '項')] }));
  const room = await seed(page, appServer, { passphrase, catalog });
  const ui = dialogs(page);
  await join(page, appServer, { passphrase, role: 'start' });
  await page.locator('#measurement-mode').check(); await page.click('#random-open');
  const boxes = page.locator('#random-options input[type="checkbox"]');
  await expect(boxes).toHaveCount(20);
  for (let i = 0; i < 20; i++) await boxes.nth(i).check();
  const condition = '条件' + 'あ'.repeat(77) + '終';
  expect([...condition].length).toBe(80);
  await addCondition(page, condition);
  await addCondition(page, '二番目');
  await page.fill('#sequence-sets', '2');
  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await expectNoOverflow(page, `設定ページ ${width}px`);
  }
  await page.click('#random-import');
  const body = page.locator('#sequence-next-body');
  await expect(body.locator('h3')).toHaveText(condition);
  await expect(body.locator('.tag-chip')).toHaveCount(20);
  for (const g of catalog) await expect(body).toContainText(g.items[0]);
  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await expectNoOverflow(page, `次の試行 ${width}px`);
    await expectNextAboveStart(page, `次の試行 ${width}px`);
    await expectOnTop(page.locator('#btn-start'), `開始ボタン ${width}px`);
    const wrap = await body.locator('h3').evaluate((h) => ({ sw: h.scrollWidth, cw: h.clientWidth }));
    expect(wrap.sw, `条件名の折り返し ${width}px`).toBeLessThanOrEqual(wrap.cw + 1);
  }
  // 他役割・被験者用画面には表示しない
  const view = await context.newPage();
  await join(view, appServer, { passphrase, role: 'view' });
  await expect(view.locator('#sequence-next')).toBeHidden();
  await expect(view.locator('#btn-patterns')).toBeHidden();
  expect(await view.locator('body').innerText()).not.toMatch(/あああ|二番目/);
  const end = await context.newPage();
  await join(end, appServer, { passphrase, role: 'end' });
  await end.click('#btn-participant');
  await expect(end.locator('#sequence-next')).toBeHidden();
  await expect(end.locator('#btn-patterns')).toBeHidden();
  expect(await participantChrome(end)).not.toMatch(/あああ|二番目|ジャンル|長いラベル|パターン/);
  // 中断: 古い条件を次の試行として示さない
  ui.answer(true);
  await page.click('#random-interrupt');
  await expect(page.locator('#measurement-mode')).not.toBeChecked();
  await expect(page.locator('#sequence-next')).toBeHidden();
  await page.locator('#measurement-mode').click(); await expect(page.locator('#measurement-mode')).toBeChecked();
  await expect(body).toContainText('中断しました');
  await expect(body.locator('h3')).toHaveCount(0);
  await expect(body).not.toContainText('あああ');
  expect((await readJson(page, runKey(room))).status).toBe('interrupted');
  expect(ui.unexpected).toEqual([]);
});

test('E2E-4(A-73・A-74): 旧ランダム設定UIが無く、旧キー(確認待ち・破損)が残っても順序反復が完了し、旧キーと過去のランダム記録を保持する', async ({ page, context, appServer }) => {
  test.setTimeout(300000);
  for (const [variant, legacyRun] of [['確認待ち', JSON.stringify({ v: 1, id: 'legacy-batch', status: 'active', pending: { id: 'r-unsettled', payload: { mode: 'random', tags: ['色:白'] } }, done: 1, total: 3 })], ['破損', '{broken']]) {
    const passphrase = `v050-legacy-${variant === '破損' ? 'broken' : 'pending'}`;
    const base = Date.UTC(2026, 8, 1, 1, 0, 0);
    const legacy = [['r-valid', 'confirmed'], ['r-error', 'discarded'], ['r-unsettled', null]].map(([id, outcome], i) => ({
      id, status: 'done', label: '旧' + i, tags: ['色:白'], mode: 'random', randomBatchId: 'legacy-batch', randomOutcome: outcome,
      startMs: base + i * 60000, startRawMs: base + i * 60000, startOffsetMs: 0, startAccuracyMs: 5, startSynced: true, startedBy: 'old',
      endMs: base + i * 60000 + 2000, endRawMs: base + i * 60000 + 2000, endOffsetMs: 0, endAccuracyMs: 5, endSynced: true, endedBy: 'old',
      durationMs: 2000, durationSec: 2,
    }));
    const room = await seed(page, appServer, { passphrase, catalog: [{ name: '色', items: ['白'] }], sessions: legacy });
    const legacySets = JSON.stringify([{ name: '旧設定', items: [{ tags: ['色:白'], count: 2 }] }]);
    await page.evaluate(({ room, legacySets, legacyRun }) => {
      localStorage.setItem('okulab-time/random/sets', legacySets);
      localStorage.setItem('okulab-time/random/' + room, legacyRun);
    }, { room, legacySets, legacyRun });
    const errors = [];
    const onError = (e) => errors.push(e.message); page.on('pageerror', onError);
    await join(page, appServer, { passphrase, role: 'start' });
    await expect(page.locator('[id^="legacy"]')).toHaveCount(0);
    expect(await page.locator('#screen-main').innerText()).not.toMatch(/旧ランダム|旧設定|ランダム設定/);
    // 過去のランダム記録の一覧・CSV
    await expect(page.locator('#record-body tr')).toHaveCount(3);
    const methods = await page.locator('#record-body tr').evaluateAll((trs) => trs.map((tr) => tr.cells[3].textContent).sort());
    expect(methods).toEqual(['ランダム / ランダム試行内のエラーデータ', 'ランダム / 有効', 'ランダム / 未確定'].sort());
    const csv = await exportCsv(page);
    expect(csv.map((r) => [r.session_id, r.mode, r.random_batch_id, r.random_outcome]).sort()).toEqual([
      ['r-error', 'ランダム', 'legacy-batch', 'ランダム試行内のエラーデータ'], ['r-unsettled', 'ランダム', 'legacy-batch', '未確定'], ['r-valid', 'ランダム', 'legacy-batch', '有効'],
    ]);
    // 順序反復の確定・開始・判定・完了
    await page.locator('#measurement-mode').check(); await page.click('#random-open');
    await page.locator('#random-options input').check(); await page.click('#random-add');
    await page.click('#random-import');
    const end = await context.newPage();
    await join(end, appServer, { passphrase, role: 'end' });
    await startAndWait(page, end);
    await end.click('#btn-end');
    await expect(page.locator('#random-confirm')).toBeVisible();
    await page.click('#random-yes');
    await expect.poll(async () => (await readJson(page, runKey(room))).status).toBe('completed');
    await page.reload(); await expect(page.locator('#screen-main')).toBeVisible();
    await expect(page.locator('#record-body tr')).toHaveCount(4);
    expect(await readRaw(page, 'okulab-time/random/sets')).toBe(legacySets);
    expect(await readRaw(page, 'okulab-time/random/' + room)).toBe(legacyRun);
    const unsettled = (await storedSessions(page, room)).find((s) => s.id === 'r-unsettled');
    expect(unsettled.randomOutcome).toBeNull();
    expect(errors, variant).toEqual([]);
    page.off('pageerror', onError);
    await end.close();
  }
});

test('E2E-5・6(A-75〜A-79・A-81): 管理ダイアログで編集・並べ替え・検証・衝突・書込失敗・2タブ競合・削除、実行中の実行と分離', async ({ page, context, appServer }) => {
  test.setTimeout(600000);
  const passphrase = 'v050-manage';
  const catalog = [{ name: '色', items: ['白', '赤'] }];
  const room = await seed(page, appServer, { passphrase, catalog, sessions: [] });
  // A はラベルだけの既存形式(condition 無し)を含む
  const initial = [
    { name: 'A', steps: [{ tags: ['色:白'], count: 1 }, { tags: [], condition: '赤', count: 2 }], sets: 2 },
    { name: 'B', steps: [{ tags: ['色:赤'], condition: '青', count: 1 }], sets: 1 },
  ];
  await page.evaluate(({ k, v }) => localStorage.setItem(k, JSON.stringify(v)), { k: SETS, v: initial });
  const ui = dialogs(page);
  await join(page, appServer, { passphrase, role: 'start' });
  const dlg = page.locator('#patterns-dialog'), list = page.locator('#patterns-list'), msg = page.locator('#patterns-message');
  const field = (name) => dlg.getByLabel(name, { exact: true });
  const button = (name) => dlg.getByRole('button', { name, exact: true });
  const stored = () => readJson(page, SETS);

  // 入口と開閉(閉じる・Esc・フォーカス復帰)。閉じているときは場所を取らない
  await expect(page.locator('#btn-patterns')).toBeVisible();
  expect(await page.locator('#btn-patterns').evaluate((b) => Boolean(b.closest('header')))).toBe(true);
  await expect(dlg).toBeHidden();
  await page.click('#btn-patterns'); await expect(dlg).toBeVisible();
  await expect(list.locator('.random-item')).toHaveCount(2);
  await expect(list).toContainText('A：条件 2・1セット 3 回・2 セット・総試行数 6 回');
  await page.keyboard.press('Escape'); await expect(dlg).toBeHidden();
  await expect(page.locator('#btn-patterns')).toBeFocused();
  await page.click('#btn-patterns'); await page.click('#patterns-close');
  await expect(dlg).toBeHidden(); await expect(page.locator('#btn-patterns')).toBeFocused();

  // 編集前の値の表示とキャンセル
  await page.click('#btn-patterns'); await button('「A」を編集').click();
  await expect(field('保存名(40文字まで)')).toHaveValue('A');
  await expect(field('条件 1 の条件名(80文字まで)')).toHaveValue('');
  await expect(field('条件 2 の条件名(80文字まで)')).toHaveValue('赤');
  await expect(field('条件 1 の実施回数')).toHaveValue('1');
  await expect(field('条件 2 の実施回数')).toHaveValue('2');
  await expect(field('セット反復回数')).toHaveValue('2');
  await expect(dlg.locator('fieldset').nth(0).getByLabel('色: 白')).toBeChecked();
  await expect(dlg.locator('fieldset').nth(1).getByLabel('色: 白')).not.toBeChecked();
  await field('保存名(40文字まで)').fill('取消される名前');
  await field('条件 2 の条件名(80文字まで)').fill('取消');
  await button('キャンセル').click();
  await expect(page.locator('#patterns-editor')).toBeHidden();
  expect(await stored()).toEqual(initial);

  // 編集・並べ替え・追加・削除・セット数・名前変更 → 保存
  await button('「A」を編集').click();
  await field('条件 1 の条件名(80文字まで)').fill(' 白条件 ');
  await button('条件 2 を上へ').click();
  await expect(field('条件 1 の条件名(80文字まで)')).toHaveValue('赤');
  await button('条件を追加').click(); await button('条件を追加').click();
  await field('条件 3 の条件名(80文字まで)').fill('緑');
  await dlg.locator('fieldset').nth(2).getByLabel('色: 赤').check();
  await field('条件 3 の実施回数').fill('3');
  await button('条件 4 を削除').click();
  await expect(dlg.locator('fieldset')).toHaveCount(3);
  await field('セット反復回数').fill('3');
  await field('保存名(40文字まで)').fill('A2');
  await expect(dlg.locator('[data-pattern-total]')).toHaveText('1セット 6 回・3 セット・総試行数 18 回');
  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 740 });
    await expectNoOverflow(page, `管理ダイアログ編集 ${width}px`);
    const box = await dlg.evaluate((d) => ({ sw: d.scrollWidth, cw: d.clientWidth, right: d.getBoundingClientRect().right, inner: innerWidth }));
    expect.soft(box.sw, `ダイアログ内の横はみ出し ${width}px`).toBeLessThanOrEqual(box.cw + 1);
    expect.soft(box.right, `ダイアログの位置 ${width}px`).toBeLessThanOrEqual(box.inner + 1);
    await expectOnTop(button('保存'), `保存ボタン ${width}px`);
    await expectOnTop(page.locator('#patterns-close'), `閉じるボタン ${width}px`);
  }
  await button('保存').click();
  await expect(msg).toContainText('保存しました');
  const edited = [
    { name: 'A2', steps: [{ tags: [], condition: '赤', count: 2 }, { tags: ['色:白'], condition: '白条件', count: 1 }, { tags: ['色:赤'], condition: '緑', count: 3 }], sets: 3 },
    initial[1],
  ];
  expect(await stored()).toEqual(edited);
  await expect(page.locator('#random-saved option')).toHaveText(['A2', 'B']);
  await expectNoOverflow(page, '管理ダイアログ一覧');
  await page.click('#patterns-close');

  // 再読み込み後も保持
  await page.reload(); await expect(page.locator('#screen-main')).toBeVisible();
  await page.click('#btn-patterns');
  await expect(list).toContainText('A2：条件 3・1セット 6 回・3 セット・総試行数 18 回');

  // 不正値(空名・内容未指定・不正回数・上限超過)は保存せず成功表示もしない
  for (const [label, value, error] of [
    ['保存名(40文字まで)', '  ', /名|入力/], ['条件 1 の条件名(80文字まで)', '', /ラベルを選ぶか条件名/],
    ['条件 1 の条件名(80文字まで)', 'x'.repeat(81), /80文字/], ['条件 2 の実施回数', '0', /実施回数/], ['条件 2 の実施回数', '51', /実施回数/],
    ['条件 2 の実施回数', '1.5', /実施回数/], ['セット反復回数', '101', /セット数/], ['セット反復回数', 'x', /セット数/],
  ]) {
    await button('「A2」を編集').click();
    await field(label).fill(value);
    await button('保存').click();
    await expect(msg, `${label}=${value}`).toHaveText(error);
    await expect(msg).not.toContainText('保存しました');
    await expect(field(label)).toHaveValue(value); // 編集中の内容を保持
    expect(await stored()).toEqual(edited);
    await button('キャンセル').click();
  }
  // 上限超過(総試行数 1000 回を超える)
  await button('「A2」を編集').click();
  await field('条件 3 の実施回数').fill('50'); await field('セット反復回数').fill('100');
  await button('保存').click();
  await expect(msg).toContainText('1000回まで'); expect(await stored()).toEqual(edited);
  await button('キャンセル').click();

  // 名前衝突: 取消で両方保持、承認で上書き
  await button('「B」を編集').click();
  await field('保存名(40文字まで)').fill('A2');
  ui.answer(false); await button('保存').click();
  await expect.poll(() => ui.seen.length).toBe(1);
  expect(ui.seen[0]).toContain('「A2」は既に保存されています');
  await expect(msg).not.toContainText('保存しました');
  expect(await stored()).toEqual(edited);
  await button('キャンセル').click();

  // setItem 失敗: 元データを保持し成功表示しない
  await button('「B」を編集').click();
  await field('条件 1 の条件名(80文字まで)').fill('失敗する編集');
  await page.evaluate((k) => {
    const original = Storage.prototype.setItem;
    window.__restoreSetItem = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function (key, value) { if (key === k) throw new DOMException('quota', 'QuotaExceededError'); return original.call(this, key, value); };
  }, SETS);
  await button('保存').click();
  await expect(msg).toContainText('保存できませんでした');
  await expect(field('条件 1 の条件名(80文字まで)')).toHaveValue('失敗する編集');
  await page.evaluate(() => window.__restoreSetItem());
  expect(await stored()).toEqual(edited);
  await button('キャンセル').click();

  // 2タブの競合: 他方の変更・削除後、古い編集の保存は拒否される
  const other = await context.newPage();
  const otherUi = dialogs(other);
  await join(other, appServer, { passphrase, role: 'start' });
  await other.click('#btn-patterns');
  await other.locator('#patterns-dialog').getByRole('button', { name: '「B」を編集', exact: true }).click();
  await button('「B」を編集').click();
  await field('条件 1 の条件名(80文字まで)').fill('先に保存');
  await button('保存').click(); await expect(msg).toContainText('保存しました');
  const afterFirst = await stored();
  await other.locator('#patterns-dialog').getByLabel('条件 1 の条件名(80文字まで)', { exact: true }).fill('古い編集');
  await other.locator('#patterns-dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(other.locator('#patterns-message')).toContainText('別のタブで変更または削除されました');
  expect(await stored()).toEqual(afterFirst);
  expect(afterFirst[1].steps[0].condition).toBe('先に保存');
  await other.locator('#patterns-dialog').getByRole('button', { name: 'キャンセル', exact: true }).click();
  await other.locator('#patterns-dialog').getByRole('button', { name: '「A2」を編集', exact: true }).click();
  ui.answer(true); await button('「B」を削除').click(); await expect(msg).toContainText('削除しました');
  await page.click('#patterns-close');
  // 削除された B を参照しない編集(A2)は保存でき、削除済みの B は復活しない
  await other.locator('#patterns-dialog').getByLabel('セット反復回数', { exact: true }).fill('4');
  await other.locator('#patterns-dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(other.locator('#patterns-message')).toContainText('保存しました');
  expect((await stored()).map((e) => [e.name, e.sets])).toEqual([['A2', 4]]);
  expect(otherUi.seen).toEqual([]);
  await other.close();
  ui.seen.length = 0;
  expect(ui.pending()).toBe(0);

  // 呼び出して計測に使い、実行元パターンを編集・削除しても実行は変わらない
  await page.reload(); await expect(page.locator('#screen-main')).toBeVisible();
  await page.locator('#measurement-mode').check();
  await page.selectOption('#random-saved', 'A2'); await page.click('#random-load');
  await expect(page.locator('#sequence-next-body h3')).toHaveText('赤');
  const frozen = await readRaw(page, runKey(room));
  const nextText = await page.locator('#sequence-next-body').textContent();
  await page.click('#btn-patterns'); await button('「A2」を編集').click();
  await field('条件 1 の条件名(80文字まで)').fill('編集後の赤'); await field('保存名(40文字まで)').fill('A3');
  await button('保存').click(); await expect(msg).toContainText('実行中の順序反復には影響しません');
  await expect(page.locator('#status-label')).toHaveText('待機中'); // 保存だけで計測を開始しない
  expect(await readRaw(page, runKey(room))).toBe(frozen);
  await page.click('#patterns-close');
  await expect(page.locator('#sequence-next-body')).toHaveText(nextText);
  const end = await context.newPage();
  await join(end, appServer, { passphrase, role: 'end' });
  await expect(end.locator('#btn-patterns')).toBeHidden();
  await startAndWait(page, end);
  // 計測中・判定待ちは保存・削除が無効で理由を示す
  await page.click('#btn-patterns');
  await expect(page.locator('#patterns-lock')).toContainText('計測と判定が終わるまで');
  await expect(button('「A3」を削除')).toBeDisabled();
  await button('「A3」を編集').click(); await expect(button('保存')).toBeDisabled();
  await button('キャンセル').click(); await page.click('#patterns-close');
  await end.click('#btn-end');
  await expect(page.locator('#random-confirm')).toBeVisible();
  await page.click('#btn-patterns');
  await expect(button('「A3」を削除')).toBeDisabled();
  await page.click('#patterns-close');
  await page.click('#random-yes');
  await expect.poll(async () => (await readJson(page, runKey(room))).done).toBe(1);
  const [trial1] = (await storedSessions(page, room)).filter((s) => s.mode === 'sequence');
  expect(trial1.sequenceCondition).toBe('赤');
  await expect(page.locator('#sequence-next-body h3')).toHaveText('赤'); // 2回目も実行時点の「赤」
  const progress = await readJson(page, runKey(room));

  // 削除: 取消で保持、承認で削除、最後の1件で空状態。記録・カタログは変わらない
  const before = { sessions: await storedSessions(page, room), catalog: await readRaw(page, 'okulab-time/catalog') };
  await page.click('#btn-patterns');
  ui.answer(false); await button('「A3」を削除').click();
  await expect.poll(() => ui.seen.length).toBe(1);
  expect(ui.seen[0]).toContain('「A3」を削除しますか');
  expect((await stored()).map((e) => e.name)).toEqual(['A3']);
  ui.answer(true); await button('「A3」を削除').click();
  await expect(msg).toContainText('削除しました');
  await expect(list).toHaveText('保存済みパターンはありません');
  expect(await stored()).toEqual([]);
  await page.click('#patterns-close');
  await expect(page.locator('#random-saved-empty')).toBeVisible();
  await expect(page.locator('#random-load')).toBeDisabled();
  expect(await readJson(page, runKey(room))).toEqual(progress);
  expect(await storedSessions(page, room)).toEqual(before.sessions);
  expect(await readRaw(page, 'okulab-time/catalog')).toBe(before.catalog);
  await expect(page.locator('#sequence-next-body h3')).toHaveText('赤');
  // 被験者用画面(計測終了端末)に管理機能・保存パターン・条件を出さない
  await end.click('#btn-participant');
  await expect(end.locator('#btn-patterns')).toBeHidden();
  expect(await participantChrome(end)).not.toMatch(/パターン|赤|A3/);
  expect(ui.pending()).toBe(0);
  expect(ui.unexpected).toEqual([]);
});
