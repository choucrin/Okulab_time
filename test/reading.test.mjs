import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PASSAGE_BASELINE_COMMIT, PASSAGE_BASELINES, passageRange, passageCharacters } from '../tools/passage-baseline.mjs';
import { LONG_PASSAGES } from '../js/passages-long.js';
import { PASSAGES } from '../js/passages.js';
import { READING_SET } from '../js/reading-config.js';
import { readingDataset, validShown, selectReading } from '../js/reading.js';

test('長文10題: 空段落・識別子・段落と20字以上の文の重複・禁止語', () => {
  assert.equal(LONG_PASSAGES.length, 10);
  const ids = new Set(), paragraphs = new Set(), sentences = new Set();
  for (const p of LONG_PASSAGES) {
    assert.ok(!ids.has(p.id)); ids.add(p.id);
    const text = p.paragraphs.join('');
    assert.doesNotMatch(text, /計測|測定|合図|時計|秒|気づ|気付|検出|実験|ボタン|被験|タイマー|ストップウォッチ|してください|画面を/);
    for (const paragraph of p.paragraphs) {
      assert.ok(paragraph.trim()); assert.ok(!paragraphs.has(paragraph), p.id); paragraphs.add(paragraph);
      for (const sentence of paragraph.split('。').map(s => s.trim()).filter(s => [...s].length >= 20)) {
        assert.ok(!sentences.has(sentence), `同一文: ${p.id}: ${sentence}`); sentences.add(sentence);
      }
    }
  }
});
for (const passage of LONG_PASSAGES) {
  test(`長文 ${passage.id}: 基準の1.3〜1.4倍`, () => {
    const { min, max } = passageRange(passage.id);
    const n = passageCharacters(passage.paragraphs);
    assert.ok(n >= min && n <= max, `${passage.id}: ${n} / ${min}〜${max}`);
  });
}
test('長文の基準値が指定コミット全10題の実測と一致する', async () => {
  const source = execFileSync('git', ['show', `${PASSAGE_BASELINE_COMMIT}:js/passages-long.js`], { encoding: 'utf8' });
  const { LONG_PASSAGES: baseline } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.equal(baseline.length, 10);
  assert.deepEqual(Object.fromEntries(baseline.map(p => [p.id, passageCharacters(p.paragraphs)])), { ...PASSAGE_BASELINES });
});
test('旧短文57件の原文と順序、設定値を保持する', () => {
  assert.equal(PASSAGES.length, 57);
  assert.equal(createHash('sha256').update(JSON.stringify(PASSAGES)).digest('hex'), '574fafed221f3a9c3853af44d6fec15685ecbc0d37c75cc9a569ea6d3b114ada');
  assert.ok(['long', 'short'].includes(READING_SET));
});
test('両データセットの範囲外の既出を除き、全件一巡後も直前の文章を出さない', () => {
  for (const name of ['long', 'short', 'invalid']) {
    const d = readingDataset(name);
    const original = [null, -1, 10000, 'unknown', {}, d.passages[0].id];
    assert.deepEqual(validShown(original, d.passages), [d.passages[0].id]);
    let history = [];
    const seen = new Set();
    for (const _ of d.passages) {
      const result = selectReading(d.passages, history, () => 0);
      assert.ok(!seen.has(result.passage.id)); seen.add(result.passage.id); history = result.shown;
      assert.ok(result.passage.paragraphs.length);
    }
    const next = selectReading(d.passages, history, () => 0);
    assert.notEqual(next.passage.id, history.at(-1));
    assert.equal(original.length, 6);
  }
  assert.equal(readingDataset('invalid').key, readingDataset('long').key);
  assert.notEqual(readingDataset('short').key, readingDataset('long').key);
});
