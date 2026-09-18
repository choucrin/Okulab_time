#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  整合性チェック
//
//  ビルド工程を持たない構成のため、壊れた状態でも「とりあえず動く」
//  ように見えてしまう。公開前に機械的に検証する。
//
//  とくに Firestore ルールと送信フィールドの照合は重要で、
//  1 つでもずれると書き込みが拒否され、計測が開始できなくなる。
//
//  使い方: node tools/verify.js
//  終了コード: 0 = 合格 / 1 = 不合格
// ─────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// 検査そのものも対象に含める(この道具の欠陥で公開が止まるため)
const JS_FILES = [
  "js/app.js", "js/clock.js", "js/store.js", "js/passages.js", "js/firebase-config.js",
  "tools/verify.js",
];

let failed = 0;
const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    failed += 1;
  }
}

/** 前提が崩れたら黙って合格させず、失敗として扱う */
function must(condition, message) {
  if (!condition) throw new Error(message);
}

// ── 1. 構文チェック ──────────────────────────────────────────

check("JavaScript の構文", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-"));
  try {
    for (const file of JS_FILES) {
      // ESM として解釈させるため .mjs に写してから検査する
      const tmp = join(dir, basename(file, ".js") + ".mjs");
      writeFileSync(tmp, read(file));
      try {
        execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
      } catch (err) {
        throw new Error(`${file}: ${String(err.stderr ?? err).split("\n").slice(0, 3).join(" ")}`);
      }
    }
    return `${JS_FILES.length} ファイル`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("JSON の構文", () => {
  JSON.parse(read("manifest.webmanifest"));
  return "manifest.webmanifest";
});

// ── 2. HTML の id と JS の参照 ───────────────────────────────

check("HTML の id と JS の参照", () => {
  const html = read("index.html");
  const js = read("js/app.js");

  const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const jsIds = new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));

  must(htmlIds.size > 0 && jsIds.size > 0, "id を抽出できませんでした(検査方法の見直しが必要です)");

  const missing = [...jsIds].filter((id) => !htmlIds.has(id));
  must(missing.length === 0, `JS が参照するが HTML に無い id: ${missing.join(", ")}`);

  const unused = [...htmlIds].filter((id) => !jsIds.has(id));
  must(unused.length === 0, `HTML にあるが JS が参照しない id: ${unused.join(", ")}`);

  return `${jsIds.size} 個が一致`;
});

// ── 3. 使用クラスと CSS 定義 ─────────────────────────────────

check("使用クラスと CSS 定義", () => {
  const html = read("index.html");
  const js = read("js/app.js");
  const css = read("css/style.css");

  const used = new Set([
    ...[...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)),
    ...[...js.matchAll(/(?:classList\.(?:add|toggle|remove)\("|className = ")([a-z0-9 _-]+)/g)]
      .flatMap((m) => m[1].split(/\s+/)),
  ].filter(Boolean));

  const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));

  must(used.size > 0 && defined.size > 0, "クラスを抽出できませんでした");

  const missing = [...used].filter((c) => !defined.has(c));
  must(missing.length === 0, `CSS に定義が無いクラス: ${missing.join(", ")}`);

  return `${used.size} 個を確認`;
});

// ── 4. Firestore ルールと送信フィールド ──────────────────────

check("Firestore ルールと送信フィールド", () => {
  const rules = read("firestore.rules");
  const store = read("js/store.js");

  // ルール側の許可リストを取り出す
  const lists = [...rules.matchAll(/hasOnly\(\[([\s\S]*?)\]\)/g)]
    .map((m) => (m[1].match(/'[^']+'/g) ?? []).map((s) => s.slice(1, -1)));
  must(lists.length >= 3, `hasOnly の許可リストを 3 つ以上検出できませんでした(検出: ${lists.length}）`);

  const createAllow = lists.find((l) => l.includes("startMs"));
  const updateAllow = lists.find((l) => l.includes("durationSec") && !l.includes("startMs"));
  const metaAllow = lists.find((l) => l.includes("activeSessionId"));
  must(createAllow, "作成用の許可リストを特定できませんでした");
  must(updateAllow, "更新用の許可リストを特定できませんでした");
  must(metaAllow, "meta 用の許可リストを特定できませんでした");

  // 作成時に送るフィールド
  const createBlock = store.match(/tx\.set\(ref, \{([\s\S]*?)\n    \}\)/);
  must(createBlock, "作成時の送信フィールドを抽出できませんでした");
  const createFields = [...createBlock[1].matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]);
  must(createFields.length > 0, "作成時の送信フィールドが 0 件でした");

  const createExtra = createFields.filter((f) => !createAllow.includes(f));
  must(createExtra.length === 0, `作成時に送るがルールが許可していない: ${createExtra.join(", ")}`);
  must(
    createFields.length === createAllow.length,
    `作成フィールド数がルールと不一致(送信 ${createFields.length} / 許可 ${createAllow.length})`
  );

  // 更新時に送るフィールド
  const updateBlocks = [...store.matchAll(/tx\.update\(ref, \{([\s\S]*?)\}\);/g)]
    .map((m) => [...m[1].matchAll(/(\w+):/g)].map((x) => x[1]));
  must(updateBlocks.length >= 2, `更新処理を 2 つ以上検出できませんでした(検出: ${updateBlocks.length}）`);

  for (const [i, fields] of updateBlocks.entries()) {
    const extra = fields.filter((f) => !updateAllow.includes(f));
    must(extra.length === 0, `更新処理 #${i + 1} が許可外のフィールドを送信: ${extra.join(", ")}`);
  }

  // 排他制御ドキュメントに書き込むキー
  const metaBlocks = [...store.matchAll(/tx\.set\(cur, \{([\s\S]*?)\}\)/g)]
    .map((m) => [...m[1].matchAll(/(\w+):/g)].map((x) => x[1]));
  must(metaBlocks.length > 0, "meta への書き込みを検出できませんでした");

  for (const [i, keys] of metaBlocks.entries()) {
    const extra = keys.filter((k) => !metaAllow.includes(k));
    must(extra.length === 0, `meta 書き込み #${i + 1} が許可外のキーを送信: ${extra.join(", ")}`);
  }

  return `作成 ${createFields.length} / 更新 ${updateBlocks.length} 箇所 / meta ${metaBlocks.length} 箇所`;
});

// ── 5. エラーコードと文言 ────────────────────────────────────

check("エラーコードと文言テーブル", () => {
  const store = read("js/store.js");
  const app = read("js/app.js");

  // code: "X" と code: cond ? "X" : "Y" の両方を拾う。
  // コードは app.js 側でも作るため、両方を見ないと文言の抜けを見逃す。
  const codes = new Set(
    [store, app]
      .flatMap((src) => [...src.matchAll(/code: (?:\w+ \? )?"(\w+)"(?: : "(\w+)")?/g)])
      .flatMap((m) => [m[1], m[2]])
      .filter(Boolean)
  );
  must(codes.size > 0, "エラーコードを抽出できませんでした");

  const table = read("js/app.js").match(/function describeCode\(code\) \{([\s\S]*?)\n\}/);
  must(table, "describeCode の定義を抽出できませんでした");
  const defined = new Set([...table[1].matchAll(/^\s+(\w+):\s+/gm)].map((m) => m[1]));

  const missing = [...codes].filter((c) => !defined.has(c));
  must(missing.length === 0, `文言テーブルに無いコード: ${missing.join(", ")}`);

  return `${codes.size} 個: ${[...codes].sort().join(", ")}`;
});

// ── 6. バージョン表記の一致 ──────────────────────────────────

check("バージョン表記の一致", () => {
  const sources = {
    "js/app.js": read("js/app.js").match(/APP_VERSION = "([^"]+)"/)?.[1],
    "index.html": read("index.html").match(/id="version">([^<]+)</)?.[1],
    "RSD.md": read("RSD.md").match(/\|\s*現行バージョン\s*\|\s*(v\.[\d.]+)\s*\|/)?.[1],
    "ProgressReport.md": read("ProgressReport.md").match(/現行バージョン:\s*\*\*(v\.[\d.]+)\*\*/)?.[1],
    "REVIEW.md": read("REVIEW.md").match(/現行バージョン:\s*\*\*(v\.[\d.]+)\*\*/)?.[1],
  };

  for (const [file, version] of Object.entries(sources)) {
    must(version, `${file} からバージョンを抽出できませんでした`);
  }

  const unique = [...new Set(Object.values(sources))];
  must(
    unique.length === 1,
    "バージョンが不一致: " +
      Object.entries(sources).map(([f, v]) => `${f}=${v}`).join(", ")
  );

  return unique[0];
});

// ── 7. Firebase 設定が未記入のまま公開されていないか ─────────

check("Firebase 設定の記入", () => {
  const config = read("js/firebase-config.js");
  const required = ["apiKey", "authDomain", "projectId", "appId"];

  for (const key of required) {
    const value = config.match(new RegExp(`${key}:\\s*"([^"]*)"`))?.[1];
    must(value, `${key} を抽出できませんでした`);
    must(!value.startsWith("YOUR_"), `${key} がプレースホルダのままです`);
  }
  return "必須 4 項目が記入済み";
});

// ── 8. 定数の宣言漏れ ────────────────────────────────────────
//
//  構文チェック(--check)は未宣言の変数を検出できない。実際、
//  打ち切り時間の定数が宣言されないまま公開され、一括削除が
//  「Can't find variable」で失敗する不具合が公開後に見つかった。
//
//  そこで大文字の定数(EXAMPLE_NAME 形式)に限って、参照先が
//  同じファイルで宣言または import されているかを照合する。
//  検出漏れは許すが、誤検出はしない側に倒している
//  (検査の失敗はデプロイを止めるため)。

/** 括弧を伴うが仮引数ではないもの(検査より前に初期化しておく) */
const CONTROL_KEYWORDS = new Set([
  "if", "while", "for", "switch", "catch", "with", "return", "typeof", "do", "else",
]);

/** 大文字だけで書かれた組み込み。宣言が無くて当たり前のもの */
const CAPITAL_GLOBALS = new Set(["JSON", "URL", "CSS"]);

/** 括弧の前後を何文字まで見るか(function や => の判定に足りればよい) */
const LOOKAROUND = 80;

check("定数の宣言漏れ", () => {
  let referenced = 0;

  for (const file of JS_FILES) {
    const code = stripLiterals(read(file));
    const declared = declaredNames(code);

    // 直前が . なら属性、# なら私有フィールドで、どちらも参照ではない。
    // 下線を含まない名前(REJECTED など)も定数として使うため対象にする。
    const used = new Set();
    for (const m of code.matchAll(/(?<![.#\w$])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)\b/g)) {
      if (CAPITAL_GLOBALS.has(m[1])) continue;
      if (!isNamePosition(code, m.index, m[0].length)) used.add(m[1]);
    }

    const missing = [...used].filter((name) => !declared.has(name));
    must(
      missing.length === 0,
      `${file} が宣言されていない定数を参照しています: ${missing.join(", ")}`
    );
    referenced += used.size;
  }

  // 抽出そのものが壊れると、何も見ずに合格してしまう
  must(referenced > 0, "定数の参照を 1 つも抽出できませんでした");

  return `${referenced} 個の参照を確認`;
});

/**
 * 値の参照ではなく、名前として書かれているか。
 * オブジェクトのキー({ FOO: 1 })と、ラベルの定義・参照
 * (FOO: for (…) / break FOO)が該当する。
 * 三項演算子の真の側(x ? FOO : y)や case FOO: は参照なので除外しない。
 */
function isNamePosition(code, index, length) {
  const before = code.slice(0, index).trimEnd();

  if (/\b(?:break|continue)$/.test(before)) return true;

  if (!/^\s*:/.test(code.slice(index + length))) return false;
  if (!before) return true;                       // ファイル先頭のラベル
  return "{,;}".includes(before[before.length - 1]);
}

/**
 * そのファイルで束縛されている名前。
 *
 * 取りこぼすと正しいコードを不合格にし、デプロイまで止めてしまう。
 * そのため束縛の拾い方は広めにし、判断に迷う場合は
 * 「宣言されている」側に倒す(検出漏れのほうが害が小さい)。
 */
function declaredNames(code) {
  const names = new Set();
  const add = (text) => {
    for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) names.add(m[0]);
  };
  // 初期値・既定値は束縛ではない。ここを取り違えると、
  // 既定値の中で参照した定数を「宣言済み」と誤って扱ってしまう。
  const addBindings = (text, options) => {
    for (const target of bindingTargets(text, options)) add(target);
  };

  // 宣言は初期値の中にも入れ子になるため、本体をまとめて読まずに
  // キーワードの位置だけを拾い、そこから文の区切りまでを個別に見る。
  // for (const x of LIST) の LIST は束縛ではないので of / in の手前まで。
  for (const m of code.matchAll(/\b(?:const|let|var)\s+/g)) {
    const body = statementBody(code.slice(m.index + m[0].length));
    addBindings(body.replace(/\b(?:of|in)\b[\s\S]*$/, ""), { stopAtNewline: true });
  }

  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);

  // 関数・メソッド・arrow・catch の束縛。
  // 仮引数には既定値として呼び出しを書けるため、括弧の対応を数えて取り出す
  // (単純な [^()]* では f(1) を含む仮引数を取りこぼす)。
  for (const group of parenGroups(code)) {
    const before = code.slice(Math.max(0, group.start - LOOKAROUND), group.start).trimEnd();
    const after = code.slice(group.end + 1, group.end + 1 + LOOKAROUND).trimStart();
    const word = before.match(/[A-Za-z_$][\w$]*$/)?.[0] ?? "";

    const isFunction = /\bfunction$/.test(before) || /\bfunction\s+[A-Za-z_$][\w$]*$/.test(before);
    const isArrow = after.startsWith("=>");
    const isCatch = word === "catch";
    // if / while などの制御構文を仮引数と取り違えないよう、名前で除く
    const isMethod = after.startsWith("{") && word !== "" && !CONTROL_KEYWORDS.has(word);

    if (!isFunction && !isArrow && !isCatch && !isMethod) continue;
    if ((isFunction || isMethod) && word !== "" && word !== "function") names.add(word);
    addBindings(group.inner);
  }

  // 括弧を省いた arrow の仮引数(MS => …)。括弧付きは上で拾っている
  for (const m of code.matchAll(/(?<![.#\w$)])([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);

  // class のフィールド。1 行に詰めて書くこともあるため、
  // 行頭だけでなく { と ; の直後も見る。
  //
  // 同じ形の「文の先頭に置かれた代入」は束縛として数えない。
  // const を書き忘れた代入(COMMIT_TIMEOUT_MS = 15000)は、
  // 厳格モードでは読み込み時に ReferenceError になり、画面ごと落ちる。
  // 束縛として数えると、その書き忘れを検査が見逃してしまう。
  const classBodies = classBodyRanges(code);
  for (const m of code.matchAll(/(?:^|[{;])[ \t]*(?:static\s+)?#?([A-Za-z_$][\w$]*)\s*=[^=]/gm)) {
    // 直前の { は本体の外側にあたるため、名前の側の位置で判定する
    const at = m.index + m[0].length;
    if (classBodies.some(([from, to]) => at > from && at <= to)) names.add(m[1]);
  }

  // import { a, b as c } / export { d as e }。別名と元の名前の両方を数える。
  for (const m of code.matchAll(/\b(?:import|export)\s*\{([^}]*)\}/g)) add(m[1]);
  // import d from … / import * as e from … / import d, { f } from …。
  // 副作用だけの import(from を持たない)を挟んでも次の文へ食い込まないよう、
  // 文の区切りを越えない。
  for (const m of code.matchAll(/\bimport\s+([^;]*?)\s+from\b/g)) add(m[1]);

  return names;
}

/**
 * 対応の取れた丸括弧をすべて拾う(入れ子も含む)。
 * 仮引数には f(1) のような既定値を書けるため、単純な正規表現では
 * 括弧の中で切れてしまう。
 */
function parenGroups(code) {
  const groups = [];
  const opens = [];

  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === "(") opens.push(i);
    else if (code[i] === ")") {
      const start = opens.pop();
      if (start !== undefined) groups.push({ start, end: i, inner: code.slice(start + 1, i) });
    }
  }

  return groups;
}

/**
 * 文の終わりまでを返す。
 *
 * 区切りは深さ 0 のセミコロン。初期値に書いた関数の中のセミコロンで
 * 切ってしまうと、その後ろの宣言(const A = 1, f = () => { g(); }, B = 2 の
 * B)を取りこぼし、正しいコードを不合格にする。
 * for (const x of y) のように括弧が先に閉じる場合は、そこまでを返す。
 */
function statementBody(text) {
  let depth = 0;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) {
      depth -= 1;
      if (depth < 0) return text.slice(0, i);
    } else if (c === ";" && depth === 0) return text.slice(0, i);
  }

  return text;
}

/**
 * class 本体のうち、フィールドを書ける位置の範囲。
 *
 * フィールドの宣言(MAX = 3)と、ただの代入とを区別するために使う。
 * メソッドの中まで含めてしまうと、その中の代入までフィールドと見なし、
 * const の書き忘れを見逃す。入れ子の波括弧は範囲から外す。
 */
function classBodyRanges(code) {
  const ranges = [];

  for (const m of code.matchAll(/\bclass\b[^{;]*\{/g)) {
    const start = m.index + m[0].length;
    let depth = 1;
    let from = start;
    let i = start;

    while (i < code.length && depth > 0) {
      if (code[i] === "{") {
        if (depth === 1) ranges.push([from, i]);   // 入れ子の手前まで
        depth += 1;
      } else if (code[i] === "}") {
        depth -= 1;
        if (depth === 1) from = i + 1;             // 入れ子の後ろから
      }
      i += 1;
    }

    if (from < i) ranges.push([from, i - 1]);      // 閉じ波括弧の手前まで
  }

  return ranges;
}

/**
 * const/let/var の宣言本体から、束縛される側だけを取り出す。
 *
 *   COMMIT_TIMEOUT_MS = 15000        → ["COMMIT_TIMEOUT_MS"]
 *   { refs, skipped } = await f()    → ["{ refs, skipped }"]
 *   A_MS = 1, B_MS = 2               → ["A_MS", "B_MS"]
 *   { limit = MAX_MS } = opts        → ["{ limit }"]
 *
 * 初期値・既定値まで束縛と見なすと、その中で参照した定数を
 * 「宣言済み」と誤って扱い、検査そのものが効かなくなる。
 * 既定値は入れ子の中にも書けるため、深さに関係なく読み飛ばす。
 *
 * stopAtNewline を指定すると、束縛を書き終えたところの改行で打ち切る。
 * セミコロンを省いた宣言(let x → 改行 → FOO = 2)で、次の文まで
 * 束縛として取り込まないために必要(仮引数では改行は文の区切りに
 * ならないので指定しない)。
 */
function bindingTargets(text, { stopAtNewline = false } = {}) {
  const targets = [];
  let depth = 0;
  let target = "";
  let valueDepth = null;      // 読み飛ばし中の初期値・既定値が始まった深さ

  for (const c of text) {
    const opening = "([{".includes(c);

    // 束縛を書き終えた位置での改行は、文の終わりとみなす
    if (stopAtNewline && c === "\n" && depth === 0 && valueDepth === null && target.trim() !== "") {
      break;
    }

    if (")]}".includes(c)) {
      depth -= 1;
      if (depth < 0) break;                       // for (const x of y) の閉じ括弧
      // 既定値を囲んでいた括弧が閉じたら、束縛の側へ戻る
      if (valueDepth !== null && depth < valueDepth) valueDepth = null;
    }

    if (valueDepth === null) {
      if (c === "=") valueDepth = depth;
      else if (c === "," && depth === 0) { targets.push(target); target = ""; }
      else target += c;
    } else if (c === "," && depth === valueDepth) {
      valueDepth = null;                          // 次の束縛へ
      if (depth === 0) { targets.push(target); target = ""; }
    }

    if (opening) depth += 1;
  }

  targets.push(target);
  return targets;
}

/**
 * 注釈・文字列・正規表現を取り除く。
 * 文字列の中の "ALREADY_RUNNING" を参照と取り違えないために必要。
 * テンプレート文字列は本文だけを捨て、${ } の中は式なので残す。
 */
function stripLiterals(source) {
  let out = "";
  let i = 0;
  const stack = [];   // "template" = 本文の中 / 数値 = ${ } の中の { の深さ

  while (i < source.length) {
    const c = source[i];

    if (stack[stack.length - 1] === "template") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { stack.pop(); out += '""'; i += 1; continue; }
      if (source.startsWith("${", i)) { stack.push(0); out += "("; i += 2; continue; }
      i += 1;
      continue;
    }

    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      out += " ";
      i = end === -1 ? source.length : end + 2;
      continue;
    }

    if (c === '"' || c === "'") { i = skipQuoted(source, i); out += '""'; continue; }
    if (c === "`") { stack.push("template"); i += 1; continue; }

    // ${ } の終わりを、通常の波括弧と取り違えないように数える
    if (c === "{" && typeof stack[stack.length - 1] === "number") stack[stack.length - 1] += 1;
    if (c === "}" && typeof stack[stack.length - 1] === "number") {
      if (stack[stack.length - 1] === 0) { stack.pop(); out += ")"; i += 1; continue; }
      stack[stack.length - 1] -= 1;
    }

    if (c === "/" && regexAllowed(out)) { i = skipRegex(source, i); out += " "; continue; }

    out += c;
    i += 1;
  }

  return out;
}

/**
 * その位置の / が正規表現の始まりか、割り算か。
 * } は直前が文の終わりであることが多いので正規表現側に数える
 * (オブジェクトを割ることは無い)。ただし ) は割り算が多いので数えない。
 */
function regexAllowed(out) {
  const tail = out.trimEnd();
  if (!tail) return true;
  if (/(?:\+\+|--)$/.test(tail)) return false;      // i++ / rate は割り算
  if ("([{},;:=!&|?+-*%~^<>".includes(tail[tail.length - 1])) return true;

  const word = tail.match(/[A-Za-z_$][\w$]*$/)?.[0];
  return word
    ? ["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "do", "else", "yield", "await"]
        .includes(word)
    : false;
}

function skipQuoted(source, i) {
  const quote = source[i];
  i += 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") { i += 2; continue; }
    if (c === quote) return i + 1;
    if (c === "\n") return i;        // 閉じ忘れは構文チェックの担当
    i += 1;
  }
  return i;
}

function skipRegex(source, i) {
  i += 1;
  let inClass = false;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "\n") break;      // 閉じ忘れは構文チェックの担当
    else if (c === "/" && !inClass) { i += 1; break; }
    i += 1;
  }
  while (i < source.length && /[dgimsuvy]/.test(source[i])) i += 1;
  return i;
}

// ── 結果 ─────────────────────────────────────────────────────

console.log("");
for (const { name, ok, detail } of results) {
  console.log(`${ok ? "  OK  " : "  NG  "} ${name}${detail ? " — " + detail : ""}`);
}
console.log("");

if (failed > 0) {
  console.error(`${failed} 件の検査に失敗しました。`);
  process.exit(1);
}
console.log(`${results.length} 件すべての検査に合格しました。`);
