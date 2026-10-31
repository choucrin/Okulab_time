// v.05.0: 旧ランダム操作は廃止。過去記録の表示互換は維持する。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPureFunctions } from './support/sandbox.mjs';

describe("F-9-12: 記録の方式・判定表示(randomOutcomeText/randomRecordText)", () => {
  const { randomOutcomeText, randomRecordText } = createPureFunctions();

  test("任意方式の記録は方式表示が『任意』になる", () => {
    assert.equal(randomRecordText({ mode: "free" }), "任意");
  });

  test("mode フィールドが無い旧記録は『任意』として扱う(後方互換)", () => {
    assert.equal(randomRecordText({}), "任意");
    assert.equal(randomOutcomeText({}), "");
  });

  test("ランダム方式は判定に応じて『有効』『ランダム試行内のエラーデータ』『未確定』を返す", () => {
    assert.equal(randomOutcomeText({ mode: "random", randomOutcome: "confirmed" }), "有効");
    assert.equal(randomOutcomeText({ mode: "random", randomOutcome: "discarded" }), "ランダム試行内のエラーデータ");
    assert.equal(randomOutcomeText({ mode: "random", randomOutcome: null }), "未確定");
  });

  test("ランダム方式の記録表示にバッチ識別子を含めない(F-10-9)", () => {
    const text = randomRecordText({ mode: "random", randomBatchId: "batch-xyz", randomOutcome: "confirmed" });
    assert.doesNotMatch(text, /batch-xyz/);
    assert.match(text, /有効/);
  });
});


test('旧ランダム設定・破損バッチ・確認待ちは読まず変更せず、新しい順序反復を妨げない', async () => {
  const { createHarness, source } = await import('./support/sequence-app.mjs');
  for (const value of ['{broken', JSON.stringify({pending:{id:'old'},next:0}), 'null']) {
    const h = createHarness();
    h.backend['okulab-time/random/sets'] = value;
    h.backend['okulab-time/random/room'] = value;
    const before = JSON.stringify(h.backend);
    h.run('restoreSequence();renderSequenceSets();renderRandom()');
    assert.equal(JSON.stringify(h.backend), before);
    await h.run('importSequence([{tags:[],condition:"赤",count:1}],1)');
    await h.run('startSequence({synced:true,at:100})');
    const pending = h.stored().pending;
    await h.notify({ mode:'sequence',id:pending.id,sequenceRunId:h.stored().id,status:'done',sequenceOutcome:'confirmed' });
    assert.equal(h.stored().status,'completed');
    assert.equal(h.backend['okulab-time/random/sets'],value);
    assert.equal(h.backend['okulab-time/random/room'],value);
  }
  for (const name of ['restoreRandom','watchRandom','settleRandom','mutateRandom','interruptRandom','readRandomSets','chooseRandomItem','validateRandomItems']) {
    assert.doesNotMatch(source,new RegExp(`function ${name}\\(`));
  }
  assert.doesNotMatch(source,/okulab-time\/random\//);
});
