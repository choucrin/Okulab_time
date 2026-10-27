// Developmentで実際の保存処理を検証する。独立Testは後続工程。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './support/sequence-app.mjs';
const entry = (name, condition = '赤') => ({ name, steps: [{ tags: [], condition, count: 1 }], sets: 2 });
const key = 'okulab-time/sequence/sets';
const edit = (h, source, next) => h.run(`patternSource={name:${JSON.stringify(source.name)},json:${JSON.stringify(JSON.stringify(source))}};patternEdit=${JSON.stringify(next)}`);

test('管理: 名前・条件名・ラベル・回数・セットを保存、実行中の凍結と順序を維持', async () => {
  const h = createHarness(); const a = entry('A'), b = entry('B'); h.saveSets([a, b]);
  await h.run(`importSequence(${JSON.stringify(a.steps)},2,"A")`);
  const before = JSON.stringify(h.stored());
  const changed = { name: '新しいA', steps: [{ tags: ['削除済み:ラベル'], condition: '白', count: 3 }], sets: 4 };
  edit(h, a, changed); await h.run('savePattern()');
  assert.deepEqual(JSON.parse(h.backend[key]), [changed, b]);
  assert.equal(JSON.stringify(h.stored()), before);
  assert.match(h.$('patterns-message').textContent, /保存しました/);
  assert.equal(h.$('random-saved').options[0].textContent, '新しいA');
  const next = createHarness({ backend: h.backend, locks: h.locks });
  next.run('restoreSequence();renderSequenceSets()'); next.$('random-saved').value = '新しいA';
  await next.$('random-load').fire('click');
  assert.equal(next.stored().total, 12); assert.equal(next.stored().steps[0].condition, '白');
});

test('管理: 衝突時は取消で保持、承認時だけ上書きし元位置を維持', async () => {
  const h = createHarness(); const a = entry('A'), b = entry('B'), c = entry('C'); h.saveSets([a,b,c]);
  const changed = entry('A','白'); edit(h,c,changed);
  h.log.answer = false; await h.run('savePattern()');
  assert.deepEqual(JSON.parse(h.backend[key]), [a,b,c]);
  assert.match(h.log.confirms.at(-1), /上書きしますか/);
  assert.ok(h.run('patternEdit'));
  h.log.answer = true; await h.run('savePattern()');
  assert.deepEqual(JSON.parse(h.backend[key]), [b,changed]);
});

test('管理: 古い編集・削除、破損データ、不正値、書込失敗で保全し成功表示しない', async () => {
  const a = entry('A');
  for (const mode of ['changed','deleted','corrupt','invalid','write-failed']) {
    const h = createHarness(); h.saveSets([a]); edit(h,a,entry('変更'));
    if (mode === 'changed') h.saveSets([entry('A','白')]);
    if (mode === 'deleted') h.saveSets([]);
    if (mode === 'corrupt') h.backend[key] = '{broken';
    if (mode === 'invalid') h.run('patternEdit.steps[0].condition="　"');
    if (mode === 'write-failed') h.run('localStorage.setItem=()=>{throw Error("quota")};');
    const before = h.backend[key]; await h.run('savePattern()');
    assert.equal(h.backend[key],before,mode);
    assert.doesNotMatch(h.$('patterns-message').textContent,/保存しました/);
    assert.ok(h.run('patternEdit'));
    if (['changed','deleted'].includes(mode)) assert.match(h.$('patterns-message').textContent,/別のタブ/);
  }
});

test('管理: 削除取消・承認・最後の1件、他の保存領域と進行状態を保持', async () => {
  const h = createHarness(), a = entry('A'); h.saveSets([a]);
  h.backend['okulab-time/catalog'] = 'keep';
  await h.run(`importSequence(${JSON.stringify(a.steps)},2)`);
  const before = JSON.stringify(h.stored());
  h.log.answer = false; await h.run(`deletePattern(${JSON.stringify(a)})`);
  assert.deepEqual(JSON.parse(h.backend[key]),[a]);
  h.log.answer = true; await h.run(`deletePattern(${JSON.stringify(a)})`);
  assert.deepEqual(JSON.parse(h.backend[key]),[]);
  assert.equal(h.$('random-saved').options.length,0);
  assert.match(h.$('patterns-list').textContent,/ありません/);
  assert.equal(h.backend['okulab-time/catalog'],'keep');
  assert.equal(JSON.stringify(h.stored()),before);
});

test('管理: 開始送信中・計測中・判定待ち・busyは保存と削除を拒否', async () => {
  const h = createHarness(), a = entry('A'); h.saveSets([a]); edit(h,a,entry('変更'));
  await h.run(`importSequence(${JSON.stringify(a.steps)},2)`);
  await h.run('startSequence({synced:true,at:100})');
  const before = h.backend[key]; await h.run('savePattern()'); await h.run(`deletePattern(${JSON.stringify(a)})`);
  assert.equal(h.backend[key],before);
  assert.match(h.$('patterns-lock').textContent,/計測と判定/);
  h.run('sequenceRun.pending=null;state.busy=true');
  await h.run('savePattern()'); assert.equal(h.backend[key],before);
});

test('管理: 同じ項目の同時編集は片方だけ保存し、別項目の編集は両方残す', async () => {
  for (const same of [true, false]) {
    const a = createHarness(), originalA = entry('A'), originalB = entry('B'); a.saveSets([originalA, originalB]);
    const b = createHarness({ backend: a.backend, locks: a.locks });
    edit(a, originalA, entry('変更A'));
    edit(b, same ? originalA : originalB, entry('変更B'));
    await Promise.all([a.run('savePattern()'), b.run('savePattern()')]);
    const names = JSON.parse(a.backend[key]).map(item => item.name);
    assert.equal(names.length, 2);
    if (same) {
      assert.ok(names.includes('B'));
      assert.ok(names.includes('変更A') !== names.includes('変更B'));
      assert.match(a.$('patterns-message').textContent + b.$('patterns-message').textContent, /別のタブ/);
    } else assert.deepEqual(names, ['変更A', '変更B']);
  }
});

test('管理: 保存値だけにある削除済みラベルを編集画面で選択済みとして表示する', () => {
  const h = createHarness({ catalog: [] });
  h.run('patternEdit={name:"旧",steps:[{tags:["削除済み:ラベル"],count:1}],sets:1};renderPatternEditor()');
  assert.match(h.$('patterns-editor').textContent, /削除済み:ラベル \(カタログ登録なし\)/);
  const choices = h.$('patterns-editor').find('catalog-choice');
  assert.equal(choices.length, 1); assert.equal(choices[0].children[0].checked, true);
});
