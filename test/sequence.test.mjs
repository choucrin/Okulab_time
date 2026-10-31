import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sequenceInteger, validateSequence, sequencePosition, validateSequenceRun, settleSequenceRun } from '../js/sequence.js';
import { extractFunction } from './support/extract-app-functions.mjs';

const steps = [{ tags: ['色:白'], count: 2 }, { tags: ['色:赤'], count: 1 }];
function run() {
  const value = { v: 1, id: 'run', name: null, steps: structuredClone(steps), sets: 2, total: 6,
    done: 0, attempts: 0, previous: null, pending: null, status: 'active', mode: 'sequence' };
  value.pending = { id: 'session', trial: 1, receiptVersion: 1, payload: {
    mode: 'sequence', sequenceRunId: 'run', sequenceTrial: 1, sequenceSet: 1, sequencePosition: 1,
    tags: ['色:白'], uid: 'user', at: 100,
  } };
  return value;
}
test('順序反復: 白2・赤1を2セット、境界と終了位置', () => {
  assert.deepEqual(Array.from({ length: 6 }, (_, n) => sequencePosition(steps, 2, n).tags[0]),
    ['色:白', '色:白', '色:赤', '色:白', '色:白', '色:赤']);
  assert.deepEqual(sequencePosition(steps, 2, 4), { index: 0, set: 2, position: 2, repeat: 2, tags: ['色:白'], condition: null });
  assert.equal(sequencePosition(steps, 2, 6), null);
  assert.throws(() => sequencePosition(steps, 2, 7));
});
test('順序反復: 入力形式・タグ必須・上限を拒否する', () => {
  for (const n of ['', '0', '-1', '+1', '1.0', '1e2', '１', 'NaN', ' 1', '101']) assert.throws(() => sequenceInteger(n, 100, 'セット数'));
  assert.equal(sequenceInteger('100', 100, 'セット数'), 100);
  assert.throws(() => validateSequence([{ tags: [], count: 1 }], 1));
  assert.throws(() => validateSequence([{ tags: ['色:白', '色:赤'], count: 1 }], 1));
  assert.throws(() => validateSequence([{ tags: ['色:白'], count: 51 }], 1));
  assert.throws(() => validateSequence(Array.from({ length: 7 }, () => ({ tags: ['色:白'], count: 50 })), 1));
  assert.throws(() => validateSequence(steps, 1001));
  assert.throws(() => validateSequence([{ tags: ['色:白'], count: 50 }], 21));
});
test('順序反復: 記録しない・中止・消失は同じ位置、受領のみの消失は回数を増やさない', () => {
  for (const record of [
    { status: 'done', sequenceOutcome: 'discarded' }, { status: 'aborted' }, { deleted: true },
  ]) {
    const before = run(), after = settleSequenceRun(before, { id: 'session', sequenceRunId: 'run', ...record });
    assert.equal(after.done, 0); assert.equal(after.attempts, 1); assert.equal(after.pending, null);
    assert.equal(before.pending.id, 'session');
  }
  const missing = settleSequenceRun(run(), { id: 'session', sequenceRunId: 'run' }, true);
  assert.equal(missing.attempts, 0); assert.equal(missing.done, 0); assert.equal(missing.pending, null);
});
test('順序反復: サーバー未判定・別IDを無視し、有効確定の再通知で二重消費しない', () => {
  const before = run();
  assert.deepEqual(settleSequenceRun(before, { id: 'session', sequenceRunId: 'run', status: 'done' }), before);
  assert.deepEqual(settleSequenceRun(before, { id: 'other', sequenceRunId: 'run', status: 'done', sequenceOutcome: 'confirmed' }), before);
  const record = { id: 'session', sequenceRunId: 'run', status: 'done', sequenceOutcome: 'confirmed' };
  const after = settleSequenceRun(before, record);
  assert.equal(after.done, 1); assert.equal(after.attempts, 1); assert.deepEqual(after.previous, ['色:白']);
  assert.deepEqual(settleSequenceRun(after, record), after);
});
test('順序反復: 最終予定位置の拒否は完了せず、有効確定でのみ任意へ戻る', () => {
  const before = run(); before.done = 5; before.attempts = 7;
  Object.assign(before.pending, { trial: 6 });
  Object.assign(before.pending.payload, { sequenceTrial: 6, sequenceSet: 2, sequencePosition: 3, tags: ['色:赤'] });
  const base = { id: 'session', sequenceRunId: 'run', status: 'done' };
  assert.equal(settleSequenceRun(before, { ...base, sequenceOutcome: 'discarded' }).status, 'active');
  const after = settleSequenceRun(before, { ...base, sequenceOutcome: 'confirmed' });
  assert.equal(after.done, 6); assert.equal(after.status, 'completed'); assert.equal(after.mode, 'free');
  before.pending.trial = 5; assert.throws(() => validateSequenceRun(before));
});
test('Firestore: 基準版の条件は追加箇所を除いて全文一致し、旧22項目と省略/null互換を保持', () => {
  const old = execFileSync('git', ['show', 'aa3d61657be04b623a88631af7f2cf6018be1f61:firestore.rules'], { encoding: 'utf8' });
  const current = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const allow = (src) => src.match(/incoming\(\)\.keys\(\)\.hasOnly\(\[([\s\S]*?)\]\)/)[1].match(/'[^']+'/g);
  assert.equal(allow(old).length, 22);
  for (const key of allow(old)) assert.ok(allow(current).includes(key));
  for (const field of ['sequenceRunId', 'sequenceTrial', 'sequenceSet', 'sequencePosition', 'sequenceOutcome']) {
    assert.ok(current.includes(`incoming().get('${field}', null) == null`));
  }
  let restored = current;
  const added = restored.indexOf('      // 旧版が新項目を省略');
  restored = restored.slice(0, added) + restored.slice(restored.indexOf('      function validCreate()', added));
  restored = restored.replace(".data.mode in ['random', 'sequence']", ".data.mode == 'random'")
    .replace('((validRandomCreate() && emptySequence()) || validSequenceCreate())', 'validRandomCreate()')
    .replace("                 'sequenceRunId', 'sequenceTrial', 'sequenceSet', 'sequencePosition', 'sequenceOutcome', 'sequenceCondition',\n", '')
    .replace(' || validSequenceOutcome()', '');
  assert.equal(restored, old);
  assert.equal(extractFunction(current, 'validUpdate'), extractFunction(old, 'validUpdate'));
});
