// Development の動作確認。Test 工程の受け入れ検証を代替しない。
const { test, expect, seed, join } = require('./support/harness.cjs');

// 開始予約のlocalStorage保存は開始トランザクションの確定より先に行われる。
// 別タブの終了操作は、直前の待機状態から新しい計測への通知を受けた後に行う。
// ボタンは待機中にも押せる仕様なので、クリック完了やenabledだけでは同期できない。
async function startAndWait(page, end) {
  await expect(end.locator('#status-label')).toHaveText('待機中');
  await page.click('#btn-start');
  await expect(page.locator('#status-label')).toHaveText('計測中');
  await expect(end.locator('#status-label')).toHaveText('計測中');
}

test('順序反復: 記録しないで同じ位置を再試行し、有効確定後にだけ進む', async ({ page, context, appServer }) => {
  const passphrase = 'sequence-development';
  const room = await seed(page, appServer, { passphrase, catalog: [{ name: '色', items: ['白', '赤'] }] });
  await join(page, appServer, { passphrase, role: 'start' });
  await page.locator('#measurement-mode').check();
  await page.click('#random-open');
  await page.locator('#random-options label').filter({ hasText: '白' }).locator('input').check();
  await page.fill('#random-count', '2'); await page.click('#random-add');
  await page.locator('#random-options label').filter({ hasText: '赤' }).locator('input').check();
  await page.fill('#random-count', '1'); await page.click('#random-add');
  await page.fill('#sequence-sets', '2'); await page.click('#random-import');
  const saved = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), 'okulab-time/sequence/' + room);
  expect((await saved()).total).toBe(6);
  const end = await context.newPage();
  await join(end, appServer, { passphrase, role: 'end' });
  for (const [choice, done, attempts] of [['random-no', 0, 1], ['random-yes', 1, 2], ['random-yes', 2, 3]]) {
    await startAndWait(page, end);
    await expect.poll(async () => (await saved()).pending?.payload.sequenceTrial).toBe((await saved()).done + 1);
    await end.click('#btn-end');
    await expect(page.locator('#random-confirm')).toBeVisible();
    await page.click('#' + choice);
    await expect.poll(async () => (await saved()).attempts).toBe(attempts);
    expect((await saved()).done).toBe(done);
    await expect(page.locator('#random-confirm')).toBeHidden();
  }
  expect((await saved()).previous).toEqual(['色:白']);
  await expect(page.locator('#sequence-next')).toContainText('赤');
});

test('順序反復: 確認待ちを再読み込みし、別タブの逆回答でも予定試行を二重消費しない',async({page,context,appServer})=>{
 const passphrase='sequence-resume',room=await seed(page,appServer,{passphrase,catalog:[{name:'色',items:['白']}]});
 await join(page,appServer,{passphrase,role:'start'});await page.locator('#measurement-mode').check();await page.click('#random-open');
 await page.locator('#random-options input').check();await page.click('#random-add');await page.click('#random-import');
 const end=await context.newPage();await join(end,appServer,{passphrase,role:'end'});
 await startAndWait(page,end);
 await end.click('#btn-end');await expect(page.locator('#random-confirm')).toBeVisible();
 const saved=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),'okulab-time/sequence/'+room);
 const pending=(await saved()).pending;
 await page.evaluate(room=>localStorage.setItem('okulab-time/session',JSON.stringify({roomId:room,role:'start',participant:false})),room);
 await page.reload();await expect(page.locator('#random-confirm')).toBeVisible();expect((await saved()).pending.id).toBe(pending.id);expect((await saved()).done).toBe(0);
 const other=await context.newPage();await join(other,appServer,{passphrase,role:'start',pending:true});
 await expect(other.locator('#random-confirm')).toBeVisible();
 await Promise.all([page.locator('#random-yes').evaluate(e=>e.click()),other.locator('#random-no').evaluate(e=>e.click())]);
 await expect.poll(async()=>(await saved()).attempts).toBe(1);
 const outcome=await page.evaluate(({room,id})=>JSON.parse(localStorage.getItem('__okulab_e2e_firestore__'))[`rooms/${room}/sessions/${id}`].sequenceOutcome,{room,id:pending.id});
 expect(['confirmed','discarded']).toContain(outcome);expect((await saved()).done).toBe(outcome==='confirmed'?1:0);
 expect((await saved()).pending).toBeNull();
 if(outcome==='discarded'){
  await startAndWait(page,end);await end.click('#btn-end');await expect(page.locator('#random-confirm')).toBeVisible();await page.click('#random-yes');
  await expect.poll(async()=>(await saved()).done).toBe(1);
 }
 expect((await saved()).status).toBe('completed');await expect(page.locator('#measurement-mode')).not.toBeChecked();
});
