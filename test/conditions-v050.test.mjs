// Developmentでの動作確認。独立Test工程の受け入れ検証は後続で実施する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sequenceCondition, validateSequence, sequencePosition, validateSequenceRun } from '../js/sequence.js';
import { createHarness } from './support/sequence-app.mjs';

test('条件名: trim、80コードポイント、制御文字・型・内容未指定の拒否', () => {
  assert.equal(sequenceCondition('　 赤  '), '赤');
  assert.equal(sequenceCondition('　 '), null);
  assert.equal(sequenceCondition(undefined), null);
  assert.equal(sequenceCondition('😀'.repeat(80)), '😀'.repeat(80));
  for (const invalid of ['😀'.repeat(81), '赤\n白', '赤\u0000', 123, {}]) assert.throws(() => sequenceCondition(invalid));
  assert.throws(() => validateSequence([{ tags: [], condition: '　', count: 1 }], 1));
  assert.deepEqual(validateSequence([{ tags: [], condition: '白', count: 1 }], 5), { perSet: 1, total: 5 });
  assert.deepEqual(validateSequence([{ tags: ['色:白'], count: 1 }], 1), { perSet: 1, total: 1 });
});

test('条件名だけの3条件を5セット、記録しない後の再試行・確定後の進行・送信値の凍結', async () => {
  const h = createHarness({ catalog: [] });
  for (const name of ['赤', '白', '白点滅']) {
    h.$('sequence-condition').value = `　${name} `;
    await h.$('random-add').fire('click');
    assert.equal(h.$('sequence-condition').value, '');
  }
  await h.run('importSequence(randomDraft,5)');
  const names = [];
  for (let i = 0; i < 15; i++) {
    h.run('renderRandom()');
    assert.match(h.$('sequence-next-body').textContent, new RegExp(['赤', '白', '白点滅'][i % 3]));
    await h.run('startSequence({synced:true,at:100})');
    const first = h.stored().pending;
    assert.equal(first.payload.sequenceCondition, ['赤', '白', '白点滅'][i % 3]);
    assert.deepEqual(first.payload.tags, []);
    if (i === 0) {
      await h.notify({ mode: 'sequence', id: first.id, sequenceRunId: h.stored().id, status: 'done', sequenceOutcome: 'discarded' });
      assert.equal(h.stored().done, 0);
      await h.run('startSequence({synced:true,at:200})');
      assert.equal(h.stored().pending.payload.sequenceCondition, '赤');
    }
    const pending = h.stored().pending;
    names.push(pending.payload.sequenceCondition);
    await h.notify({ mode: 'sequence', id: pending.id, sequenceRunId: h.stored().id, status: 'done', sequenceOutcome: 'confirmed' });
  }
  assert.deepEqual(names, Array.from({ length: 15 }, (_, i) => ['赤', '白', '白点滅'][i % 3]));
  assert.equal(h.stored().status, 'completed');
  assert.equal(h.stored().attempts, 16);
});

test('条件名がないv1進行状態を変換せず読み、予定と異なる送信条件名を拒否', async () => {
  const h = createHarness();
  await h.run('importSequence([{tags:["色:白"],count:1}],1)');
  await h.run('startSequence({synced:true,at:100})');
  const run = h.stored();
  delete run.steps[0].condition; delete run.pending.payload.sequenceCondition;
  const before = JSON.stringify(run);
  assert.equal(sequencePosition(run.steps, 1, 0).condition, null);
  assert.equal(validateSequenceRun(run), run);
  assert.equal(JSON.stringify(run), before);
  run.pending.payload.sequenceCondition = '別条件';
  assert.throws(() => validateSequenceRun(run));
});

test('v.04.1ルールとの差分は作成28番目・条件名の任意指定・条件名のみの作成許可に限定', () => {
  const baseline = execFileSync('git', ['show', '3b0e1e672c026eb25a7df1dcf64aef9b7a21341d:firestore.rules'], { encoding: 'utf8' });
  const current = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const restored = current
    .replace("\n            && incoming().get('sequenceCondition', null) == null", '')
    .replace("'sequenceOutcome', 'sequenceCondition',", "'sequenceOutcome',")
    .replace(/            && \(incoming\(\)\.get\('sequenceCondition', null\) == null[\s\S]*?incoming\(\)\.get\('sequenceCondition', null\) is string\)/,
      '            && validTags(incoming().tags) && incoming().tags.size() >= 1');
  assert.equal(restored, baseline);
});
