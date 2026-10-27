// v.04.1(F-14)の Test 工程の受け入れ E2E。Firebase はスタブ(e2e/stubs)で、本番には接続しない。
// Ubuntu 上の WebKit/Chromium による端末エミュレーションであり、iOS/iPadOS/Windows 実機の確認ではない。
const { test, expect, seed, join, pageWidth, storedSessions, roomIdFor } = require('./support/harness.cjs');

const { expectLongPassage } = require('./support/reading.cjs');

const FAULT = '__okulab_e2e_tx_fault__';
const CURRENT = 'okulab-time/reading-current';

async function press(page, isMobile) {
  if (isMobile) await page.locator('#btn-detect').tap();
  else await page.click('#btn-detect');
}
const scrollOf = (page) => page.locator('.reading').evaluate((e) => e.scrollTop);
const textOf = (page) => page.locator('#passage-text').textContent();
async function scrollTo(page, ratio) {
  return page.locator('.reading').evaluate((e, r) => { e.scrollTop = Math.floor((e.scrollHeight - e.clientHeight) * r); return e.scrollTop; }, ratio);
}
/** 被験者用画面の、読み物以外の表示文字列 */
const participantChrome = (page) => page.locator('#screen-participant').evaluate((e) => {
  const copy = e.cloneNode(true); copy.querySelector('.reading').remove(); return copy.textContent.replace(/\s+/g, ' ').trim();
});

async function joinById(page, appServer, { input, role }) {
  await page.goto(`${appServer}/__blank`);
  await page.evaluate(() => localStorage.removeItem('okulab-time/session'));
  await page.goto(`${appServer}/index.html`);
  await expect(page.locator('#screen-join')).toBeVisible();
  await page.locator('input[name="join-method"][value="roomId"]').check();
  await page.fill('#input-room', input);
  await page.locator(`input[name="role"][value="${role}"]`).check();
  await page.click('#btn-join');
}

test('A-47〜A-53・A-63: 停止で文章不変、往復で保持、計測中は変更不可、手動変更で先頭から、再読み込みで維持', async ({ page, context, appServer, blocked, isMobile }) => {
  const passphrase = 'v041-reading';
  const room = await seed(page, appServer, { passphrase });
  await join(page, appServer, { passphrase, role: 'end' });
  // A-63: 文章変更・ルームID欄は実験者用画面にある
  await expect(page.locator('#btn-change-passage')).toBeVisible();
  await expect(page.locator('#btn-change-passage')).toBeEnabled();
  await expect(page.locator('#passage-change-hint')).toHaveText('次に被験者用画面を開いたとき、新しい文章を先頭から表示します。');
  await expect(page.locator('#room-id-panel')).toBeVisible();

  await page.click('#btn-participant');
  await expectLongPassage(page, expect);
  const before = await textOf(page);
  const shownKey = 'okulab-time/passages/long';
  const shown = () => page.evaluate(({ k, room }) => JSON.parse(localStorage.getItem(k))[room], { k: shownKey, room });
  const shownAtStart = await shown();
  expect(shownAtStart).toHaveLength(1);
  // A-63: 被験者用画面に文章変更・ルームID・省略表示・新しい説明が無い
  for (const id of ['#btn-change-passage', '#passage-change-hint', '#room-id-panel', '#room-id-full', '#pill-room', '#btn-copy-room-id']) {
    await expect(page.locator(id)).toBeHidden();
  }
  expect(await participantChrome(page)).not.toMatch(/文章を変更|ルームID|room|計測中|待機中|記録/);
  const chrome = await participantChrome(page);

  // A-48: 待機中の停止・連打で文章もスクロールも変わらない
  const idle = await scrollTo(page, 0.4);
  expect(idle).toBeGreaterThan(0);
  for (let i = 0; i < 4; i++) await press(page, isMobile);
  await page.waitForTimeout(300);
  expect(await textOf(page)).toBe(before);
  expect(await scrollOf(page)).toBe(idle);
  expect(await participantChrome(page)).toBe(chrome);

  // A-47・A-49: 計測中の停止で計測は終了・記録され、文章と scrollTop は不変
  const start = await context.newPage();
  await join(start, appServer, { passphrase, role: 'start' });
  await start.click('#btn-start');
  await expect(start.locator('#status-label')).toHaveText('計測中');
  await page.bringToFront();
  const mid = await scrollTo(page, 0.5);
  await press(page, isMobile);
  await expect(start.locator('#status-label')).toHaveText('待機中');
  await expect(start.locator('#record-count')).toHaveText('1');
  const [rec] = await storedSessions(page, room);
  expect(typeof rec.durationMs).toBe('number');
  expect(rec.durationMs).toBeGreaterThan(0);
  // 連打の残り(待機中の押下)も含めて記録は 1 件だけ
  for (let i = 0; i < 3; i++) await press(page, isMobile);
  await page.waitForTimeout(300);
  expect(await storedSessions(page, room)).toHaveLength(1);
  expect(await textOf(page)).toBe(before);
  expect(await scrollOf(page)).toBe(mid);
  expect(await participantChrome(page)).toBe(chrome);
  expect(await shown()).toEqual(shownAtStart);

  // A-48: 通信失敗(スタブで終了の書き込みを拒否)でも文章・表示は不変、失敗は実験者用画面に計数
  await start.click('#btn-start');
  await expect(start.locator('#status-label')).toHaveText('計測中');
  await page.bringToFront();
  await expect(page.locator('#status-label')).toHaveText('計測中');
  await page.evaluate((k) => sessionStorage.setItem(k, JSON.stringify({ code: 'permission-denied' })), FAULT);
  await press(page, isMobile);
  await page.waitForTimeout(500);
  expect(await textOf(page)).toBe(before);
  expect(await scrollOf(page)).toBe(mid);
  expect(await participantChrome(page)).toBe(chrome);
  await expect(page.locator('#toast')).toBeHidden();
  await page.evaluate((k) => sessionStorage.removeItem(k), FAULT);

  // A-50・A-53: 計測中に実験者用画面へ切り替えても本文不変、文章変更は無効で理由を表示
  await page.click('#btn-experimenter');
  await expect(page.locator('#screen-main')).toBeVisible();
  // 待機中の押下 7 件は既存仕様どおり「記録できませんでした」、注入した通信失敗 1 件は「確認できませんでした」に計数される
  await expect(page.locator('#conn-error')).toContainText('被験者用画面での操作を 7 件記録できませんでした');
  await expect(page.locator('#conn-error')).toContainText('被験者用画面での操作 1 件は、記録できたかどうか確認できませんでした');
  await expect(page.locator('#btn-change-passage')).toBeDisabled();
  await expect(page.locator('#passage-change-hint')).toHaveText('計測中は文章を変更できません。計測の終了後に操作してください。');
  await page.locator('#btn-change-passage').click({ force: true });
  expect(await textOf(page)).toBe(before);
  // 無効時のクリック時再確認(disabled を外して押しても変わらない)
  await page.evaluate(() => { const b = document.getElementById('btn-change-passage'); b.disabled = false; b.click(); });
  expect(await textOf(page)).toBe(before);
  expect(await shown()).toEqual(shownAtStart);
  await expect(start.locator('#status-label')).toHaveText('計測中');

  // A-52: 手動変更なしの往復では同じ文章とスクロール位置
  await page.click('#btn-participant');
  await expect(page.locator('#screen-participant')).toBeVisible();
  expect(await textOf(page)).toBe(before);
  expect(await scrollOf(page)).toBe(mid);
  await press(page, isMobile);
  await expect(start.locator('#status-label')).toHaveText('待機中');
  await expect(start.locator('#record-count')).toHaveText('2');
  expect(await textOf(page)).toBe(before);
  expect(await scrollOf(page)).toBe(mid);

  // A-53: 終了処理中(送信を遅延)は変更できない
  await page.click('#btn-experimenter');
  await start.click('#btn-start');
  await expect(page.locator('#status-label')).toHaveText('計測中');
  await page.evaluate((k) => sessionStorage.setItem(k, JSON.stringify({ delayMs: 1500 })), FAULT);
  await page.click('#btn-end');
  await expect(page.locator('#passage-change-hint')).toHaveText('処理中は文章を変更できません。');
  await expect(page.locator('#btn-change-passage')).toBeDisabled();
  await page.evaluate((k) => sessionStorage.removeItem(k), FAULT);
  await expect(start.locator('#status-label')).toHaveText('待機中');
  await expect(page.locator('#btn-change-passage')).toBeEnabled();
  expect(await textOf(page)).toBe(before);

  // A-51: 待機中の手動変更 → 被験者用画面で新しい文章を先頭から。既出記録に追加。計測状態・記録は不変
  const sessionsBefore = await storedSessions(page, room);
  const currentBefore = await page.evaluate((room) => JSON.parse(localStorage.getItem('__okulab_e2e_firestore__'))[`rooms/${room}/meta/current`] ?? null, room);
  await page.click('#btn-change-passage');
  await page.click('#btn-participant');
  await expect(page.locator('#passage-text')).not.toHaveText(before);
  await expectLongPassage(page, expect);
  expect(await scrollOf(page)).toBe(0);
  const changed = await textOf(page);
  const shownAfter = await shown();
  expect(shownAfter).toHaveLength(2);
  expect(shownAfter[0]).toBe(shownAtStart[0]);
  const savedId = await page.evaluate(({ k, room }) => JSON.parse(localStorage.getItem(k)).long[room], { k: CURRENT, room });
  expect(savedId).toBe(shownAfter[1]);
  expect(await storedSessions(page, room)).toEqual(sessionsBefore);
  expect(await page.evaluate((room) => JSON.parse(localStorage.getItem('__okulab_e2e_firestore__'))[`rooms/${room}/meta/current`] ?? null, room)).toEqual(currentBefore);
  await expect(start.locator('#status-label')).toHaveText('待機中');
  await expect(start.locator('#record-count')).toHaveText(String(sessionsBefore.length));
  expect(sessionsBefore).toHaveLength(3);

  // F-14-1-6: 被験者用画面のまま再読み込みしても同じ文章(先頭から)
  await scrollTo(page, 0.3);
  await page.reload();
  await expect(page.locator('#screen-participant')).toBeVisible();
  await expectLongPassage(page, expect);
  expect(await textOf(page)).toBe(changed);
  expect(await shown()).toEqual(shownAfter);
  expect(blocked).toEqual([]);
});

test('A-53: 順序反復の実行中は文章変更が無効で、手動変更は進捗・判定を変えない', async ({ page, context, appServer }) => {
  const passphrase = 'v041-sequence';
  const room = await seed(page, appServer, { passphrase, catalog: [{ name: '色', items: ['白', '赤'] }] });
  await join(page, appServer, { passphrase, role: 'start' });
  await page.locator('#measurement-mode').check();
  await page.click('#random-open');
  await page.locator('#random-options label').filter({ hasText: '白' }).locator('input').check();
  await page.fill('#random-count', '1'); await page.click('#random-add');
  await page.locator('#random-options label').filter({ hasText: '赤' }).locator('input').check();
  await page.fill('#random-count', '1'); await page.click('#random-add');
  await page.fill('#sequence-sets', '1'); await page.click('#random-import');
  const saved = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), 'okulab-time/sequence/' + room);
  expect((await saved()).total).toBe(2);
  const end = await context.newPage();
  await join(end, appServer, { passphrase, role: 'end' });
  await end.click('#btn-participant');
  const first = await textOf(end);
  await end.click('#btn-experimenter');

  await page.bringToFront();
  await page.click('#btn-start');
  await expect(end.locator('#status-label')).toHaveText('計測中');
  await expect.poll(async () => (await saved()).pending?.payload.sequenceTrial).toBe(1);
  const during = await saved();
  const progress = await page.locator('#random-progress').textContent();
  await expect(end.locator('#btn-change-passage')).toBeDisabled();
  await end.evaluate(() => { const b = document.getElementById('btn-change-passage'); b.disabled = false; b.click(); });
  expect(await textOf(end)).toBe(first);
  expect(await saved()).toEqual(during);
  await expect(page.locator('#random-progress')).toHaveText(progress);

  await end.click('#btn-end');
  await expect(page.locator('#random-confirm')).toBeVisible();
  await expect(end.locator('#btn-change-passage')).toBeEnabled();
  const confirming = await saved();
  await end.click('#btn-change-passage');
  await end.click('#btn-change-passage');   // 連続押下も既出管理に従って選び直すだけ
  expect(await saved()).toEqual(confirming);
  await expect(page.locator('#random-confirm')).toBeVisible();
  await page.click('#random-yes');
  await expect.poll(async () => (await saved()).done).toBe(1);
  expect((await saved()).attempts).toBe(1);
  await end.click('#btn-participant');
  await expect(end.locator('#passage-text')).not.toHaveText(first);
  expect(await scrollOf(end)).toBe(0);
  const shown = await end.evaluate((room) => JSON.parse(localStorage.getItem('okulab-time/passages/long'))[room], room);
  expect(shown).toHaveLength(3);
});

test('A-54・A-55: 段落の1行目だけを本文文字サイズの1文字分字下げし、原文を変えない', async ({ page, appServer }) => {
  const passphrase = 'v041-indent';
  await seed(page, appServer, { passphrase });
  await join(page, appServer, { passphrase, role: 'end' });
  await page.click('#btn-participant');
  await expectLongPassage(page, expect);
  const measure = () => page.locator('#passage-text').evaluate((root) => {
    const ps = [...root.querySelectorAll('p')];
    const styles = ps.map((p) => { const s = getComputedStyle(p); return { indent: parseFloat(s.textIndent), font: parseFloat(s.fontSize) }; });
    const p = ps.find((x) => x.getClientRects().length && x.getBoundingClientRect().height > parseFloat(getComputedStyle(x).lineHeight || '0') * 2.5) ?? ps[0];
    const node = p.firstChild;
    const box = p.getBoundingClientRect();
    const contentLeft = box.left + parseFloat(getComputedStyle(p).paddingLeft) + parseFloat(getComputedStyle(p).borderLeftWidth);
    const rect = (i) => { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1); return r.getClientRects()[0]; };
    const r0 = rect(0);
    let second = null;
    for (let i = 1; i < node.length - 1; i++) {
      const r = rect(i);
      if (r && r.top > r0.top + r0.height / 2) { second = r; break; }
    }
    return { styles, firstOffset: r0.left - contentLeft, secondOffset: second ? second.left - contentLeft : null,
      font: parseFloat(getComputedStyle(p).fontSize), multi: Boolean(second) };
  });
  const check = async () => {
    const m = await measure();
    for (const s of m.styles) expect(Math.abs(s.indent - s.font)).toBeLessThanOrEqual(0.5);
    expect(m.multi).toBe(true);
    expect(Math.abs(m.firstOffset - m.font)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(m.secondOffset)).toBeLessThanOrEqual(1.5);
    return m;
  };
  const base = await check();
  await page.locator('#passage-text').evaluate((e) => { e.style.fontSize = '31px'; });
  const big = await check();
  expect(big.font).toBe(31);
  expect(big.font).not.toBe(base.font);
  await page.locator('#passage-text').evaluate((e) => { e.style.fontSize = ''; });
  // 本文以外には適用しない
  for (const sel of ['#btn-detect', '#btn-experimenter', '.reading', '#passage-text']) {
    expect(await page.locator(sel).evaluate((e) => getComputedStyle(e).textIndent)).toBe('0px');
  }
  await page.click('#btn-experimenter');
  for (const sel of ['#btn-change-passage', '#btn-participant', '#passage-change-hint', '.records__title']) {
    expect(await page.locator(sel).first().evaluate((e) => getComputedStyle(e).textIndent)).toBe('0px');
  }
  // 原文と表示文字列が同一(先頭に空白を足していない)
  const same = await page.evaluate(async () => {
    const { LONG_PASSAGES } = await import('/js/passages-long.js');
    const shown = [...document.querySelectorAll('#passage-text p')].map((p) => p.textContent);
    const src = LONG_PASSAGES.find((x) => x.paragraphs[0] === shown[0]);
    return Boolean(src) && JSON.stringify(src.paragraphs) === JSON.stringify(shown);
  });
  expect(same).toBe(true);
  // 横はみ出しなし
  const w = await page.locator('.reading').evaluate((e) => ({ s: e.scrollWidth, c: e.clientWidth }));
  expect(w.s).toBeLessThanOrEqual(w.c);
});

test('A-56: 旧短文でも手動変更・字下げ・停止で不変が動作する', async ({ page, context, appServer, isMobile }) => {
  await context.route('**/js/reading-config.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export const READING_SET="short";' }));
  const passphrase = 'v041-short';
  const room = await seed(page, appServer, { passphrase });
  await join(page, appServer, { passphrase, role: 'end' });
  await page.click('#btn-participant');
  await expect(page.locator('#passage-text p')).toHaveCount(1);
  const before = await textOf(page);
  const original = await page.evaluate(async (t) => (await import('/js/passages.js')).PASSAGES.includes(t), before);
  expect(original).toBe(true);
  const p = page.locator('#passage-text p');
  const indent = await p.evaluate((e) => [parseFloat(getComputedStyle(e).textIndent), parseFloat(getComputedStyle(e).fontSize)]);
  expect(Math.abs(indent[0] - indent[1])).toBeLessThanOrEqual(0.5);
  const scroll = await scrollTo(page, 0.5);
  const start = await context.newPage();
  await join(start, appServer, { passphrase, role: 'start' });
  await start.click('#btn-start');
  await page.bringToFront();
  await expect(page.locator('#status-label')).toHaveText('計測中');
  await press(page, isMobile);
  await expect(start.locator('#status-label')).toHaveText('待機中');
  expect(await textOf(page)).toBe(before);
  expect(await scrollOf(page)).toBe(scroll);
  await page.click('#btn-experimenter');
  await page.click('#btn-change-passage');
  await page.click('#btn-participant');
  await expect(page.locator('#passage-text')).not.toHaveText(before);
  expect(await scrollOf(page)).toBe(0);
  const after = await textOf(page);
  expect(await page.evaluate(async (t) => (await import('/js/passages.js')).PASSAGES.includes(t), after)).toBe(true);
  const saved = await page.evaluate(({ k, room }) => JSON.parse(localStorage.getItem(k)), { k: CURRENT, room });
  expect(Number.isInteger(saved.short[room])).toBe(true);
  expect(saved.long?.[room]).toBeUndefined();
  const w = await page.locator('.reading').evaluate((e) => ({ s: e.scrollWidth, c: e.clientWidth }));
  expect(w.s).toBeLessThanOrEqual(w.c);
});

test('A-57・A-59・A-60・A-64: 合言葉と正式ルームIDで同じルーム、役割・同期・復帰・退出が両方式で動作', async ({ page, context, appServer, blocked }) => {
  page.on('dialog', (d) => d.accept());
  const passphrase = 'v041-room';
  const id = roomIdFor(passphrase);
  await seed(page, appServer, { passphrase });
  await join(page, appServer, { passphrase, role: 'start' });
  await expect(page.locator('#pill-room')).toHaveText('room ' + id.slice(0, 6));

  const byId = await context.newPage();
  byId.on('dialog', (d) => d.accept());
  await joinById(byId, appServer, { input: `  ${id.toUpperCase()}\t`, role: 'end' });
  await expect(byId.locator('#screen-main')).toBeVisible();
  await expect(byId.locator('#pill-clock')).toHaveText(/同期 ±/);
  await expect(byId.locator('#pill-room')).toHaveText('room ' + id.slice(0, 6));
  expect(await byId.evaluate(() => JSON.parse(localStorage.getItem('okulab-time/session')).roomId)).toBe(id);
  expect(await byId.evaluate(() => localStorage.getItem('okulab-time/session'))).not.toContain(passphrase);
  // 一方の開始・終了がもう一方へ反映
  await expect(byId.locator('#btn-end')).toBeEnabled();
  await page.bringToFront();
  await page.click('#btn-start');
  await expect(byId.locator('#status-label')).toHaveText('計測中');
  await byId.click('#btn-end');
  await expect(page.locator('#status-label')).toHaveText('待機中');
  await expect(page.locator('#record-count')).toHaveText('1');
  await expect(byId.locator('#record-count')).toHaveText('1');
  // 自動復帰(再読み込み)
  await byId.reload();
  await expect(byId.locator('#screen-main')).toBeVisible();
  await expect(byId.locator('#pill-room')).toHaveText('room ' + id.slice(0, 6));
  await expect(byId.locator('#room-id-full')).toHaveValue(id);
  await expect(byId.locator('#record-count')).toHaveText('1');
  // 退出で ID を残さない
  await byId.click('#btn-leave');
  await expect(byId.locator('#screen-join')).toBeVisible();
  await expect(byId.locator('#room-id-full')).toHaveValue('');
  expect(await byId.locator('#room-id-panel').evaluate((e) => e.open)).toBe(false);

  // ルームID方式で閲覧のみ・計測開始としても入れる
  for (const role of ['view', 'start']) {
    const other = await context.newPage();
    await joinById(other, appServer, { input: id, role });
    await expect(other.locator('#screen-main')).toBeVisible();
    await expect(other.locator('#record-count')).toHaveText('1');
    await expect(other.locator('#room-id-full')).toHaveValue(id);
    await other.close();
  }

  // A-59: 合言葉方式で 40 桁 16 進数を入れても再解釈しない
  const hex = 'abcdef0123456789abcdef0123456789abcdef01';
  const hexPage = await context.newPage();
  await join(hexPage, appServer, { passphrase: hex.toUpperCase(), role: 'view' });
  expect(roomIdFor(hex).slice(0, 6)).not.toBe(hex.slice(0, 6));
  await expect(hexPage.locator('#pill-room')).toHaveText('room ' + roomIdFor(hex).slice(0, 6));
  await expect(hexPage.locator('#room-id-full')).toHaveValue(roomIdFor(hex));
  expect(blocked).toEqual([]);
});

test('A-61: ルームID方式で空・省略ID・桁数違い・不正文字を入室前に拒否する', async ({ page, appServer }) => {
  const id = roomIdFor('v041-reject');
  await page.goto(`${appServer}/__blank`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${appServer}/index.html`);
  await expect(page.locator('input[name="join-method"][value="passphrase"]')).toBeChecked();
  expect(await page.locator('#input-room').getAttribute('maxlength')).toBeNull();
  // 方式の切替で入力値とエラーを消す
  await page.fill('#input-room', 'secret');
  await page.locator('input[name="join-method"][value="roomId"]').check();
  await expect(page.locator('#input-room')).toHaveValue('');
  await expect(page.locator('#room-input-label')).toContainText('ルームID');
  await page.locator('input[name="role"][value="end"]').check();
  const cases = [
    ['', 'ルームIDを入力してください。'],
    ['   ', 'ルームIDを入力してください。'],
    [id.slice(0, 6), '(入力は 6 桁)'],
    [id.slice(0, 39), '(入力は 39 桁)'],
    [id + 'a', '(入力は 41 桁)'],
    [id.slice(0, 39) + 'g', '0〜9 と a〜f だけ'],
    [id.slice(0, 20) + '/' + id.slice(21), '0〜9 と a〜f だけ'],
    ['room ' + id.slice(0, 6), '0〜9 と a〜f だけ'],
    ['０'.repeat(40), '0〜9 と a〜f だけ'],
  ];
  for (const [input, message] of cases) {
    await page.fill('#input-room', input);
    await page.click('#btn-join');
    await expect(page.locator('#join-error'), input).toBeVisible();
    await expect(page.locator('#join-error'), input).toContainText(message);
    // 分かりやすいエラー: 想定外エラーの案内(再読み込みの指示)として出さない
    await expect(page.locator('#join-error'), input).not.toContainText('予期しないエラー');
    await expect(page.locator('#screen-join')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('okulab-time/session'))).toBeNull();
  }
  await page.locator('input[name="join-method"][value="passphrase"]').check();
  await expect(page.locator('#join-error')).toBeHidden();
  await expect(page.locator('#room-input-label')).toHaveText('合言葉(ルームキー)');
});

test('A-62: 完全なルームIDを省略表示と区別して確認・コピーでき、失敗時は全選択と案内', async ({ page, context, appServer, browserName }) => {
  const passphrase = 'v041-copy';
  const id = roomIdFor(passphrase);
  await seed(page, appServer, { passphrase });
  await join(page, appServer, { passphrase, role: 'start' });
  await expect(page.locator('#pill-room')).toHaveText('room ' + id.slice(0, 6));
  await expect(page.locator('#room-id-full')).toBeHidden();
  await page.locator('#room-id-panel summary').click();
  await expect(page.locator('#room-id-full')).toBeVisible();
  await expect(page.locator('#room-id-full')).toHaveValue(id);
  await expect(page.locator('#room-id-panel')).toContainText('省略表示');
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: appServer });
    await page.click('#btn-copy-room-id');
    await expect(page.locator('#room-id-copy-status')).toHaveText('コピーしました。');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
  } else {
    // WebKit では権限を付与できないため、成功時の表示だけを API の差し替えで確認する
    await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
    await page.click('#btn-copy-room-id');
    await expect(page.locator('#room-id-copy-status')).toHaveText('コピーしました。');
    expect(await page.evaluate(() => window.__copied)).toBe(id);
  }
  // 失敗時: 全選択して手動コピーを案内
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new DOMException('denied', 'NotAllowedError'); }; });
  await page.click('#btn-copy-room-id');
  await expect(page.locator('#room-id-copy-status')).toHaveText(/自動でコピーできませんでした。.*Ctrl\+C/);
  const sel = await page.locator('#room-id-full').evaluate((e) => ({ focused: document.activeElement === e, start: e.selectionStart, end: e.selectionEnd, readOnly: e.readOnly }));
  expect(sel).toEqual({ focused: true, start: 0, end: 40, readOnly: true });
  // API 自体が無い環境
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); });
  await page.locator('#room-id-copy-status').evaluate((e) => { e.textContent = ''; });
  await page.click('#btn-copy-room-id');
  await expect(page.locator('#room-id-copy-status')).toHaveText(/自動でコピーできませんでした/);
});

test('A-65: 320/375/390px と各端末条件で参加画面・実験者用画面・被験者用画面に横はみ出しや重なりが無い', async ({ page, appServer }) => {
  const passphrase = 'v041-layout';
  await seed(page, appServer, { passphrase });
  const original = page.viewportSize();
  const sizes = [original, { width: 320, height: 568 }, { width: 375, height: 667 }, { width: 390, height: 844 }];
  const noOverflow = async (label) => {
    const w = await pageWidth(page);
    expect(w.html, label).toBeLessThanOrEqual(w.inner);
    expect(w.body, label).toBeLessThanOrEqual(w.inner);
  };
  const noOverlap = async (ids, label) => {
    const boxes = [];
    for (const id of ids) {
      const b = await page.locator(id).boundingBox();
      expect(b, `${label} ${id}`).not.toBeNull();
      expect(b.x, `${label} ${id}`).toBeGreaterThanOrEqual(-0.5);
      expect(b.x + b.width, `${label} ${id}`).toBeLessThanOrEqual(page.viewportSize().width + 0.5);
      boxes.push([id, b]);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const [ia, a] = boxes[i], [ib, b] = boxes[j];
      const overlap = a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
      expect(overlap, `${label}: ${ia} と ${ib} が重なる`).toBe(false);
    }
  };
  for (const size of sizes) {
    await page.setViewportSize(size);
    const label = `${size.width}x${size.height}`;
    await page.goto(`${appServer}/__blank`);
    await page.evaluate(() => localStorage.removeItem('okulab-time/session'));
    await page.goto(`${appServer}/index.html`);
    await expect(page.locator('#screen-join')).toBeVisible();
    await noOverflow(`${label} 参加(合言葉)`);
    await page.locator('input[name="join-method"][value="roomId"]').check();
    await page.fill('#input-room', 'abc');
    await page.locator('input[name="role"][value="end"]').check();
    await page.click('#btn-join');
    await expect(page.locator('#join-error')).toBeVisible();
    await noOverflow(`${label} 参加(ルームID・エラー)`);
    await noOverlap(['#input-room', '#btn-reveal', '#btn-join'], `${label} 参加`);
    await page.locator('input[name="join-method"][value="passphrase"]').check();
    await page.fill('#input-room', passphrase);
    await page.click('#btn-join');
    await expect(page.locator('#screen-main')).toBeVisible();
    await expect(page.locator('#btn-end')).toBeEnabled();
    await page.locator('#room-id-panel summary').click();
    await expect(page.locator('#room-id-full')).toBeVisible();
    await noOverflow(`${label} 実験者用`);
    await noOverlap(['#btn-end', '#btn-change-passage', '#passage-change-hint', '#btn-participant'], `${label} 実験者用`);
    await page.locator('#room-id-full').scrollIntoViewIfNeeded();
    await noOverlap(['#room-id-full', '#btn-copy-room-id'], `${label} ルームID欄`);
    await page.click('#btn-participant');
    await expectLongPassage(page, expect);
    await noOverflow(`${label} 被験者用`);
    const w = await page.locator('.reading').evaluate((e) => ({ s: e.scrollWidth, c: e.clientWidth }));
    expect(w.s, label).toBeLessThanOrEqual(w.c);
    await noOverlap(['#btn-detect', '#btn-experimenter'], `${label} 被験者用`);
    await page.click('#btn-experimenter');
  }
});
