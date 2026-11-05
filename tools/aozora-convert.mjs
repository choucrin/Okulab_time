// 保存した原典からの決定的変換。許可していない構文は失敗させる。
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export const sources = JSON.parse(readFileSync(new URL('./aozora/sources.json', import.meta.url)));
export function decodeEntities(text) {
  return text.replace(/&([^;]+);/g, (_, entity) => {
    const known = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(known, entity)) return known[entity];
    if (/^#(?:\d+|x[\da-f]+)$/i.test(entity)) return String.fromCodePoint(parseInt(entity.slice(entity[1] === 'x' ? 2 : 1), entity[1] === 'x' ? 16 : 10));
    throw new Error(`未知の実体参照: ${entity}`);
  });
}
export function sourceText(source) {
  const text = new TextDecoder('shift_jis', { fatal: true }).decode(readFileSync(new URL('./aozora/' + source.file, import.meta.url)));
  if (text.includes('\uFFFD')) throw new Error('復号失敗');
  return text;
}
export function mainText(text) {
  const start = text.indexOf('<div class="main_text">');
  if (start < 0) throw new Error('本文開始がない');
  const rest = text.slice(start + '<div class="main_text">'.length);
  let depth = 1;
  for (const match of rest.matchAll(/<div\b[^>]*>|<\/div>/g)) {
    depth += match[0] === '</div>' ? -1 : 1;
    if (!depth) return rest.slice(0, match.index).replace(/\r\n/g, '\n');
  }
  throw new Error('本文終了がない');
}
export const GAIJI_TAG = '<img src="../../../gaiji/1-94/1-94-21.png" alt="※(「骨＋低のつくり」、第3水準1-94-21)" class="gaiji" />';
function plain(text) {
  if (/[<>]/.test(text)) throw new Error('許可外の親文字・テキスト');
  return decodeEntities(text);
}
function inlines(line) {
  const content = [];
  while (line) {
    if (!line.startsWith('<')) {
      const end = line.indexOf('<');
      content.push(plain(end < 0 ? line : line.slice(0, end)));
      line = end < 0 ? '' : line.slice(end);
      continue;
    }
    const ruby = line.match(/^<ruby><rb>(.*?)<\/rb><rp>（<\/rp><rt>(.*?)<\/rt><rp>）<\/rp><\/ruby>/);
    if (ruby) {
      content.push({ type: 'ruby', base: plain(ruby[1].replaceAll(GAIJI_TAG, '骶')), text: plain(ruby[2]) });
      line = line.slice(ruby[0].length); continue;
    }
    const mark = line.match(/^(?:<em class="sesame_dot">([^<]*)<\/em>|<span class="notes">([^<]*)<\/span>)/);
    if (mark) {
      content.push({ type: mark[1] === undefined ? 'note' : 'sesame', text: plain(mark[1] ?? mark[2]) });
      line = line.slice(mark[0].length); continue;
    }
    throw new Error(`許可外の本文構文: ${line.slice(0, 100)}`);
  }
  return content;
}
export function convert(source) {
  const main = mainText(sourceText(source));
  const blocks = [];
  // 改行はXHTMLの整形、brが本文の行境界。見出しは独立ブロック。
  const lines = main.replace(/\n/g, '').split('<br />');
  for (const line of lines) {
    if (!line) { blocks.push({ type: 'blank' }); continue; }
    const heading = line.match(/^<div class="jisage_8" style="margin-left: 8em"><h4 class="naka-midashi"><a class="midashi_anchor" id="midashi(?:10|20|30|40|50)">([^<]+)<\/a><\/h4><\/div>$/);
    if (heading) { blocks.push({ type: 'heading', indentEm: 8, text: plain(heading[1]) }); continue; }
    const indent = line.startsWith('　');
    blocks.push({ type: 'p', indent, content: inlines(indent ? line.slice(1) : line) });
  }
  return { id: source.id, title: source.title, blocks };
}
export function generated() {
  return '// 自動生成。手で編集しない。原典: tools/aozora/*.sjis\n// 生成: node tools/aozora-convert.mjs (aozora-convert/1)\nexport const AOZORA_PASSAGES = ' + JSON.stringify(sources.map(convert), null, 2) + ';\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeFileSync(new URL('../js/passages-aozora.js', import.meta.url), generated());
