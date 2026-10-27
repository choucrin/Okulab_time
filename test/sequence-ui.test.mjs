// F-13への置換対応表はDevelopProgress.md。旧UIの各観点を新方式で検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,chipPairs,source} from './support/sequence-app.mjs';
const steps = [{tags:['音:低','色:赤'],count:2},{tags:['色:白'],count:1}];
const install = h => h.run(`importSequence(${JSON.stringify(steps)},2)`);

test('追加条件・表示チップ・送信はクリック順でなくカタログ順、入力配列を変更しない',async()=>{
 for(const tags of [['色:赤','音:低'],['音:低','色:赤']]){
  const h=createHarness();h.run(`randomSelection=new Set(${JSON.stringify(tags)})`);h.$('random-count').value='2';
  await h.$('random-add').fire('click'); assert.equal(h.run('JSON.stringify(randomDraft[0].tags)'),'["色:赤","音:低"]');
  await h.run('importSequence(randomDraft,2)'); h.run('renderRandom()');
  assert.deepEqual(chipPairs(h.$('sequence-next-body')),[['色','赤'],['音','低']]);
  await h.run('startSequence({synced:true,at:100})');assert.deepEqual(h.log.started[0].payload.tags,['色:赤','音:低']);
 }
});
test('任意時の表示・未確定時の案内・前回なし・各区画と残数と現在位置',async()=>{
 const h=createHarness();h.run('renderRandom()');assert.equal(h.$('measurement-mode').checked,false);
 for(const id of ['random-open','random-progress','random-presets','random-interrupt'])assert.equal(h.$(id).hidden,true);
 h.run('sequenceMode="sequence";renderRandom()');assert.match(h.$('random-progress').textContent,/設定ページ/);
 await install(h);h.run('renderRandom()');
 const sections=h.$('random-progress').children;
 assert.deepEqual(sections.map(s=>s.children[0].textContent),['残り試行数','セット・位置','有効試行の完了数','実際の計測回数(再試行を含む)','前回の有効試行']);
 assert.equal(sections[0].children[1],'6 / 6 回');assert.equal(sections[4].children[1].textContent,'なし');
 assert.match(sections[1].textContent,/セット 1 \/ 2/);assert.equal(h.$('random-interrupt').disabled,false);
});
test('開閉ボタンの文言とaria-expanded、方式オフで保持しオンで同位置へ再開',async()=>{
 const h=createHarness();await install(h);await h.$('random-open').fire('click');assert.equal(h.$('random-open').getAttribute('aria-expanded'),'true');
 assert.match(h.$('random-open').textContent,/閉じる/);await h.$('random-open').fire('click');assert.equal(h.$('random-settings').hidden,true);
 const before=h.stored();h.$('measurement-mode').checked=false;await h.$('measurement-mode').fire('change');assert.equal(h.stored().mode,'free');
 h.$('measurement-mode').checked=true;await h.$('measurement-mode').fire('change');assert.equal(h.stored().mode,'sequence');assert.deepEqual(h.stored().steps,before.steps);assert.equal(h.stored().done,0);
});
test('残数付き中断、取消、再読込、中断後の新実行は破棄確認をしない',async()=>{
 const h=createHarness();await install(h);h.log.answer=false;await h.$('random-interrupt').fire('click');assert.equal(h.stored().status,'active');
 h.log.answer=true;await h.$('random-interrupt').fire('click');assert.match(h.log.confirms.at(-1),/残り 6 回を破棄/);assert.match(h.log.confirms.at(-1),/記録は残ります/);
 assert.equal(h.stored().status,'interrupted');assert.equal(h.stored().done,0);h.run('restoreSequence();renderRandom()');assert.equal(h.$('measurement-mode').checked,false);
 const count=h.log.confirms.length;await install(h);assert.equal(h.log.confirms.length,count);assert.equal(h.stored().status,'active');
});
test('計測中の中止は予約ID、確認待ち・送信待ちは中断と方式切替を禁止し出現時だけフォーカス',async()=>{
 const h=createHarness();await install(h);await h.run('startSequence({at:100,synced:true})');const p=h.stored().pending;
 assert.equal(h.$('random-interrupt').disabled,true);assert.equal(h.$('measurement-mode').disabled,true);
 await h.notify({id:p.id,mode:'sequence',sequenceRunId:p.payload.sequenceRunId,status:'running'});
 h.run('renderRandom()');assert.equal(h.$('random-interrupt').textContent,'この試行を中止');await h.$('random-interrupt').fire('click');assert.deepEqual(h.log.aborts,[p.id]);
 await h.notify({id:p.id,mode:'sequence',sequenceRunId:p.payload.sequenceRunId,status:'done',sequenceOutcome:null});
 h.run('renderRandom();renderRandom()');assert.equal(h.$('random-confirm').hidden,false);assert.equal(h.$('random-confirm').focusCount,1);assert.equal(h.$('random-interrupt').disabled,true);
});
test('空の保存欄・保存後の即時更新・上書き取消と保存上限・ページ外呼び出しと凍結',async()=>{
 const h=createHarness();h.run('sequenceMode="sequence";renderSequenceSets();renderRandom()');assert.equal(h.$('random-load').disabled,true);assert.equal(h.$('random-saved-empty').hidden,false);
 h.run(`randomDraft=${JSON.stringify(steps)}`);h.$('random-name').value='パターンA';h.$('sequence-sets').value='2';await h.$('random-save').fire('click');assert.equal(h.$('random-saved-empty').hidden,true);assert.equal(h.$('random-load').disabled,false);
 const saved=h.backend['okulab-time/sequence/sets'];h.log.answer=false;h.run('randomDraft[0].count=1');await h.$('random-save').fire('click');assert.equal(h.backend['okulab-time/sequence/sets'],saved);
 h.log.answer=true;h.$('random-saved').value='パターンA';await h.$('random-load').fire('click');assert.equal(h.$('random-settings').hidden,true);assert.equal(h.stored().total,6);
 h.run('randomDraft[0].tags[0]="別:新";catalog=[]');assert.deepEqual(h.stored().steps[0].tags,['色:赤','音:低']);assert.equal(h.backend['okulab-time/sequence/sets'],saved);
 h.saveSets(Array.from({length:50},(_,n)=>({name:'P'+n,steps:[{tags:['色:赤'],count:1}],sets:1})));h.run('randomDraft=[{tags:["色:赤"],count:1}]');h.$('random-name').value='51件目';await h.$('random-save').fire('click');assert.match(h.$('random-message').textContent,/50件/);
});
test('未完了の置換取消で旧実行を保持、呼び出すたびに新IDで初期化、計測中や不正設定は拒否',async()=>{
 const h=createHarness();await install(h);const before=h.stored();h.log.answer=false;await h.run('importSequence([{tags:["色:白"],count:1}],1)');assert.deepEqual(h.stored(),before);
 h.log.answer=true;await install(h);assert.notEqual(h.stored().id,before.id);assert.equal(h.stored().attempts,0);
 h.run('state.activeId="running"');await assert.rejects(install(h));h.run('state.activeId=null');await assert.rejects(h.run('importSequence([{tags:[],count:1}],1)'));
 assert.equal(h.stored().total,6);
});
test('保存失敗と破損復元では既存データを上書きせず、古い別タブの更新も拒否',async()=>{
 const h=createHarness();await install(h);const before=h.stored();
 h.context.localStorage.setItem=()=>{throw Error('保存不可');};await assert.rejects(h.run('mutateSequence(r=>{r.mode="free"})'),/保存不可/);assert.deepEqual(h.stored(),before);
 const a=createHarness();await install(a);const b=createHarness({backend:a.backend,locks:a.locks});b.run('restoreSequence()');
 await a.run('mutateSequence(r=>{r.mode="free"})');await assert.rejects(b.run('mutateSequence(r=>{r.mode="sequence"})'),/別のタブ/);assert.equal(b.run('sequenceMode'),'free');
 a.backend['okulab-time/sequence/room']='{broken';a.run('restoreSequence()');await assert.rejects(install(a));assert.equal(a.backend['okulab-time/sequence/room'],'{broken');
});
test('回答失敗・二重回答・サーバー未確定では消費せず、確定通知は一度だけ適用し最終試行で完了',async()=>{
 const h=createHarness();await h.run('importSequence([{tags:["色:赤"],count:1}],1)');await h.run('startSequence({at:100,synced:true})');const p=h.stored().pending;
 const record={id:p.id,mode:'sequence',sequenceRunId:p.payload.sequenceRunId,status:'done',sequenceOutcome:null};await h.notify(record);
 h.log.failDecision=true;await h.$('random-yes').fire('click');assert.equal(h.stored().done,0);assert.equal(h.$('random-confirm').hidden,false);
 h.log.failDecision=false;await h.$('random-yes').fire('click');assert.equal(h.stored().done,0);assert.equal(h.log.decisions.length,1);
 await h.notify({...record,sequenceOutcome:'confirmed'});assert.equal(h.stored().done,1);assert.equal(h.stored().attempts,1);assert.equal(h.stored().status,'completed');assert.equal(h.$('measurement-mode').checked,false);
 await h.run('settleSequence('+JSON.stringify({...record,sequenceOutcome:'confirmed'})+')');assert.equal(h.stored().attempts,1);
});
test('再読み込みで同じ予約を購読し、観測後の削除だけ計測回数へ加える',async()=>{
 const a=createHarness();await install(a);await a.run('startSequence({at:100,synced:true})');const p=a.stored().pending;
 const b=createHarness({backend:a.backend,locks:a.locks});b.run('restoreSequence()');assert.equal(b.log.subscriptions.at(-1).id,p.id);
 await b.notify(null);assert.equal(b.stored().attempts,0);assert.ok(b.stored().pending);
 await b.notify({id:p.id,mode:'sequence',sequenceRunId:p.payload.sequenceRunId,status:'running'});assert.equal(b.stored().pending.observed,true);
 await b.notify(null);assert.equal(b.stored().attempts,1);assert.equal(b.stored().done,0);assert.equal(b.stored().pending,null);
});
test('設定の項目移動・削除は番号と無効化を持ち、凍結済み実行を変更しない',async()=>{
 const h=createHarness();h.run(`randomDraft=${JSON.stringify(steps)};renderRandomSettings()`);
 const first=h.$('random-items').children[0];assert.equal(first.children[2].disabled,true);assert.match(first.children[3].getAttribute('aria-label'),/条件 1/);
 await first.children[3].fire('click');assert.equal(h.run('randomDraft[0].tags[0]'),'色:白');await h.run('importSequence(randomDraft,1)');const frozen=h.stored().steps;
 h.run('renderRandomSettings()');await h.$('random-items').children[0].children[4].fire('click');assert.equal(h.run('randomDraft.length'),1);assert.deepEqual(h.stored().steps,frozen);
});
test('記録チップの固定順と旧記録・未知方式の表示を維持する',()=>{
 const h=createHarness({catalog:[]});assert.deepEqual(chipPairs(h.run('tagCell(["音:低","パターン:縞","色:赤"])')),[['色','赤'],['パターン','縞'],['音','低']]);
 assert.equal(h.run('randomRecordText({})'),'任意');assert.equal(h.run('randomRecordText({mode:"unknown"})'),'不明');assert.equal(h.run('randomRecordText({mode:"random",randomOutcome:"discarded"})'),'ランダム / ランダム試行内のエラーデータ');
 assert.equal(h.run('randomRecordText({mode:"sequence",sequenceOutcome:"discarded"})'),'順序反復 / 順序反復試行内のエラーデータ');
 assert.match(source,/tags: sortTags\(selectedTags\)/);
});
test('カタログにないジャンルと符号化された名前の順序、呼出元の配列と中断後の凍結を保持',async()=>{
 const h=createHarness();assert.equal(h.run('JSON.stringify(sortTags(["外:B","音:低","別:A","色:赤"]))'),'["色:赤","音:低","外:B","別:A"]');
 h.run('catalog=[{name:"色:分類",items:[]}]');assert.equal(h.run('JSON.stringify(sortTags(["外:B",catalogTag("色:分類","赤")]))'),'["色%3A分類:赤","外:B"]');
 h.run(`var original=${JSON.stringify(steps)}`);const original=h.run('JSON.stringify(original)');await h.run('importSequence(original,2)');assert.equal(h.run('JSON.stringify(original)'),original);
 const frozen=h.stored().steps;h.run('renderRandom()');assert.equal(h.$('random-progress').children[0].className,'trial-section');assert.equal(h.$('sequence-next-title').textContent,'次の試行');assert.equal(h.$('sequence-next').hidden,false);
 h.context.localStorage.setItem=()=>{throw Error('保存不可');};await h.$('random-interrupt').fire('click');assert.equal(h.stored().status,'active');assert.deepEqual(h.stored().steps,frozen);
});
test('不正な保存パターンは保持、複数タブの同時保存は別名を失わず直列化',async()=>{
 const a=createHarness();a.backend['okulab-time/sequence/sets']='[{"name":"不正","steps":[],"sets":1}]';const bad=a.backend['okulab-time/sequence/sets'];
 a.run('randomDraft=[{tags:["色:赤"],count:1}]');a.$('random-name').value='新';await a.$('random-save').fire('click');assert.equal(a.backend['okulab-time/sequence/sets'],bad);
 a.backend['okulab-time/sequence/sets']='[]';const b=createHarness({backend:a.backend,locks:a.locks});
 for(const [h,name]of [[a,'A'],[b,'B']]){h.run('randomDraft=[{tags:["色:赤"],count:1}]');h.$('random-name').value=name;}
 await Promise.all([a.$('random-save').fire('click'),b.$('random-save').fire('click')]);assert.deepEqual(JSON.parse(a.backend['okulab-time/sequence/sets']).map(p=>p.name).sort(),['A','B']);
 await install(a);await a.run('startSequence({at:100,synced:true})');await assert.rejects(install(a));assert.ok(a.stored().pending);
});
test('セット数不正なら旧合計を残さない',async()=>{
 const h=createHarness();h.run(`randomDraft=${JSON.stringify(steps)};renderRandomSettings()`);h.$('sequence-sets').value='1e2';await h.$('sequence-sets').fire('input');assert.match(h.$('random-total').textContent,/総試行数: —/);assert.match(h.$('random-message').textContent,/半角数字/);
});
