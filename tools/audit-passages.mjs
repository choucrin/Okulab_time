// 本文編集の補助。共通表現の多さだけでは内容の独立性を判定できない。
// 終了0は自動検査の合格であり、F-12-2の内容レビューの代替ではない。
import { LONG_PASSAGES } from '../js/passages-long.js';
import { passageRange, passageCharacters } from './passage-baseline.mjs';

const width = 24;
const occurrences = new Map();
const lengths = [];
for (const passage of LONG_PASSAGES) {
  const range = passageRange(passage.id);
  const characters = passageCharacters(passage.paragraphs);
  lengths.push({ id: passage.id, title: passage.title, ...range, characters,
    ratio: (characters / range.baseline).toFixed(3) });
  passage.paragraphs.forEach((paragraph, index) => {
    const chars = [...paragraph.replace(/\s/gu, '')];
    // 同じ段落内の反復と、別段落への使い回しを分ける。
    const fragments = new Set();
    for (let i = 0; i <= chars.length - width; i++) {
      fragments.add(chars.slice(i, i + width).join(''));
    }
    for (const fragment of fragments) {
      if (!occurrences.has(fragment)) occurrences.set(fragment, new Map());
      const passages = occurrences.get(fragment);
      if (!passages.has(passage.id)) passages.set(passage.id, []);
      passages.get(passage.id).push(index + 1);
    }
  });
}

const repeated = [...occurrences]
  .filter(([, passages]) => passages.size >= 3)
  .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0], 'ja'));
// 隣接する24文字窓をすべて出力すると同じ表現で埋まるため、同じ
// 段落集合を示すものを一つにまとめる。本文そのものは書き換えない。
const groups = new Map();
for (const [fragment, passages] of repeated) {
  const locations = [...passages].map(([id, paragraphs]) => ({ id, paragraphs }));
  const key = JSON.stringify(locations);
  if (!groups.has(key)) groups.set(key, { example: fragment, locations });
}
const invalidLengths = lengths.filter(p => p.characters < p.min || p.characters > p.max);
console.log(JSON.stringify({
  note: '24文字以上の表現を3題以上で共有する段落を抽出。内容レビューは別途必要。',
  lengths,
  invalidLengthIds: invalidLengths.map(p => p.id),
  repeatedGroupCount: groups.size,
  repeatedGroups: [...groups.values()],
}, null, 2));
if (invalidLengths.length || groups.size) process.exitCode = 1;
