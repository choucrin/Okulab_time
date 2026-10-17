// v.04.1(F-14)の Test 工程での独立検証(単体)。
//
// js/store.js・js/app.js は CDN の Firebase を import するため Node から直接読み込めない。
// 既存テストと同じく、対象関数の実ソースを切り出して vm で実行する
// (test/support/extract-app-functions.mjs)。ブラウザでの動作は e2e/v041.spec.cjs で確認する。

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { readSource, extractFunction, extractConst } from "./support/extract-app-functions.mjs";
import { readingDataset, validShown, selectReading } from "../js/reading.js";
import { LONG_PASSAGES } from "../js/passages-long.js";
import { PASSAGES } from "../js/passages.js";

const plain = (value) => JSON.parse(JSON.stringify(value));
const storeSrc = readSource("js/store.js");
const appSrc = readSource("js/app.js");
const html = readSource("index.html");
const css = readSource("css/style.css").replace(/\/\*[\s\S]*?\*\//g, "");

const { parseRoomId, deriveRoomId } = vm.runInNewContext(`(() => {
  function userError(message) { return Object.assign(new Error(message), { userMessage: message }); }
  ${extractFunction(storeSrc, "deriveRoomId")}
  ${extractFunction(storeSrc, "parseRoomId")}
  return { parseRoomId, deriveRoomId };
})()`, { crypto: webcrypto, globalThis: { crypto: webcrypto }, TextEncoder });

// 変更前(ff166d4)の deriveRoomId で得られる値。合言葉から別のルームIDが生成されないことの基準。
const FIXED = {
  "okulab": "7875105fd038dfb7421913128cbd23ccb71600e8",
  "  ＯｋｕＬａｂ　": "7875105fd038dfb7421913128cbd23ccb71600e8",
  "e2e-records": "dd3045c258bf39e36dc7e163b5eb80c53bd27575",
  "0123456789abcdef0123456789abcdef01234567": "510c53bc14b9c5b7f475aa33aa32baae46796d55",
};

test("A-58: 合言葉方式の正規化と生成結果が従来の固定値と一致", async () => {
  for (const [passphrase, id] of Object.entries(FIXED)) assert.equal(await deriveRoomId(passphrase), id, passphrase);
});

test("A-59: 40桁の16進数に見える合言葉も合言葉方式では SHA-256 で変換する", async () => {
  const hex = "0123456789abcdef0123456789abcdef01234567";
  assert.notEqual(await deriveRoomId(hex), hex);
  assert.notEqual(await deriveRoomId(hex.toUpperCase()), hex);
  assert.equal(await deriveRoomId(hex.toUpperCase()), FIXED[hex]);
});

test("A-57/A-60: ルームID方式は再ハッシュせず、前後空白除去・小文字化した40桁を返す", async () => {
  const id = FIXED.okulab;
  assert.equal(parseRoomId(id), id);
  assert.equal(parseRoomId(id.toUpperCase()), id);
  assert.equal(parseRoomId(id.slice(0, 20).toUpperCase() + id.slice(20)), id);
  assert.equal(parseRoomId(`  ${id}\t`), id);
  assert.equal(parseRoomId(`　${id.toUpperCase()}　\n`), id);
  for (const p of Object.keys(FIXED)) {
    const derived = await deriveRoomId(p);
    assert.equal(parseRoomId(derived), derived, "合言葉の正式IDで同じルームになる");
  }
});

test("A-61: 空・省略ID・桁数違い・不正文字・パス区切りを拒否する", () => {
  const id = FIXED.okulab;
  const cases = [
    ["", /入力してください/], ["   ", /入力してください/], ["　", /入力してください/],
    [undefined, /入力してください/], [null, /入力してください/],
    [id.slice(0, 6), /40桁.*6 桁.*省略表示/], [id.slice(0, 39), /39 桁/], [id + "0", /41 桁/],
    [id.slice(0, 39) + "g", /0〜9 と a〜f/], ["０".repeat(40), /0〜9 と a〜f/],
    [id.slice(0, 20) + "/" + id.slice(21), /0〜9 と a〜f/], [id.slice(0, 20) + "\\" + id.slice(21), /0〜9 と a〜f/],
    [".." + id.slice(2), /0〜9 と a〜f/], [id.slice(0, 20) + " " + id.slice(21), /0〜9 と a〜f/],
    ["room " + id.slice(0, 6), /0〜9 と a〜f/], ["rooms/" + id, /0〜9 と a〜f/],
  ];
  for (const [input, message] of cases) assert.throws(() => parseRoomId(input), message, JSON.stringify(input));
});

test("A-61: 参加画面はルームIDを切り詰めず、入室方式は選択だけで決まる(初期は合言葉)", () => {
  const input = /<input[^>]*id="input-room"[^>]*>/s.exec(html)[0];
  assert.doesNotMatch(input, /maxlength/i);
  assert.match(html, /name="join-method" value="passphrase" checked/);
  assert.match(html, /name="join-method" value="roomId"(?! checked)/);
  const onJoin = extractFunction(appSrc, "onJoin");
  assert.match(onJoin, /join-method"\]:checked/);
  assert.match(onJoin, /byId \? parseRoomId\(passphrase\) : await deriveRoomId\(passphrase\)/);
  assert.doesNotMatch(onJoin, /\[0-9a-f\]|\.length\s*===\s*40|test\(/i, "入力の見た目で方式を判定しない");
});

test("A-47/A-48: 停止操作(onDetect)は文章選択・差し替え・スクロール変更を行わない", () => {
  const body = extractFunction(appSrc, "onDetect");
  assert.match(body, /await onEnd\(press\)/);
  assert.doesNotMatch(body, /nextPassage|selectReading|displayPassage|ensurePassage|scrollTop|passageText/);
  assert.doesNotMatch(appSrc, /必ず文章を切り替える/);
});

test("A-63: 文章変更・ルームIDの操作は被験者用画面の外にある", () => {
  const participant = /<section id="screen-participant"[\s\S]*?<\/section>/.exec(html)[0];
  assert.doesNotMatch(participant, /btn-change-passage|passage-change-hint|room-id|pill-room|文章を変更|ルームID/);
  const main = /<section id="screen-main"[\s\S]*?<\/section>\s*\n\s*<!--/.exec(html)?.[0] ?? html.slice(html.indexOf('id="screen-main"'), html.indexOf('id="screen-participant"'));
  for (const id of ["btn-change-passage", "passage-change-hint", "room-id-panel", "room-id-full", "btn-copy-room-id"]) {
    assert.ok(main.includes(`id="${id}"`), id);
  }
});

test("A-54/A-55: 字下げは本文段落だけに CSS の text-indent:1em で行い、原文に空白を足さない", () => {
  const indents = [...css.matchAll(/([^{}]+)\{[^}]*text-indent\s*:\s*([^;}]+)/g)].map((m) => [m[1].trim(), m[2].trim()]);
  assert.deepEqual(indents, [[".reading__text p", "1em"]]);
  const rule = /\.reading__text p\s*\{([^}]*)\}/.exec(css)[1];
  assert.doesNotMatch(rule, /padding-left|margin-left|hanging|each-line/);
  assert.match(rule, /margin:\s*0 0 1\.2em/);
  assert.match(extractFunction(appSrc, "displayPassage"), /p\.textContent = text;/);
  for (const p of [...LONG_PASSAGES.flatMap((x) => x.paragraphs), ...PASSAGES]) {
    assert.equal(p, p.trimStart(), "原文の段落先頭に空白が無い");
  }
});

// F-14-1-6: 表示中の文章の保存・復元。nextPassage/displayPassage/ensurePassage と既出管理の実コードを実行する。
function createReadingTab({ storage = new Map(), set = "long", roomId = "r1" } = {}) {
  const dataset = readingDataset(set);
  const children = [];
  const passageText = {
    get textContent() { return children.map((c) => c.textContent).join(""); },
    set textContent(v) { children.length = 0; },
    replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
    parentElement: { scrollTop: 0 },
  };
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
  };
  const ctx = {
    localStorage, JSON, Map, Array, Math,
    document: { createElement: () => ({ textContent: "" }) },
    el: { passageText }, state: { roomId },
    READ_KEY: dataset.key, READING_PASSAGES: dataset.passages, validShown, selectReading,
  };
  const api = vm.runInNewContext(`(() => {
    const CURRENT_READING_KEY = ${extractConst(appSrc, "CURRENT_READING_KEY")};
    const readingSet = ${extractConst(appSrc, "readingSet")};
    const currentPassages = new Map();
    const shownPassages = new Map();
    let passageScroll = 0, passageChanged = false;
    ${extractFunction(appSrc, "readShown")}
    ${extractFunction(appSrc, "writeShown")}
    ${extractFunction(appSrc, "nextPassage")}
    ${extractFunction(appSrc, "displayPassage")}
    ${extractFunction(appSrc, "ensurePassage")}
    return { nextPassage, ensurePassage, flags: () => ({ passageScroll, passageChanged }) };
  })()`, ctx);
  return { ...api, ctx, storage, dataset, text: () => passageText.textContent, clear: () => { children.length = 0; } };
}

test("F-14-1-6: 保存値があれば同じ文章を復元し、既出記録を変えない", () => {
  const first = createReadingTab();
  first.ensurePassage();
  const shownKey = first.dataset.key;
  const saved = JSON.parse(first.storage.get("okulab-time/reading-current"));
  const id = saved.long.r1;
  assert.ok(LONG_PASSAGES.some((p) => p.id === id));
  const shownBefore = first.storage.get(shownKey);
  // 再読み込み相当: 同じ localStorage で別のタブを作る
  const reload = createReadingTab({ storage: first.storage });
  reload.ensurePassage();
  assert.equal(reload.text(), first.text());
  assert.equal(reload.storage.get(shownKey), shownBefore, "復元では既出記録を追加しない");
});

test("F-14-1-6: 未知ID・型違い・範囲外・破損JSONは無視して初回選択し、例外で止めない", () => {
  for (const raw of [
    JSON.stringify({ long: { r1: "long-99" } }), JSON.stringify({ long: { r1: 3 } }),
    JSON.stringify({ long: "x" }), JSON.stringify([1, 2]), "{broken", JSON.stringify({ short: { r1: 999 } }),
  ]) {
    const tab = createReadingTab({ storage: new Map([["okulab-time/reading-current", raw]]) });
    assert.doesNotThrow(() => tab.ensurePassage(), raw);
    assert.ok(tab.text().length > 0, raw);
  }
  const short = createReadingTab({ set: "short", storage: new Map([["okulab-time/reading-current", JSON.stringify({ short: { r1: 999 } })]]) });
  short.ensurePassage();
  assert.ok(PASSAGES.includes(short.text()));
  // 破損した保存値は上書きしない(他ルーム分ごと消さない)
  const broken = createReadingTab({ storage: new Map([["okulab-time/reading-current", "{broken"]]) });
  broken.ensurePassage();
  assert.equal(broken.storage.get("okulab-time/reading-current"), "{broken");
});

test("F-14-1-6: 手動変更の保存は他データセット・他ルームの値を変更しない", () => {
  const storage = new Map([["okulab-time/reading-current", JSON.stringify({ short: { r1: 4 }, long: { other: "long-02" } })]]);
  const tab = createReadingTab({ storage });
  tab.ensurePassage();
  const before = tab.text();
  tab.nextPassage();
  assert.notEqual(tab.text(), before);
  const saved = plain(JSON.parse(storage.get("okulab-time/reading-current")));
  assert.equal(saved.short.r1, 4);
  assert.equal(saved.long.other, "long-02");
  assert.equal(LONG_PASSAGES.find((p) => p.id === saved.long.r1).paragraphs.join(""), tab.text());
  assert.equal(tab.flags().passageChanged, true, "被験者用画面で先頭へ戻す印");
  // 別ルームでは他ルームの文章を持ち込まない
  const other = createReadingTab({ storage, roomId: "other" });
  other.ensurePassage();
  assert.equal(other.text(), LONG_PASSAGES.find((p) => p.id === "long-02").paragraphs.join(""));
});
