// F-7-9(被験者画面の読み物の文字サイズをおよそ1.2倍に拡大)の静的検証。
//
// 実ブラウザでのレイアウト・実機(iPhone/iPad)での見え方の検証ではない
// (Test.md の未検証事項を参照)。ここでは RSD.md が明示した目安の clamp 値と
// css/style.css の記述が一致していることだけを機械的に確認する。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./support/extract-app-functions.mjs";

describe("F-7-9: .reading__text の文字サイズ clamp 値", () => {
  const css = readSource("css/style.css");

  test("基準サイズ(720px未満)が RSD.md 指定の1.2倍相当と一致する", () => {
    const m = /\.reading__text\s*\{[^}]*font-size:\s*([^;]+);/.exec(css);
    assert.ok(m, ".reading__text の font-size 宣言が見つかりません");
    assert.equal(m[1].trim(), "clamp(1.03rem, 4.2vw, 1.26rem)");
  });

  test("画面幅720px以上のサイズが RSD.md 指定の1.2倍相当と一致する", () => {
    const mediaBlock = /@media \(min-width:\s*720px\)\s*\{([\s\S]*?)\n\}/.exec(css);
    assert.ok(mediaBlock, "min-width: 720px のメディアクエリが見つかりません");
    const m = /\.reading__text\s*\{[^}]*font-size:\s*([^;]+);/.exec(mediaBlock[1]);
    assert.ok(m, "720px 以上での .reading__text の font-size 宣言が見つかりません");
    assert.equal(m[1].trim(), "clamp(1.2rem, 1.92vw, 1.5rem)");
  });
});
