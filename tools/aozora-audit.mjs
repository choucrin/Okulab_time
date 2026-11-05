import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AOZORA_PASSAGES } from '../js/passages-aozora.js';
import { sources, generated, sourceText, mainText, decodeEntities, GAIJI_TAG } from './aozora-convert.mjs';
export function auditAozora() {
  assert.equal(readFileSync(new URL('../js/passages-aozora.js', import.meta.url), 'utf8'), generated());
  return sources.map((source, i) => {
    const bytes = readFileSync(new URL('./aozora/' + source.file, import.meta.url));
    assert.equal(bytes.length, source.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
    const raw = mainText(sourceText(source));
    // 期待値はブロック変換を使わず原典から直接作る。
    const reference = decodeEntities(raw.replaceAll(GAIJI_TAG, '骶').replace(/<r[tp]>[\s\S]*?<\/r[tp]>/g, '').replace(/\n/g, '').replaceAll('<br />', '\n').replace(/<[^>]*>/g, ''));
    const passage = AOZORA_PASSAGES[i];
    const actual = passage.blocks.map(b => b.type === 'blank' ? '' : b.type === 'heading' ? b.text : (b.indent ? '　' : '') + b.content.map(c => typeof c === 'string' ? c : c.type === 'ruby' ? c.base : c.text).join('')).join('\n');
    assert.equal(actual, reference);
    const rubies = [...raw.matchAll(/<ruby><rb>(.*?)<\/rb><rp>（<\/rp><rt>(.*?)<\/rt><rp>）<\/rp><\/ruby>/g)].map(m => [decodeEntities(m[1].replaceAll(GAIJI_TAG, '骶')), decodeEntities(m[2])]);
    const inline = passage.blocks.flatMap(b => b.content ?? []);
    assert.deepEqual(inline.filter(c => c.type === 'ruby').map(c => [c.base, c.text]), rubies);
    const headings = passage.blocks.filter(b => b.type === 'heading').length;
    assert.equal(headings, (raw.match(/<h4 /g) ?? []).length);
    for (const [type, pattern] of [['sesame', /<em /g], ['note', /<span class="notes">/g]]) assert.equal(inline.filter(c => c.type === type).length, (raw.match(pattern) ?? []).length);
    const gaiji = (raw.match(/<img /g) ?? []).length;
    assert.equal(gaiji, i === 0 ? 1 : 0);
    const gaijiAlt = [...raw.matchAll(/<img\b[^>]*\balt="([^"]+)"[^>]*>/g)].map(m => decodeEntities(m[1]));
    const conversions = source.gaiji ?? [];
    assert.equal(conversions.length, gaiji);
    assert.deepEqual(conversions.map(g => g.alt), gaijiAlt);
    for (const g of conversions) {
      assert.equal(g.jis, '1-94-21'); assert.equal(g.replacement, '骶'); assert.equal(g.unicode, 'U+9AB6');
      assert.ok(actual.includes(g.replacement));
    }
    const blankLines = passage.blocks.filter(b => b.type === 'blank').length;
    assert.equal(blankLines, reference.split('\n').filter(l => !l).length);
    assert.equal(passage.blocks.length, reference.split('\n').length);
    assert.doesNotMatch(actual, /底本：|入力：|校正：|青空文庫作成ファイル|表記について/);
    const chars = [...actual.replace(/\s/gu, '')];
    return { id: source.id, title: source.title, sourceSha256: source.sha256, rubyCount: rubies.length, characters: chars.length, headings, blankLines, gaiji, gaijiConversions: conversions,
      rubySamples: [rubies[0], rubies[Math.floor(rubies.length / 2)], rubies.at(-1)],
      textSamples: [chars.slice(0,50).join(''), chars.slice(Math.floor(chars.length/2), Math.floor(chars.length/2)+50).join(''), chars.slice(-50).join('')], matched: true };
  });
}
