// 原典HTMLは実行時に読み込まない。許可した型だけをDOM APIで描画する。
export function passageElements(passage, document) {
  const warn = value => console.warn('未知の読み物データ', value);
  // 旧データは従来どおり段落へ直接textContentを設定し、DOMと改行計測を保つ。
  if (!passage.blocks) return passage.paragraphs.map(text => {
    const p = document.createElement('p'); p.textContent = text; return p;
  });
  return passage.blocks.map(block => {
    const node = document.createElement(block?.type === 'heading' ? 'h3' : block?.type === 'p' ? 'p' : 'span');
    if (block?.type === 'blank') node.className = 'reading-blank';
    else if (block?.type === 'heading') { node.className = 'reading-heading'; node.textContent = block.text; }
    else if (block?.type === 'p') {
      node.className = block.indent ? 'reading-indent' : 'reading-no-indent';
      for (const inline of block.content) {
        if (typeof inline === 'string') { const span = document.createElement('span'); span.textContent = inline; node.append(span); }
        else if (inline?.type === 'ruby') {
          const ruby = document.createElement('ruby'); ruby.textContent = inline.base;
          for (const [tag, text] of [['rp', '（'], ['rt', inline.text], ['rp', '）']]) { const child = document.createElement(tag); child.textContent = text; ruby.append(child); }
          node.append(ruby);
        } else if (inline?.type === 'sesame' || inline?.type === 'note') { const span = document.createElement('span'); span.className = 'reading-' + inline?.type; span.textContent = inline.text; node.append(span); }
        else warn(inline);
      }
    } else warn(block);
    return node;
  });
}
