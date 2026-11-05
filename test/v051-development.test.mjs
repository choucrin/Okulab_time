import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTimedPress } from '../js/press-button.js';
import { bindFreeLabel } from '../js/free-label.js';
import { watchSequenceRecord } from '../js/sequence-watch.js';
import { passageElements } from '../js/reading-render.js';
import { AOZORA_PASSAGES } from '../js/passages-aozora.js';
import { FakeElement } from './support/sequence-app.mjs';
import { setTimeout as delay } from 'node:timers/promises';

test('押下: 非primary・click欠落、時刻保持、後続click抑止、移動・cancel・外側・期限切れ・disabled・キーボード', () => {
  const events = {}, calls = [];
  let now = 1;
  const b = { disabled: false, addEventListener: (k,f) => { events[k]=f; }, getBoundingClientRect: () => ({ left:0, right:100, top:0, bottom:100 }) };
  bindTimedPress(b, p => calls.push(p), () => ({ perfAt:performance.now(), at:now++ }));
  const fire = (type, data={}) => events[type]({ pointerId:2, pointerType:'touch', isPrimary:false, clientX:50, clientY:50, detail:1, ...data });
  fire('pointerdown'); fire('pointerdown', { pointerId:3 }); fire('pointerup', { pointerId:3 }); fire('click'); fire('pointerup'); fire('click');
  assert.deepEqual(calls.map(p=>p.at),[1]);
  for (const reason of ['move','end-move','cancel','outside','disabled','mouseleave']) {
    fire('pointerdown');
    if (reason==='move') fire('pointermove',{clientX:70});
    if (reason==='cancel') fire('pointercancel');
    if (reason==='disabled') b.disabled=true;
    if (reason==='mouseleave') fire('pointerleave',{pointerType:'mouse'});
    fire('pointerup', reason==='outside'?{clientX:101}:reason==='end-move'?{clientX:70}:{}); fire('click'); b.disabled=false;
  }
  assert.equal(calls.length,1);
  // マウスで外へ出て離した後も次の押下を取りこぼさない。
  fire('pointerdown',{pointerType:'mouse',button:0});fire('pointerleave',{pointerType:'mouse'});
  fire('pointerdown',{pointerType:'mouse',button:0});fire('pointerup',{pointerType:'mouse'});assert.equal(calls.length,2);
  fire('click',{detail:0}); assert.equal(calls.length,3);
  const expired = {}; bindTimedPress({ ...b, addEventListener:(k,f)=>{expired[k]=f;} },p=>calls.push(p),()=>({perfAt:performance.now()-16000}));
  expired.pointerdown({pointerId:1,clientX:50,clientY:50}); expired.pointerup({pointerId:1,clientX:50,clientY:50}); assert.equal(calls.length,3);
});

test('任意ラベル: 起動で書き戻さず復元・空欄保存・他タブと入力競合・保存不可', () => {
  const listeners={},window={addEventListener:(k,f)=>{listeners[k]=f;}},document={activeElement:null};
  let raw=JSON.stringify({v:1,value:'条件A'}), writes=0;
  const storage={getItem:()=>raw,setItem:(_,v)=>{raw=v;writes++;}};
  const input=new FakeElement(),hint=new FakeElement(); bindFreeLabel(input,hint,storage,window,document);
  assert.equal(input.value,'条件A'); assert.equal(writes,0);
  input.value=''; input.listeners.input[0](); assert.equal(JSON.parse(raw).value,'');
  document.activeElement=input; listeners.storage({key:'okulab-time/free-label',newValue:'{"v":1,"value":"B"}'});assert.equal(input.value,'');
  document.activeElement=null;listeners.storage({key:'okulab-time/free-label',newValue:'{"v":1,"value":"B"}'});assert.equal(input.value,'B');
  storage.setItem=()=>{throw Error('不可');}; input.listeners.input[0]();assert.match(hint.textContent,/保存できません/);
  for(const invalid of ['{','{"v":2,"value":"X"}',JSON.stringify({v:1,value:'a'.repeat(81)}),'[]']) {raw=invalid;bindFreeLabel(input,hint,storage,window,document);assert.equal(input.value,'');assert.equal(raw,invalid);}
});

test('原典DOM: rt/rpを除いた親文字、許可要素とクラス属性、旧段落の文字列を維持', () => {
  const document={createElement:t=>new FakeElement(t)};
  const nodes=passageElements(AOZORA_PASSAGES[0],document);
  const visit=node=>{assert.ok(['p','h3','span','ruby','rt','rp'].includes(node.tagName)); for(const c of node.children)visit(c);}; nodes.forEach(visit);
  const legacy=passageElements({paragraphs:['<script>文字列</script>']},document);
  assert.equal(legacy[0].textContent,'<script>文字列</script>');assert.equal(legacy[0].tagName,'p');
});

test('決着: 一時保存失敗後に保存内容を読み直して同じ確定記録を再処理、停止後は反映しない', async () => {
  let notify, calls=0, reloads=0;
  const stop=watchSequenceRecord({subscribe:f=>{notify=f;return()=>{};},fetch:async()=>null,apply:async()=>{if(++calls===1)throw Error('保存失敗');},reload:async()=>{reloads++;},report:()=>{},interval:60000});
  notify({sequenceOutcome:'confirmed'});await delay(1150);assert.equal(calls,2);assert.equal(reloads,1);
  stop();notify({sequenceOutcome:'confirmed'});await delay(5);assert.equal(calls,2);
});

test('購読停止: サーバーから最新値を取得し購読を張り直す', async () => {
  let fetches=0,subscriptions=0,last;
  const stop=watchSequenceRecord({subscribe:()=>{subscriptions++;return()=>{};},fetch:async()=>{fetches++;return {sequenceOutcome:'discarded'};},apply:async record=>{last=record;},reload:async()=>{},report:()=>{},interval:10});
  await delay(35);stop();assert.ok(fetches>=1);assert.ok(subscriptions>=2);assert.equal(last.sequenceOutcome,'discarded');
});

test('未知の本文型は警告して空要素として扱い、その後の本文を止めない', () => {
  const document={createElement:t=>new FakeElement(t)},messages=[];
  const original=console.warn;console.warn=(...v)=>messages.push(v);
  try {
    const nodes=passageElements({blocks:[null,{type:'script',text:'実行不可'},{type:'p',indent:false,content:[null,{type:'link',text:'不可'},'本文']} ]},document);
    assert.equal(nodes.map(n=>n.textContent).join(''),'本文');assert.equal(messages.length,4);
  } finally {console.warn=original;}
});

test('最初のtouchstartで採時する補完: Pointer Eventsなし・遅延到着・複数指・二重click', () => {
  const events={},calls=[];let snapshots=0;
  const button={disabled:false,addEventListener:(k,f)=>{events[k]=f;},getBoundingClientRect:()=>({left:0,right:100,top:0,bottom:100})};
  bindTimedPress(button,p=>calls.push(p),()=>({at:++snapshots,perfAt:performance.now()}));
  const t=id=>({identifier:id,clientX:50,clientY:50});const fire=(type,touches)=>events[type]({changedTouches:touches});
  fire('touchstart',[t(10)]);fire('touchstart',[t(20)]);
  events.pointerdown({pointerId:3,pointerType:'touch',clientX:50,clientY:50});
  events.pointerup({pointerId:3,clientX:50,clientY:50});assert.equal(calls.length,0);
  fire('touchend',[t(20)]);assert.equal(calls.length,0);fire('touchend',[t(10)]);
  events.click({detail:1});assert.equal(calls.length,1);assert.equal(calls[0].at,1);assert.equal(snapshots,1);
  // native pointerdownが先の場合はtouchstartで採時し直さず、touchend→pointerupでも一度だけ。
  events.pointerdown({pointerId:8,pointerType:'touch',clientX:50,clientY:50});fire('touchstart',[t(30)]);
  fire('touchend',[t(30)]);events.pointerup({pointerId:8,clientX:50,clientY:50});events.click({detail:1});
  assert.equal(calls.length,2);assert.equal(snapshots,2);
  events.pointerdown({pointerId:9,pointerType:'mouse',button:0,clientX:50,clientY:50});fire('touchstart',[t(40)]);fire('touchend',[t(40)]);
  assert.equal(calls.length,2);events.pointerup({pointerId:9,clientX:50,clientY:50});assert.equal(calls.length,3);assert.equal(snapshots,3);
});

test('Touch補完でも移動・touchcancel・pointercancel・ボタン外・disabledを計測しない', () => {
  const events={},calls=[];
  const b={disabled:false,addEventListener:(k,f)=>{events[k]=f;},getBoundingClientRect:()=>({left:0,right:100,top:0,bottom:100})};
  bindTimedPress(b,p=>calls.push(p),()=>({perfAt:performance.now()}));
  const t=(id,x=50)=>({identifier:id,clientX:x,clientY:50});const fire=(k,v)=>events[k]({changedTouches:v});
  for (const mode of ['move','end-move','touchcancel','pointercancel','outside','disabled']) {
    fire('touchstart',[t(10)]);
    if(mode==='move')fire('touchmove',[t(10,70)]);
    if(mode==='touchcancel')fire('touchcancel',[t(10)]);
    if(mode==='pointercancel')events.pointercancel({pointerId:8,pointerType:'touch'});
    if(mode==='disabled')b.disabled=true;
    fire('touchend',[t(10,mode==='outside'?101:mode==='end-move'?70:50)]);events.click({detail:1});b.disabled=false;
  }
  assert.equal(calls.length,0);
  // nativeでcancelされた指をtouchendの補完で復活させない。
  events.pointerdown({pointerId:2,pointerType:'touch',clientX:50,clientY:50});fire('touchstart',[t(20)]);
  events.pointercancel({pointerId:2,pointerType:'touch'});fire('touchend',[t(20)]);assert.equal(calls.length,0);
  fire('touchstart',[t(20)]);fire('touchend',[t(20)]);assert.equal(calls.length,1);
  events.pointerdown({pointerId:3,pointerType:'touch',clientX:50,clientY:50});events.pointercancel({pointerId:3,pointerType:'touch'});
  fire('touchstart',[t(30)]);fire('touchend',[t(30)]);assert.equal(calls.length,1);
  fire('touchstart',[t(30)]);fire('touchend',[t(30)]);assert.equal(calls.length,2);
});
