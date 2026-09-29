// Developmentの回帰確認。独立したTest工程の受け入れ検証とは別に実施する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readSource, extractFunction } from './support/extract-app-functions.mjs';
import { createSharedLockManager, createLocalStorage, createSharedStorageBackend } from './support/sandbox.mjs';
const source = readSource('js/app.js');
function setup() {
  const nodes = {};
  const backend = createSharedStorageBackend();
  const context = vm.createContext({
    localStorage: createLocalStorage(backend), navigator: { locks: createSharedLockManager() },
    $: id => nodes[id] ??= {}, confirm: () => true,
    watchRandom() {}, crypto: { randomUUID: () => 'new-batch' },
  });
  vm.runInContext(`
    const RANDOM_KEY = 'random/';
    let catalog = [{name:'色',items:['赤']},{name:'音',items:['低']}];
    let state = {roomId:'room',role:'start',busy:false,activeId:null};
    let roomEpoch = 1, randomMode = 'free', randomBatch = null, randomSnapshot = null;
    let stopRandom = null, randomRecord;
    ${['catalogTag','sortTags','validateRandomItems','chooseRandomItem','mutateRandom',
      'restoreRandom','randomMessage','importRandomItems','interruptRandom'].map(n => extractFunction(source,n)).join('\n')}
  `, context);
  return { context, run: code => vm.runInContext(code, context), backend };
}
test('タグはクリック順に依存せずカタログ順、未知ジャンルは末尾で元の順序を保つ', () => {
  const { run } = setup();
  assert.equal(run(`JSON.stringify(sortTags(['外:B','音:低','別:A','色:赤']))`), '["色:赤","音:低","外:B","別:A"]');
  assert.equal(run(`catalog = [{name:'色:分類',items:[]}]; JSON.stringify(sortTags(['外:B',catalogTag('色:分類','赤')]))`), '["色%3A分類:赤","外:B"]');
});
test('中断で残り回数や既存タグを改変せず終了し、再読込後も任意になる', async () => {
  const { run } = setup();
  await run(`importRandomItems([{tags:['音:低','色:赤'],count:3}])`);
  await run('interruptRandom()');
  run('restoreRandom()');
  assert.equal(run('randomBatch.next'), null);
  assert.equal(run('randomBatch.mode'), 'free');
  assert.equal(run('randomMode'), 'free');
  assert.equal(run('randomBatch.items[0].done'), 0);
  assert.equal(run('randomBatch.items[0].count'), 3);
  assert.equal(run(`JSON.stringify(randomBatch.items[0].tags)`), '["色:赤","音:低"]');
});
test('中断確認を取り消すと実行中バッチを保持する', async () => {
  const { run, context } = setup();
  await run(`importRandomItems([{tags:[],count:3}])`);
  context.confirm = () => false;
  await run('interruptRandom()');
  assert.equal(run('randomBatch.next'), 0);
  assert.equal(run('randomMode'), 'random');
});
test('未確定試行や計測中の中断・インポートを拒否する', async () => {
  for (const lock of ['state.activeId = "running"', 'randomBatch.pending = {id:"pending"}']) {
    const { run } = setup();
    await run(`importRandomItems([{tags:[],count:3}])`);
    run(lock);
    await run('interruptRandom()');
    await assert.rejects(run(`importRandomItems([{tags:[],count:1}])`));
    assert.equal(run('randomBatch.next'), 0);
    assert.equal(run('randomBatch.items[0].count'), 3);
  }
});
test('保存に失敗した中断は元の進行状態を保持する', async () => {
  const { run, context } = setup();
  await run(`importRandomItems([{tags:[],count:3}])`);
  context.localStorage.setItem = () => { throw new Error('保存不可'); };
  await assert.rejects(run('interruptRandom()'), /保存不可/);
  assert.equal(run('randomBatch.next'), 0);
  assert.equal(run('randomMode'), 'random');
});
test('インポートは検証と置換確認を行い、入力セットを書き換えない', async () => {
  const { run, context } = setup();
  await assert.rejects(run(`importRandomItems([{tags:[],count:0}])`));
  await run(`const saved = [{tags:['音:低','色:赤'],count:2}]; importRandomItems(saved)`);
  assert.equal(run('JSON.stringify(saved[0].tags)'), '["音:低","色:赤"]');
  context.confirm = () => false;
  await run(`importRandomItems([{tags:[],count:10}])`);
  assert.equal(run('randomBatch.items[0].count'), 2);
});
test('設定内外の呼び出しは共通インポートを通り、不要なUIを削除している', () => {
  const html = readSource('index.html');
  assert.doesNotMatch(html, /random-close|<select id="measurement-mode"|カタログはこの端末に保存され/);
  assert.match(html, /id="measurement-mode" type="checkbox" role="switch"/);
  const settings = html.slice(html.indexOf('<section id="random-settings"'), html.indexOf('</section>', html.indexOf('<section id="random-settings"')));
  assert.doesNotMatch(settings, /id="random-(saved|load)"/);
  const init = extractFunction(source, 'initRandom');
  assert.match(init, /importRandomItems\(saved.items\)/);
  assert.match(init, /importRandomItems\(randomDraft\)/);
  assert.match(source, /csvText\(s.randomBatchId \?\? ""\)/);
});
