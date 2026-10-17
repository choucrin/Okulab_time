const {test,expect,seed,join} = require('./support/harness.cjs');

// v.04.1(F-14-1-1): 停止押下で文章を変えない。旧観点「新しい文章が先頭から表示」は e2e/v041.spec.cjs の手動変更へ移した。
test('長文: 枠内末尾・通知と回転で保持・スクロール後の終了操作で文章を維持',async({page,context,appServer,blocked,isMobile})=>{
 const passphrase='reading-long';await seed(page,appServer,{passphrase});await join(page,appServer,{passphrase,role:'end'});
 await page.click('#btn-participant');
 const text=page.locator('#passage-text');await expect(text.locator('p')).toHaveCount(30);
 const before=await text.textContent();expect([...before.replace(/\s/gu,'')].length).toBeGreaterThanOrEqual(10000);
 const reading=page.locator('.reading');
 await reading.evaluate(e=>{e.scrollTop=e.scrollHeight;});
 expect(await reading.evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
 expect(await text.locator('p').last().evaluate(e=>{const p=e.parentElement.parentElement.getBoundingClientRect(),r=e.getBoundingClientRect();return r.bottom<=p.bottom+1&&r.bottom>=p.top;})).toBe(true);
 const midway=await reading.evaluate(e=>{e.scrollTop=Math.floor(e.scrollHeight/2);return e.scrollTop;});
 const start=await context.newPage();await join(start,appServer,{passphrase,role:'start'});await start.click('#btn-start');
 await expect(start.locator('#status-label')).toHaveText('計測中');await page.bringToFront();
 await expect(text).toHaveText(before);expect(await reading.evaluate(e=>e.scrollTop)).toBe(midway);
 const size=page.viewportSize();await page.setViewportSize({width:size.height,height:size.width});
 await expect(text).toHaveText(before);expect(await reading.evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
 await page.setViewportSize(size);
 const dims=await page.evaluate(()=>({html:document.documentElement.scrollHeight,body:document.body.scrollHeight,h:innerHeight}));
 expect(dims.html).toBeLessThanOrEqual(dims.h+1);expect(dims.body).toBeLessThanOrEqual(dims.h+1);
 const kept=await reading.evaluate(e=>{e.scrollTop=Math.floor(e.scrollHeight/3);return e.scrollTop;});
 if(isMobile)await page.locator('#btn-detect').tap();else await page.click('#btn-detect');
 await expect(start.locator('#status-label')).toHaveText('待機中');await expect(start.locator('#record-count')).toHaveText('1');
 await expect(text).toHaveText(before);expect(await reading.evaluate(e=>e.scrollTop)).toBe(kept);
 const chromeText=await page.locator('#screen-participant').evaluate(e=>{const copy=e.cloneNode(true);copy.querySelector('.reading').remove();return copy.textContent;});
 expect(chromeText).not.toMatch(/計測中|待機中|経過|記録/);
 await expect(page.locator('#status-label')).toBeHidden();await expect(page.locator('#record-body')).toBeHidden();
 expect(blocked).toEqual([]);
});

test('設定1か所で旧短文へ切替、長文と旧短文の既出キーを互いに保持',async({page,context,appServer})=>{
 await context.route('**/js/reading-config.js',route=>route.fulfill({status:200,contentType:'text/javascript',body:'export const READING_SET="short";'}));
 const passphrase='reading-short',room=await seed(page,appServer,{passphrase});
 await page.evaluate(({room})=>{localStorage.setItem('okulab-time/passages/long',JSON.stringify({[room]:['long-01']}));localStorage.setItem('okulab-time/passages',JSON.stringify({[room]:[-1,9999,'invalid',null,0]}));},{room});
 await join(page,appServer,{passphrase,role:'end'});await page.click('#btn-participant');
 await expect(page.locator('#passage-text p')).toHaveCount(1);
 const n=await page.locator('#passage-text').evaluate(e=>[...e.textContent.replace(/\s/gu,'')].length);expect(n).toBeLessThan(10000);expect(n).toBeGreaterThan(0);
 expect(await page.evaluate(room=>JSON.parse(localStorage.getItem('okulab-time/passages/long'))[room],room)).toEqual(['long-01']);
 const history=await page.evaluate(room=>JSON.parse(localStorage.getItem('okulab-time/passages'))[room],room);
 expect(history).toHaveLength(2);expect(history.every(i=>Number.isInteger(i)&&i>=0&&i<57)).toBe(true);
});
