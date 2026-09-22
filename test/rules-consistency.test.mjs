// F-8-6: js/app.js の catalogTag(選択式ラベルの符号化)が firestore.rules の
// validTagAt/validTags が要求する境界値と一致していることの検証。
//
// tools/verify.js(必須検証)はフィールド名の対応(作成時フィールドと許可
// リストの一致)を機械的に検証するが、文字列長の上限・下限といった
// 「意味的な境界値の一致」までは検証していない。ここではその隙間を補う。
// firestore.rules の実際の数値をテキストから読み取り、ハードコードしない。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readSource, extractFunction, extractConst } from "./support/extract-app-functions.mjs";
import { createPureFunctions } from "./support/sandbox.mjs";

describe("firestore.rules の tags 検証境界と js/app.js の符号化の整合", () => {
  const rules = readSource("firestore.rules");
  const { catalogTag, catalogName } = createPureFunctions();

  // firestore.rules から実際の境界値を読み取る(決め打ちしない)。
  const boundsMatch = /tags\[i\]\.size\(\) >= (\d+) && tags\[i\]\.size\(\) <= (\d+)/.exec(rules);
  assert.ok(boundsMatch, "firestore.rules の tags[i].size() 境界が見つかりません");
  const [, minSizeStr, maxSizeStr] = boundsMatch;
  const minSize = Number(minSizeStr);
  const maxSize = Number(maxSizeStr);

  const countMatch = /tags\.size\(\) <= (\d+)/.exec(rules);
  assert.ok(countMatch, "firestore.rules の tags.size() 上限が見つかりません");
  const maxCount = Number(countMatch[1]);

  const patternMatch = /tags\[i\]\.matches\('([^']+)'\)/.exec(rules);
  assert.ok(patternMatch, "firestore.rules の tags[i] 正規表現が見つかりません");
  // Firestore ルールの .matches() は文字列全体に対する完全一致なので、
  // JS 側でも ^...$ で全体一致として再現する。
  const tagPattern = new RegExp(`^(?:${patternMatch[1]})$`);

  test("catalogName の上限(40文字)から導かれる最大タグ長が、firestore.rules の上限と一致する", () => {
    // 全文字がエスケープ対象(1文字→%HHの3文字)になる最悪ケース。
    const worstGenre = ":".repeat(40);
    const worstItem = ":".repeat(40);
    const tag = catalogTag(worstGenre, worstItem);
    assert.equal(tag.length, maxSize,
      `catalogTag の最大長(${tag.length})と firestore.rules の上限(${maxSize})が一致しません`);
  });

  test("最小構成(1文字+1文字)のタグ長が、firestore.rules の下限と一致する", () => {
    const tag = catalogTag("A", "B");
    assert.equal(tag.length, minSize,
      `catalogTag の最小長(${tag.length})と firestore.rules の下限(${minSize})が一致しません`);
  });

  test("selectedTags の上限20個は firestore.rules の tags.size() 上限と一致する(js/app.js 内の記述を確認)", () => {
    const appSrc = readSource("js/app.js");
    // 20個目の拒否を行っている箇所の定数をそのまま検証する(js/app.js:2240 付近)。
    const limitMatch = /selectedTags\.size\s*>=\s*(\d+)/.exec(appSrc);
    assert.ok(limitMatch, "js/app.js の選択上限チェックが見つかりません");
    assert.equal(Number(limitMatch[1]), maxCount);
  });

  test("catalogTag が生成する典型的なタグが firestore.rules の正規表現(区切りコロン必須)を満たす", () => {
    const samples = [
      catalogTag("色", "赤"),
      catalogTag("A:B", "C"),
      catalogTag("A", "B:C"),
      catalogTag(":".repeat(40), ":".repeat(40)),
      catalogTag("A", "B"),
    ];
    for (const tag of samples) {
      assert.match(tag, tagPattern, `${JSON.stringify(tag)} が firestore.rules の正規表現を満たしません`);
      assert.ok(tag.length >= minSize && tag.length <= maxSize,
        `${JSON.stringify(tag)} の長さ(${tag.length})が firestore.rules の範囲[${minSize},${maxSize}]外です`);
    }
  });
});
