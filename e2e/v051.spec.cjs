// v.05.1(F-16)の Test 工程の受け入れ E2E(RSD F-16-9 の E2E 1・2・5・6 のうち開発時 E2E で未確認の観点)。
// Firebase はスタブ(e2e/stubs)で、本番には接続しない。
// Ubuntu 上の WebKit/Chromium による端末エミュレーションであり、iOS/iPadOS/Windows 実機の確認ではない。
const { test, expect, seed, join, storedSessions } = require('./support/harness.cjs');

const READING_CURRENT = 'okulab-time/reading-current';
const FREE_LABEL = 'okulab-time/free-label';
const FAULT = '__okulab_e2e_tx_fault__';
// node tools/audit-passages.mjs が原典から算出した値(rt/rp を除き空白類を除いたコードポイント数など)。
const WORKS = {
  '人間椅子': { id: 'aozora-56648', characters: 14856, ruby: 239, headings: 0, sesame: 0, notes: 1, blanks: 8, first: ['佳子', 'よしこ'], last: ['匆々', 'そうそう'] },
  '目羅博士の不思議な犯罪': { id: 'aozora-57521', characters: 15358, ruby: 215, headings: 5, sesame: 2, notes: 0, blanks: 9, first: ['筋', 'すじ'], last: ['捨石', 'すていし'] },
};
const OTHER = { '人間椅子': '目羅博士の不思議な犯罪', '目羅博士の不思議な犯罪': '人間椅子' };

const acceptDialogs = (page) => page.on('dialog', (d) => d.accept());

/** 本文 DOM(rt/rp 除外)がどちらの作品と完全一致するか。一致しなければ null。 */
const shownTitle = (page) => page.locator('#passage-text').evaluate(async (root) => {
  const { AOZORA_PASSAGES } = await import('/js/passages-aozora.js');
  const copy = root.cloneNode(true); copy.querySelectorAll('rt,rp').forEach((n) => n.remove());
  const text = (p) => p.blocks.map((b) => b.type === 'blank' ? '' : b.type === 'heading' ? b.text
    : b.content.map((c) => typeof c === 'string' ? c : c.type === 'ruby' ? c.base : c.text).join('')).join('');
  return AOZORA_PASSAGES.find((p) => text(p) === copy.textContent)?.title ?? null;
});

/** 実験者用画面のタイトルと、被験者用画面に描画される本文が同じ作品であること */
async function expectSame(page, title) {
  await expect(page.locator('#current-passage')).toHaveText('現在の文章: ' + title);
  expect(await shownTitle(page)).toBe(title);
}

async function rejoinInApp(page, passphrase, role) {
  await page.click('#btn-leave');
  await expect(page.locator('#screen-join')).toBeVisible();
  await expect(page.locator('#current-passage')).toHaveText('');
  await page.fill('#input-room', passphrase);
  await page.locator(`input[name="role"][value="${role}"]`).check();
  await page.click('#btn-join');
  await expect(page.locator('#screen-main')).toBeVisible();
  await expect(page.locator('#pill-clock')).toHaveText(/同期 ±/);
}

/** 被験者用画面の表示検査(ルビの重なり・欠け、字下げ、見出し・傍点・注記・空行、文字数、先頭/中間/末尾) */
const inspectReading = (page) => page.locator('#passage-text').evaluate(async (root) => {
  const { AOZORA_PASSAGES } = await import('/js/passages-aozora.js');
  const box = root.parentElement, boxRect = () => box.getBoundingClientRect();
  box.scrollTop = 0;
  const firstRt = root.querySelector('rt').getBoundingClientRect();
  const copy = root.cloneNode(true); copy.querySelectorAll('rt,rp').forEach((n) => n.remove());
  const title = AOZORA_PASSAGES.find((p) => p.blocks.some((b) => b.content?.some((c) => c.type === 'ruby' && c.base === root.querySelector('ruby').firstChild.textContent))).title;
  const data = AOZORA_PASSAGES.find((p) => p.title === title);
  const fontSize = parseFloat(getComputedStyle(root).fontSize);
  // 行ごとの本文の矩形(rt/rp を除く文字)
  const lines = [];
  for (const p of root.querySelectorAll('p')) {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentElement.closest('rt,rp') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    for (let n; (n = walker.nextNode());) {
      const range = document.createRange(); range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) lines.push({ r, n });
    }
  }
  let overlaps = 0, missing = 0, overflowRt = 0; const examples = [];
  for (const rt of root.querySelectorAll('rt')) {
    const rr = rt.getBoundingClientRect();
    if (!(rr.width > 0 && rr.height > 0)) { missing++; continue; }
    const ruby = rt.parentElement, base = ruby.getClientRects()[0];
    if (rr.left < boxRect().left - 1 || rr.right > boxRect().right + 1) overflowRt++;
    const baseCenter = (base.top + base.bottom) / 2;
    for (const { r, n } of lines) {
      if (ruby.contains(n)) continue;
      // 同じ行の隣の文字は対象外。上(または下)の行の文字とだけ比べる。
      if (Math.abs((r.top + r.bottom) / 2 - baseCenter) < fontSize / 2) continue;
      const ix = Math.min(rr.right, r.right) - Math.max(rr.left, r.left), iy = Math.min(rr.bottom, r.bottom) - Math.max(rr.top, r.top);
      if (ix > 1 && iy > 1) { overlaps++; if (examples.length < 3) examples.push([ruby.textContent, n.textContent.slice(0, 10), iy]); }
    }
  }
  const ps = [...root.querySelectorAll('p')];
  const dataPs = data.blocks.filter((b) => b.type === 'p');
  const indentPx = ps.map((p) => parseFloat(getComputedStyle(p).textIndent));
  const leadingSpaceDom = ps.filter((p) => p.classList.contains('reading-indent') && copyText(p).startsWith('　')).length;
  const leadingSpaceData = dataPs.filter((b) => b.indent && typeof b.content[0] === 'string' && b.content[0].startsWith('　')).length;
  function copyText(p) { const c = p.cloneNode(true); c.querySelectorAll('rt,rp').forEach((n) => n.remove()); return c.textContent; }
  const headings = [...root.querySelectorAll('h3')];
  const sesame = [...root.querySelectorAll('.reading-sesame')];
  const within = (el) => { const r = el.getBoundingClientRect(), b = boxRect(); return r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.left >= b.left - 1 && r.right <= b.right + 1; };
  const middle = ps[Math.floor(ps.length / 2)];
  middle.scrollIntoView({ block: 'center' });
  const middleVisible = within(middle);
  box.scrollTop = box.scrollHeight;
  const lastP = ps.at(-1);
  const lastVisible = within(lastP) || (lastP.getBoundingClientRect().bottom <= boxRect().bottom + 1);
  const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 1;
  const rubies = [...root.querySelectorAll('ruby')];
  const pair = (r) => [r.firstChild.textContent, r.querySelector('rt').textContent];
  return {
    title, characters: [...copy.textContent.replace(/\s/gu, '')].length, rubyCount: rubies.length,
    firstRuby: pair(rubies[0]), lastRuby: pair(rubies.at(-1)),
    rpHidden: [...root.querySelectorAll('rp')].every((rp) => getComputedStyle(rp).display === 'none'),
    firstRtClipped: firstRt.top < boxRect().top - 1, overlaps, examples, missing, overflowRt,
    horizontal: box.scrollWidth > box.clientWidth,
    indentMatches: ps.every((p, i) => (dataPs[i].indent ? Math.abs(indentPx[i] - fontSize) < 0.5 : indentPx[i] === 0) && p.classList.contains(dataPs[i].indent ? 'reading-indent' : 'reading-no-indent')),
    noIndentCount: ps.filter((p) => p.classList.contains('reading-no-indent')).length,
    leadingSpaceDom, leadingSpaceData,
    headings: headings.length, headingIndented: headings.every((h) => parseFloat(getComputedStyle(h).paddingLeft) > 0 && h.getBoundingClientRect().right <= boxRect().right + 1),
    sesame: sesame.length, sesameStyled: sesame.every((s) => /sesame/.test(getComputedStyle(s).webkitTextEmphasisStyle || getComputedStyle(s).textEmphasisStyle || '')),
    notes: root.querySelectorAll('.reading-note').length, blanks: root.querySelectorAll('.reading-blank').length,
    blankHeight: [...root.querySelectorAll('.reading-blank')].every((b) => b.getBoundingClientRect().height > 0 && b.textContent === ''),
    fontSize, middleVisible, lastVisible, atEnd,
    unsafe: root.querySelectorAll('script,a,img,iframe,[style],[href],[src],[onclick],[onerror]').length,
  };
});

test('F-16 E2E-1: 2作品の全ルビ・本文文字数・ルビの重なり/欠け・字下げ・見出し・傍点・注記・空行・先頭/中間/末尾', async ({ page, appServer, blocked }) => {
  const passphrase = 'v051-accept-reading'; await seed(page, appServer, { passphrase }); await join(page, appServer, { passphrase, role: 'end' });
  for (const title of ['人間椅子', '目羅博士の不思議な犯罪']) {
    await expectSame(page, title);
    await page.click('#btn-participant');
    await expect(page.locator('#screen-participant')).toBeVisible();
    const w = WORKS[title], r = await inspectReading(page);
    expect(r.title).toBe(title);
    expect(r.characters).toBe(w.characters);
    expect(r.rubyCount).toBe(w.ruby);
    expect(r.firstRuby).toEqual(w.first); expect(r.lastRuby).toEqual(w.last);
    expect(r.rpHidden).toBe(true);
    expect(r.firstRtClipped).toBe(false);
    expect({ overlaps: r.overlaps, examples: r.examples }).toEqual({ overlaps: 0, examples: [] });
    expect(r.missing).toBe(0); expect(r.overflowRt).toBe(0); expect(r.horizontal).toBe(false);
    expect(r.indentMatches).toBe(true); expect(r.noIndentCount).toBeGreaterThan(0);
    expect(r.leadingSpaceDom).toBe(r.leadingSpaceData);
    expect(r.headings).toBe(w.headings); expect(r.headingIndented).toBe(true);
    expect(r.sesame).toBe(w.sesame); expect(r.sesameStyled).toBe(true);
    expect(r.notes).toBe(w.notes);
    expect(r.blanks).toBe(w.blanks); expect(r.blankHeight).toBe(true);
    expect(r.fontSize).toBeGreaterThanOrEqual(13.5);
    expect(r.middleVisible).toBe(true); expect(r.lastVisible).toBe(true); expect(r.atEnd).toBe(true);
    expect(r.unsafe).toBe(0);
    await page.screenshot({ path: require('node:path').join(process.env.DEVFLOW_BROWSER_OUTPUT, `v051-end-${test.info().project.name}-${w.id}.png`) });
    // 被験者用画面には作品名・切替操作・出典を出さない
    const chrome = await page.locator('#screen-participant').evaluate((e) => { const c = e.cloneNode(true); c.querySelector('.reading')?.remove(); return c.textContent; });
    expect(chrome).not.toMatch(/現在の文章|文章を変更|青空文庫|底本|入力|校正|人間椅子|目羅博士/);
    expect(await page.locator('#passage-text').textContent()).not.toMatch(/青空文庫|底本：|入力：|校正：/);
    await page.click('#btn-experimenter');
    await page.click('#btn-change-passage');
  }
  expect(blocked).toEqual([]);
});

test('F-16 E2E-2: 現在の文章が全経路で本文と一致し、交互切替・先頭表示・スクロール保持・計測中の保護・計測終了で不変', async ({ page, context, appServer }) => {
  acceptDialogs(page);
  const passphrase = 'v051-accept-title', room = await seed(page, appServer, { passphrase });
  await join(page, appServer, { passphrase, role: 'end' });
  // 初回(保存値なし)
  await expectSame(page, '人間椅子');
  expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), READING_CURRENT)).toEqual({ aozora: { [room]: 'aozora-56648' } });
  // 手動変更ごとに交互
  let title = '人間椅子';
  for (let i = 0; i < 4; i++) { await page.click('#btn-change-passage'); title = OTHER[title]; await expectSame(page, title); }
  // 往復で本文とスクロール位置を保持
  await page.click('#btn-participant');
  const reading = page.locator('.reading');
  await reading.evaluate((e) => { e.scrollTop = 600; });
  const kept = await reading.evaluate((e) => e.scrollTop); expect(kept).toBeGreaterThan(0);
  await page.click('#btn-experimenter'); await expectSame(page, title);
  await page.click('#btn-participant'); expect(await reading.evaluate((e) => e.scrollTop)).toBe(kept);
  // 明示的な変更後は新しい作品の先頭
  await page.click('#btn-experimenter'); await page.click('#btn-change-passage'); title = OTHER[title]; await expectSame(page, title);
  await page.click('#btn-participant'); expect(await reading.evaluate((e) => e.scrollTop)).toBe(0); expect(await shownTitle(page)).toBe(title);
  // 被験者用画面で再読み込み → 同じ作品
  await page.reload(); await expect(page.locator('#screen-participant')).toBeVisible(); expect(await shownTitle(page)).toBe(title);
  await page.click('#btn-experimenter'); await expectSame(page, title);
  // 実験者用画面で再読み込み
  await page.reload(); await expect(page.locator('#screen-main')).toBeVisible(); await expectSame(page, title);
  // 退出・再入室(アプリ内)
  await rejoinInApp(page, passphrase, 'end'); await expectSame(page, title);
  // ルーム変更 → 新しいルームは初期値、元のルームは保持
  await rejoinInApp(page, passphrase + '-other', 'end'); await expectSame(page, '人間椅子');
  await rejoinInApp(page, passphrase, 'end'); await expectSame(page, title);
  // 他の役割には表示しない
  await rejoinInApp(page, passphrase, 'start'); await expect(page.locator('#current-passage')).toBeHidden();
  await rejoinInApp(page, passphrase, 'end'); await expectSame(page, title);

  // 計測中は変更不可で理由表示、計測終了でも作品は変わらない
  await page.click('#btn-participant'); await reading.evaluate((e) => { e.scrollTop = 400; });
  const scrolled = await reading.evaluate((e) => e.scrollTop);
  await page.click('#btn-experimenter');
  const start = await context.newPage(); await join(start, appServer, { passphrase, role: 'start' });
  await start.click('#btn-start'); await expect(page.locator('#status-label')).toHaveText('計測中');
  await expect(page.locator('#btn-change-passage')).toBeDisabled();
  await expect(page.locator('#passage-change-hint')).toHaveText(/計測中は文章を変更できません/);
  await page.click('#btn-end'); await expect(start.locator('#status-label')).toHaveText('待機中');
  await expect(page.locator('#btn-change-passage')).toBeEnabled();
  await expectSame(page, title);
  await page.click('#btn-participant'); expect(await reading.evaluate((e) => e.scrollTop)).toBe(scrolled);
  await start.close();
});

test('F-16 E2E-2: 破損JSON・旧ID・型違い・保存不可でも起動し、タイトルと本文が一致したまま切替でき、旧区分を変えない', async ({ page, appServer }) => {
  const passphrase = 'v051-accept-storage', room = await seed(page, appServer, { passphrase });
  // 破損 JSON: 初期値から始め、メモリ上で切替。保存値は上書きしない。
  await page.evaluate((k) => localStorage.setItem(k, '{'), READING_CURRENT);
  await join(page, appServer, { passphrase, role: 'end' });
  await expectSame(page, '人間椅子');
  await page.click('#btn-change-passage'); await expectSame(page, '目羅博士の不思議な犯罪');
  await page.click('#btn-change-passage'); await expectSame(page, '人間椅子');
  expect(await page.evaluate((k) => localStorage.getItem(k), READING_CURRENT)).toBe('{');

  // 旧 ID・未知 ID が残る端末: 初期値から始め、long/short 区分と既出キーは不変
  const legacy = { long: { [room]: 'long-03' }, short: { [room]: 5 }, aozora: { [room]: 'long-03' } };
  const shown = { [room]: ['long-01', 'long-03'] };
  await page.evaluate(({ k, legacy, shown }) => { localStorage.setItem(k, JSON.stringify(legacy)); localStorage.setItem('okulab-time/passages/long', JSON.stringify(shown)); localStorage.setItem('okulab-time/passages', '{"x":[1,2]}'); }, { k: READING_CURRENT, legacy, shown });
  await page.reload(); await expect(page.locator('#screen-main')).toBeVisible();
  await expectSame(page, '人間椅子');
  await page.click('#btn-change-passage'); await expectSame(page, '目羅博士の不思議な犯罪');
  const after = await page.evaluate((k) => ({ cur: JSON.parse(localStorage.getItem(k)), long: localStorage.getItem('okulab-time/passages/long'), short: localStorage.getItem('okulab-time/passages') }), READING_CURRENT);
  expect(after.cur.long).toEqual(legacy.long); expect(after.cur.short).toEqual(legacy.short);
  expect(after.cur.aozora[room]).toBe('aozora-57521');
  expect(after.long).toBe(JSON.stringify(shown)); expect(after.short).toBe('{"x":[1,2]}');

  // 型違いの区分(aozora が配列): 起動でき、読めない区分は上書きしない
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ aozora: ['x'] })), READING_CURRENT);
  await page.reload(); await expect(page.locator('#screen-main')).toBeVisible();
  await expectSame(page, '人間椅子');
  await page.click('#btn-change-passage'); await expectSame(page, '目羅博士の不思議な犯罪');
  expect(await page.evaluate((k) => localStorage.getItem(k), READING_CURRENT)).toBe(JSON.stringify({ aozora: ['x'] }));

  // 保存不可: setItem が例外でもメモリ上で切替・一致
  await page.evaluate((k) => { localStorage.removeItem(k); }, READING_CURRENT);
  await page.addInitScript((k) => { const o = Storage.prototype.setItem; Storage.prototype.setItem = function (key, v) { if (key === k) throw Error('保存不可'); return o.call(this, key, v); }; }, READING_CURRENT);
  await page.reload(); await expect(page.locator('#screen-main')).toBeVisible();
  await expectSame(page, '人間椅子');
  await page.click('#btn-change-passage'); await expectSame(page, '目羅博士の不思議な犯罪');
  await page.click('#btn-participant'); expect(await shownTitle(page)).toBe('目羅博士の不思議な犯罪');
  await page.click('#btn-experimenter'); await expectSame(page, '目羅博士の不思議な犯罪');
});

test('F-16 E2E-1・2: 幅320/375/390pxでタイトルが折り返して読め、ボタンと重ならず、本文が横にはみ出さない', async ({ page, appServer }) => {
  const passphrase = 'v051-accept-width'; await seed(page, appServer, { passphrase }); await join(page, appServer, { passphrase, role: 'end' });
  const base = page.viewportSize();
  await page.click('#btn-change-passage'); // 長い題名で確認
  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: base.height });
    await expectSame(page, '目羅博士の不思議な犯罪');
    const layout = await page.evaluate(() => {
      const rect = (id) => document.getElementById(id).getBoundingClientRect();
      const t = rect('current-passage'), el = document.getElementById('current-passage');
      const hit = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
      return {
        overlap: ['btn-end', 'btn-change-passage', 'btn-participant', 'passage-change-hint'].filter((id) => hit(t, rect(id))),
        inside: t.left >= -0.5 && t.right <= document.documentElement.clientWidth + 0.5,
        clipped: el.scrollWidth > el.clientWidth + 1, height: t.height,
        page: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      };
    });
    expect(layout.overlap).toEqual([]); expect(layout.inside).toBe(true); expect(layout.clipped).toBe(false);
    expect(layout.height).toBeGreaterThan(0); expect(layout.page).toBe(true);
    await page.click('#btn-participant');
    const r = await inspectReading(page);
    expect(r.horizontal).toBe(false); expect(r.overlaps).toBe(0); expect(r.overflowRt).toBe(0); expect(r.headingIndented).toBe(true); expect(r.atEnd).toBe(true);
    await page.screenshot({ path: require('node:path').join(process.env.DEVFLOW_BROWSER_OUTPUT, `v051-width-${test.info().project.name}-${width}.png`) });
    await page.click('#btn-experimenter');
  }
});

test('F-16 E2E-6: 任意ラベルの退出/再入室・別ルーム・破損値・HTML非実行・記録への反映・2ページの上書き規則', async ({ page, context, appServer }) => {
  acceptDialogs(page);
  const passphrase = 'v051-accept-label', room = await seed(page, appServer, { passphrase });
  await page.evaluate((k) => localStorage.setItem(k, '{broken'), FREE_LABEL);
  await join(page, appServer, { passphrase, role: 'start' });
  await expect(page.locator('#input-label')).toHaveValue('');
  expect(await page.evaluate((k) => localStorage.getItem(k), FREE_LABEL)).toBe('{broken');
  const html = '  <img src=x onerror="window.__labelXss=1">被験者A  ';
  await page.fill('#input-label', html);
  await rejoinInApp(page, passphrase, 'start'); await expect(page.locator('#input-label')).toHaveValue(html);
  await rejoinInApp(page, passphrase + '-other', 'start'); await expect(page.locator('#input-label')).toHaveValue(html);
  await rejoinInApp(page, passphrase, 'start'); await expect(page.locator('#input-label')).toHaveValue(html);
  expect(await page.evaluate(() => window.__labelXss)).toBeUndefined();

  // 開始時に表示されている値(trim)が記録に入り、計測・記録確定後も欄は空にならない
  const end = await context.newPage(); await join(end, appServer, { passphrase, role: 'end' });
  await page.bringToFront();
  await page.click('#btn-start'); await expect(end.locator('#status-label')).toHaveText('計測中');
  await end.click('#btn-end'); await expect(page.locator('#status-label')).toHaveText('待機中');
  await expect(page.locator('#record-body tr')).toHaveCount(1);
  const sessions = await storedSessions(page, room);
  expect(sessions).toHaveLength(1); expect(sessions[0].label).toBe(html.trim());
  await expect(page.locator('#record-body tr').first().locator('td').first()).toHaveText(html.trim());
  expect(await page.evaluate(() => document.querySelectorAll('#record-body img').length)).toBe(0);
  await expect(page.locator('#input-label')).toHaveValue(html);
  expect(await page.evaluate(() => window.__labelXss)).toBeUndefined();
  await end.close();

  // 2ページ: 他ページの新しい値は入力中でなければ反映、起動時に古い値で上書きしない
  const other = await context.newPage(); await join(other, appServer, { passphrase, role: 'start' });
  await expect(other.locator('#input-label')).toHaveValue(html);
  await other.fill('#input-label', '新しい値');
  await page.locator('#btn-start').focus(); // ラベル欄からフォーカスを外す
  await expect(page.locator('#input-label')).toHaveValue('新しい値');
  await page.reload(); await expect(page.locator('#input-label')).toHaveValue('新しい値');
  expect(await other.evaluate((k) => JSON.parse(localStorage.getItem(k)), FREE_LABEL)).toEqual({ v: 1, value: '新しい値' });
  // 入力中の欄は他ページの値で上書きしない
  await page.locator('#input-label').focus(); await page.locator('#input-label').pressSequentially('X');
  await other.fill('#input-label', '他ページ');
  await page.waitForTimeout(300);
  await expect(page.locator('#input-label')).toHaveValue('新しい値X');
  // 明示的な空欄化は再読み込み後も空
  await other.fill('#input-label', ''); await other.reload(); await expect(other.locator('#input-label')).toHaveValue('');
});

test('F-16 E2E-5: 既定データセットの2画面で判定応答の遅延・一時失敗・復帰時の再購読(重複通知)を経ても1回だけ確定し3試行を完了', async ({ page, context, appServer }) => {
  const passphrase = 'v051-accept-settle', room = await seed(page, appServer, { passphrase });
  await join(page, appServer, { passphrase, role: 'start' });
  await page.fill('#input-label', '順序ラベル');
  await page.locator('#measurement-mode').check(); await page.click('#random-open');
  await page.fill('#sequence-condition', '条件B'); await page.fill('#random-count', '2'); await page.click('#random-add'); await page.click('#random-import');
  const end = await context.newPage(); await join(end, appServer, { passphrase, role: 'end' });
  await expectSame(end, '人間椅子');
  const run = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), 'okulab-time/sequence/' + room);
  for (const [trial, mode] of [[1, 'delay'], [2, 'fail'], [3, 'resume']]) {
    await page.bringToFront();
    await page.click('#btn-start'); await expect(end.locator('#status-label')).toHaveText('計測中');
    await end.click('#btn-end'); await expect(page.locator('#random-confirm')).toBeVisible();
    await expect(page.locator('#random-yes')).toBeEnabled();
    const before = await run();
    if (mode === 'delay') {
      await page.evaluate((k) => sessionStorage.setItem(k, JSON.stringify({ delayMs: 1500 })), FAULT);
      await page.click('#random-yes');
      await expect(page.locator('#random-yes')).toBeDisabled();
      await page.evaluate((k) => sessionStorage.removeItem(k), FAULT);
    } else if (mode === 'fail') {
      await page.evaluate((k) => sessionStorage.setItem(k, JSON.stringify({ code: 'unavailable' })), FAULT);
      await page.click('#random-no');
      await expect(page.locator('#random-message')).not.toBeEmpty();
      await expect(page.locator('#random-confirm')).toBeVisible();
      expect((await run()).done).toBe(before.done); expect((await run()).pending).not.toBeNull();
      await page.evaluate((k) => sessionStorage.removeItem(k), FAULT);
      await page.click('#random-no');
    } else {
      await page.click('#random-yes');
      // 復帰(focus/visibilitychange)で単一記録の購読を張り直し、同じ確定通知を再受信しても二重に進まない
      for (let i = 0; i < 3; i++) await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); document.dispatchEvent(new Event('visibilitychange')); });
    }
    await expect(page.locator('#random-confirm')).toBeHidden({ timeout: 10000 });
    await expect.poll(async () => (await run()).pending, { timeout: 10000 }).toBeNull();
    const after = await run();
    expect(after.attempts).toBe(trial);
    expect(after.done).toBe(mode === 'fail' ? before.done : before.done + 1);
    await page.waitForTimeout(500);
    expect((await run()).done).toBe(after.done);
    if (trial < 3) await expect(page.locator('#btn-start')).toBeEnabled();
  }
  const final = await run();
  expect(final.status).toBe('completed'); expect(final.done).toBe(2); expect(final.attempts).toBe(3);
  await expect(page.locator('#random-confirm')).toBeHidden();
  const sessions = (await storedSessions(page, room)).filter((s) => s.mode === 'sequence');
  expect(sessions.map((s) => s.sequenceOutcome).sort()).toEqual(['confirmed', 'confirmed', 'discarded']);
  expect(sessions.every((s) => s.label === '順序ラベル')).toBe(true);
  // 計測終了・判定を経ても終了側の作品は不変
  await expectSame(end, '人間椅子');
});
