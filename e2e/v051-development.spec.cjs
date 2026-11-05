const { test, expect, seed, join } = require('./support/harness.cjs');

test('F-16 押下調査: 非primary指・click欠落の合成イベント', async ({ page, appServer }) => {
  const passphrase = 'v051-press'; await seed(page, appServer, { passphrase }); await join(page, appServer, { passphrase, role: 'start' });
  const button = page.locator('#btn-start'); await expect(button).toBeEnabled();
  await button.evaluate(b => {
    const r = b.getBoundingClientRect(), init = { bubbles: true, pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    b.dispatchEvent(new PointerEvent('pointerdown', init));
    b.dispatchEvent(new PointerEvent('pointerup', init));
  });
  await expect(page.locator('#status-label')).toHaveText('計測中', { timeout: 1500 });
});

test('F-16 青空文庫: 初期作品・交互切替・ルビ・原典DOM・枠内末尾・再読込復元', async ({ page, appServer, blocked }) => {
  const passphrase='v051-reading'; await seed(page,appServer,{passphrase});await join(page,appServer,{passphrase,role:'end'});
  await expect(page.locator('#current-passage')).toHaveText('現在の文章: 人間椅子');
  for(const [title,rubies,headings] of [['人間椅子',239,0],['目羅博士の不思議な犯罪',215,5],['人間椅子',239,0]]) {
    await expect(page.locator('#current-passage')).toHaveText('現在の文章: '+title);
    await page.click('#btn-participant');
    await expect(page.locator('#passage-text ruby')).toHaveCount(rubies);
    await expect(page.locator('#passage-text h3')).toHaveCount(headings);
    const result=await page.locator('#passage-text').evaluate(async root=>{
      const {AOZORA_PASSAGES}=await import('/js/passages-aozora.js');
      const ruby=root.querySelector('ruby');const copy=root.cloneNode(true);copy.querySelectorAll('rt,rp').forEach(n=>n.remove());
      const expected=AOZORA_PASSAGES.find(p=>p.blocks.some(b=>b.content?.some(c=>c.type==='ruby'&&c.base===ruby.firstChild.textContent)));
      const source=expected.blocks.map(b=>b.type==='blank'?'':b.type==='heading'?b.text:b.content.map(c=>typeof c==='string'?c:c.type==='ruby'?c.base:c.text).join('')).join('');
      return {same:copy.textContent===source,overflow:root.parentElement.scrollWidth>root.parentElement.clientWidth,size:parseFloat(getComputedStyle(root).fontSize),unsafe:root.querySelectorAll('script,a,img,[style],[onclick]').length};
    });
    expect(result.same).toBe(true);expect(result.overflow).toBe(false);expect(result.size).toBeGreaterThanOrEqual(13.5);expect(result.unsafe).toBe(0);
    if(title==='人間椅子') {
      const gaiji=page.locator('#passage-text ruby').filter({hasText:'尾骶骨'});await gaiji.scrollIntoViewIfNeeded();await expect(gaiji).toBeVisible();
      await page.screenshot({path:require('node:path').join(process.env.DEVFLOW_BROWSER_OUTPUT,`gaiji-${test.info().project.name}.png`)});
    }
    const reading=page.locator('.reading');await reading.evaluate(e=>{e.scrollTop=e.scrollHeight;});expect(await reading.evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
    await page.screenshot({path:require('node:path').join(process.env.DEVFLOW_BROWSER_OUTPUT,`aozora-${test.info().project.name}-${rubies}.png`)});
    await page.click('#btn-experimenter');
    await page.getByRole('button',{name:'文章を変更',exact:true}).click();
  }
  await page.reload();await expect(page.locator('#current-passage')).toHaveText('現在の文章: 目羅博士の不思議な犯罪');
  expect(blocked).toEqual([]);
});

test('F-16 任意ラベル: 入力直後・再読み込み・空欄・保存失敗',async({page,appServer})=>{
  const passphrase='v051-label';await seed(page,appServer,{passphrase});await join(page,appServer,{passphrase,role:'start'});
  await page.fill('#input-label','条件 <ruby>');await page.reload();await expect(page.locator('#input-label')).toHaveValue('条件 <ruby>');
  await page.fill('#input-label','');await page.reload();await expect(page.locator('#input-label')).toHaveValue('');
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='okulab-time/free-label')throw Error('保存不可');return original.call(this,k,v);};});
  await page.fill('#input-label','保存不可でも入力');await expect(page.locator('#free-label-hint')).toContainText('保存できません');await expect(page.locator('#btn-start')).toBeEnabled();
});

test('F-16 決着調査: 保存失敗後に自動復旧し3試行を連続実行',async({page,context,appServer})=>{
  if(process.env.V051_BASELINE==='1') {
    const source=require('node:child_process').execFileSync('git',['show','6fe36d2358d95bfed5dd199f8cf576b2f59736ec:js/app.js'],{encoding:'utf8'});
    await context.route('**/js/app.js',route=>route.fulfill({status:200,contentType:'text/javascript',body:source}));
    await context.route('**/js/reading-config.js',route=>route.fulfill({status:200,contentType:'text/javascript',body:'export const READING_SET="long";'}));
  }
  const passphrase='v051-settle',room=await seed(page,appServer,{passphrase});await join(page,appServer,{passphrase,role:'start'});
  await page.locator('#measurement-mode').check();await page.click('#random-open');await page.fill('#sequence-condition','条件A');await page.fill('#random-count','2');await page.click('#random-add');await page.click('#random-import');
  const end=await context.newPage();await join(end,appServer,{passphrase,role:'end'});
  for(const [index,choice,done] of [[0,'random-no',0],[1,'random-yes',1],[2,'random-yes',2]]) {
    await page.click('#btn-start');await expect(page.locator('#status-label')).toHaveText('計測中');await expect(end.locator('#status-label')).toHaveText('計測中');
    await end.click('#btn-end');await expect(page.locator('#random-confirm')).toBeVisible();
    if(index===0) await page.evaluate(room=>{
      const original=Storage.prototype.setItem;let failed=false;
      Storage.prototype.setItem=function(k,v){if(k==='okulab-time/sequence/'+room&&!JSON.parse(v).pending&&!failed){failed=true;throw Error('決着保存の一時失敗');}return original.call(this,k,v);};
    },room);
    await page.click('#'+choice);
    await expect.poll(()=>page.evaluate(room=>JSON.parse(localStorage.getItem('okulab-time/sequence/'+room)).pending,room),{timeout:5000}).toBeNull();
    const saved=await page.evaluate(room=>JSON.parse(localStorage.getItem('okulab-time/sequence/'+room)),room);
    expect(saved.done).toBe(done);expect(saved.attempts).toBe(index+1);await expect(page.locator('#random-confirm')).toBeHidden();
    if(index<2) await expect(page.locator('#btn-start')).toBeEnabled();else expect(saved.status).toBe('completed');
  }
});

test('F-16 押下: スクロール直後・移動・cancel・二重click・マウス・キーボードの合成行列',async({page,appServer})=>{
  const passphrase='v051-pointer-matrix';await seed(page,appServer,{passphrase});await join(page,appServer,{passphrase,role:'start'});
  const result=await page.evaluate(async()=>{
    const {bindTimedPress}=await import('/js/press-button.js');
    const button=document.createElement('button');button.textContent='development';document.body.append(button);
    const calls=[];bindTimedPress(button,p=>calls.push(p),()=>({at:calls.length,perfAt:performance.now()}));
    const r=button.getBoundingClientRect();const base={bubbles:true,pointerId:10,pointerType:'touch',isPrimary:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2};
    const event=(type,extra={})=>button.dispatchEvent(new PointerEvent(type,{...base,...extra}));
    const click=(detail=1)=>button.dispatchEvent(new MouseEvent('click',{bubbles:true,detail}));
    const count=()=>calls.length;
    const counts=[];
    // 静止・スクロール通知中/直後・別の指・微小移動は有効。
    for(const mode of ['still','scroll','after','secondary','small']) {
      if(mode==='after')window.dispatchEvent(new Event('scroll'));
      event('pointerdown',{isPrimary:mode!=='secondary'});
      if(mode==='scroll')window.dispatchEvent(new Event('scroll'));
      if(mode==='small')event('pointermove',{clientX:base.clientX+2});
      event('pointerup');click();counts.push(count());
    }
    // ボタンからのパン・cancel・ボタン外・マウスleaveは無効。
    for(const mode of ['pan','cancel','outside','leave']) {
      event('pointerdown');
      if(mode==='pan')event('pointermove',{clientX:base.clientX+20});
      if(mode==='cancel')event('pointercancel');
      if(mode==='leave')event('pointerleave',{pointerType:'mouse'});
      event('pointerup',mode==='outside'?{clientX:r.right+1}:{});click();counts.push(count());
    }
    event('pointerdown',{pointerType:'mouse',button:0});event('pointerup',{pointerType:'mouse'});click();click();counts.push(count());
    button.remove();return counts;
  });
  expect(result).toEqual([1,2,3,4,5,5,5,5,5,6]);
  // 実ボタンのキーボード経路。Touch端末エミュレーションでもDOMのキー操作として区別する。
  await page.locator('#btn-start').focus();await page.keyboard.press('Enter');await expect(page.locator('#status-label')).toHaveText('計測中');
});

// ChromiumはCDPで実際のタッチ列を送り、WebKitはtouchscreen.tapを使う。
// これらはUbuntuブラウザ上の入力であり、実iOSの慣性動作ではない。
test('F-16 実ブラウザ入力: 読み物スクロール直後のタップで終了し本文と位置を保持',async({page,context,appServer,browserName})=>{
  const passphrase='v051-real-touch';await seed(page,appServer,{passphrase});await join(page,appServer,{passphrase,role:'end'});await page.click('#btn-participant');
  const start=await context.newPage();await join(start,appServer,{passphrase,role:'start'});await start.click('#btn-start');await expect(start.locator('#status-label')).toHaveText('計測中');await expect(page.locator('#status-label')).toHaveText('計測中');await expect(page.locator('#btn-detect')).toBeEnabled();
  await page.bringToFront();
  if(process.env.V051_BUTTON_TOUCH_NONE==='1')await page.addStyleTag({content:'#btn-start,#btn-end,#btn-detect { touch-action: none; }'});
  const reading=page.locator('.reading');const before=await page.locator('#passage-text').textContent();
  if(browserName==='chromium') {
    const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true});
    const box=await reading.boundingBox(),x=box.x+box.width/2,y=box.y+box.height*.8;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
    if(process.env.V051_STATIC_CONTACT==='1')await reading.evaluate(e=>{e.scrollTop=180;});
    else for(let n=1;n<=6;n++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-Math.min(180,box.height*.5)*n/6,id:1}]});
    await expect.poll(()=>reading.evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
    // 慣性が残っていても、タップ確定の時刻に本文を差し替えない。
    const button=await page.locator('#btn-detect').boundingBox();const tap={x:button.x+button.width/2,y:button.y+button.height/2,id:2};
    await page.evaluate(()=>{window.__pressEvents=[];for(const type of ['pointerdown','pointerup','pointercancel','click','touchstart','touchend','touchcancel'])document.getElementById('btn-detect').addEventListener(type,e=>window.__pressEvents.push({type:e.type,isPrimary:e.isPrimary,pointerId:e.pointerId,changedTouches:e.changedTouches?.length}),{passive:true});});
    // パンした1本目を残し、ボタン上の2本目を実タッチで追加してから離す。
    const first={x,y:y-Math.min(180,box.height*.5),id:1};
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[first,tap]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
    const events=await page.evaluate(()=>window.__pressEvents);
    await test.info().attach('native-multi-pointer.json',{body:JSON.stringify(events,null,2),contentType:'application/json'});
    expect(events.some(e=>e.type==='touchstart')).toBe(true);
  } else {
    // WebKitではCDPが使えないため枠内スクロールの直後にブラウザのタップ入力。
    await reading.evaluate(e=>{e.scrollTop=Math.min(200,e.scrollHeight-e.clientHeight);});await page.locator('#btn-detect').tap();
  }
  await expect(start.locator('#status-label')).toHaveText('待機中');await expect(start.locator('#record-count')).toHaveText('1');
  await expect(page.locator('#passage-text')).toHaveText(before);expect(await reading.evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
});
