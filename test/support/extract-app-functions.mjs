// テスト用の抽出ヘルパー。
//
// js/app.js は Firebase(CDN) の import と、49 個の DOM 要素参照を前提に
// トップレベルで実行される画面制御コードであり、Node 上でモジュール全体を
// そのまま読み込むことはできない(ネットワーク越しの import、document 未定義)。
// そこで、検証したい純粋なロジック関数の**ソースコードそのもの**を js/app.js
// から正規表現とブレース対応で切り出し、最小限のスタブ(el・localStorage・
// navigator.locks)と共に vm サンドボックスで実行することで、
// 「テスト用に書き直した別実装」ではなく「実際に出荷されるコード」を検証する。
//
// 関数の位置(行番号)がずれても壊れないよう、シグネチャ文字列とブレース対応で
// 抽出する。関数名や本体構造そのものが変わった場合は、この抽出自体が失敗し
// テストがエラーで気づける。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..", "..");

export function readSource(relPath) {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

/**
 * source 内から `functionName(` を含む関数宣言(必要なら async 修飾つき)を
 * 探し、対応する閉じ括弧までの本体全文を返す。
 */
export function extractFunction(source, functionName) {
  const signature = new RegExp(
    `(?:async\\s+)?function\\s+${functionName}\\s*\\(`
  );
  const match = signature.exec(source);
  if (!match) throw new Error(`関数 ${functionName} が見つかりません。`);
  const start = match.index;
  // 仮引数リストが分割代入(例: `{ existingOnly = false } = {}`)を含むと、
  // その中の `{` を本体の開始と誤認する。まず括弧の対応で仮引数リストの
  // 終わりを特定してから、本体の `{` を探す。
  const parenOpen = source.indexOf("(", start);
  if (parenOpen === -1) throw new Error(`関数 ${functionName} の仮引数リストが見つかりません。`);
  let parenDepth = 0;
  let paramsEnd = parenOpen;
  for (; paramsEnd < source.length; paramsEnd++) {
    if (source[paramsEnd] === "(") parenDepth++;
    else if (source[paramsEnd] === ")") {
      parenDepth--;
      if (parenDepth === 0) { paramsEnd++; break; }
    }
  }
  const braceOpenRel = source.indexOf("{", paramsEnd);
  if (braceOpenRel === -1) throw new Error(`関数 ${functionName} の本体開始が見つかりません。`);
  let depth = 0;
  let i = braceOpenRel;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  if (depth !== 0) throw new Error(`関数 ${functionName} の閉じ括弧が対応していません。`);
  return source.slice(start, i);
}

/** `const NAME = value;` 形式の宣言をそのまま取り出す(定数の実値を検証するため)。 */
export function extractConst(source, constName) {
  const re = new RegExp(`const\\s+${constName}\\s*=\\s*([^;\\n]+);?`);
  const match = re.exec(source);
  if (!match) throw new Error(`定数 ${constName} が見つかりません。`);
  return match[1].trim();
}
