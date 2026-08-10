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

const JS_FILES = ["js/app.js", "js/clock.js", "js/store.js", "js/firebase-config.js"];

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

  // code: "X" と code: cond ? "X" : "Y" の両方を拾う
  const codes = new Set(
    [...store.matchAll(/code: (?:\w+ \? )?"(\w+)"(?: : "(\w+)")?/g)]
      .flatMap((m) => [m[1], m[2]])
      .filter(Boolean)
  );
  must(codes.size > 0, "エラーコードを抽出できませんでした");

  const table = read("js/app.js").match(/function describeCode\(code\) \{([\s\S]*?)\n\}/);
  must(table, "describeCode の定義を抽出できませんでした");
  const defined = new Set([...table[1].matchAll(/^\s+(\w+):\s+/gm)].map((m) => m[1]));

  const missing = [...codes].filter((c) => !defined.has(c));
  must(missing.length === 0, `文言テーブルに無いコード: ${missing.join(", ")}`);

  void app;
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
