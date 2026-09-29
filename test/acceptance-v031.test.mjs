// v.03.1(F-9-12〜F-9-14・F-10)の Test 工程での独立した受け入れ検証(RSD 7-2)。
//
// js/app.js から実際の関数本体を切り出し、最小限の偽 DOM と共に vm で実行する
// (test/support 参照)。画面の操作はイベントリスナーを直接呼び出して模しており、
// 実ブラウザでの描画・支援技術・iPhone/iPad 実機での確認の代替ではない(Test.md 参照)。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readSource, extractFunction, extractConst } from "./support/extract-app-functions.mjs";
import { createSharedLockManager, createSharedStorageBackend, createLocalStorage } from "./support/sandbox.mjs";

const source = readSource("js/app.js");
const html = readSource("index.html");
const css = readSource("css/style.css");

class FakeElement {
  constructor(tagName = "div", id = "") {
    this.tagName = tagName;
    this.id = id;
    this.children = [];
    this.ownText = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.className = "";
    this.attrs = {};
    this.listeners = {};
    this.focusCount = 0;
  }
  get textContent() {
    return this.ownText + this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get options() { return this.children.filter((c) => c.tagName === "option"); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.ownText = ""; this.children = [...nodes]; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  focus() { this.focusCount += 1; }
  async fire(type) { for (const fn of this.listeners[type] ?? []) await fn({}); }
  find(className) {
    const found = [];
    for (const c of this.children) {
      if (typeof c === "string") continue;
      if (c.className.split(" ").includes(className)) found.push(c);
      found.push(...c.find(className));
    }
    return found;
  }
}

/** チップ要素から [ジャンル, 内容] の並びを取り出す。 */
const chipPairs = (node) => node.find("tag-chip").map((chip) => chip.children.map((c) => c.textContent));

const FUNCTIONS = [
  "catalogName", "catalogTag", "sortTags", "tagChips", "tagCell", "cell",
  "validateRandomItems", "chooseRandomItem", "randomMessage", "randomAction",
  "mutateRandom", "restoreRandom", "readRandomSets", "renderRandomSets",
  "importRandomItems", "interruptRandom", "settleRandom", "startRandom",
  "renderRandom", "initRandom", "randomOutcomeText", "randomRecordText",
];

function createHarness({ catalog = [{ name: "色", items: ["赤", "白"] }, { name: "音", items: ["低", "高"] }] } = {}) {
  const nodes = {};
  const $ = (id) => (nodes[id] ??= new FakeElement(id === "random-saved" ? "select" : "div", id));
  const backend = createSharedStorageBackend();
  const log = { confirms: [], aborts: [], started: [], answer: true };
  let uuid = 0;
  const context = vm.createContext({
    $, log, console,
    localStorage: createLocalStorage(backend),
    navigator: { locks: createSharedLockManager() },
    document: { createElement: (tag) => new FakeElement(tag), createTextNode: (text) => String(text) },
    el: { catalogOptions: new FakeElement(), inputLabel: { value: "" } },
    confirm: (message) => { log.confirms.push(message); return log.answer; },
    crypto: { randomUUID: () => `batch-${++uuid}` },
    window: { addEventListener() {} },
  });
  vm.runInContext(`
    const RANDOM_KEY = ${extractConst(source, "RANDOM_KEY")};
    let catalog = ${JSON.stringify(catalog)};
    let state = { roomId: "room", role: "start", busy: false, activeId: null, uid: "u1" };
    let roomEpoch = 1, randomMode = "free", randomBatch = null, randomSnapshot = null;
    let randomDraft = [], randomSelection = new Set(), randomRecord = undefined;
    let randomWorking = false, stopRandom = null, db = {}, sessionSeq = 0;
    function renderControls() {}
    function renderRandomSettings() {}
    function watchRandom() {}
    function onAbort(id) { log.aborts.push(id ?? null); }
    async function decideRandomSession() {}
    async function startMeasurement(press, reserved) { log.started.push(JSON.parse(JSON.stringify(reserved))); }
    function newSessionId() { return "s" + (++sessionSeq); }
    function confirmUnsynced() { return true; }
    function describeError(err) { return String(err); }
    ${FUNCTIONS.map((name) => extractFunction(source, name)).join("\n")}
    initRandom();
  `, context);
  const run = (code) => vm.runInContext(code, context);
  const stored = () => JSON.parse(backend[`${extractConst(source, "RANDOM_KEY").slice(1, -1)}room`] ?? "null");
  const saveSets = (sets) => { backend[`${extractConst(source, "RANDOM_KEY").slice(1, -1)}sets`] = JSON.stringify(sets); };
  return { $, run, log, stored, saveSets, backend };
}

describe("F-10-6 / A-18: タグの整列(クリック順に依存しない)", () => {
  test("設定ページでどの順にクリックしても、追加項目の tags はカタログのジャンル順になる", async () => {
    for (const order of [["色:赤", "音:低"], ["音:低", "色:赤"]]) {
      const { $, run } = createHarness();
      run(`randomSelection = new Set(${JSON.stringify(order)})`);
      $("random-count").value = "2";
      await $("random-add").fire("click");
      assert.equal(run("JSON.stringify(randomDraft)"), '[{"tags":["色:赤","音:低"],"count":2}]');
    }
  });

  test("項目一覧・次回試行内容・送信 tags の順序がカタログ順で一致する(旧順序のバッチも表示・送信時に整列)", async () => {
    const { $, run, log, stored } = createHarness();
    // 旧版で保存された、クリック順のままの実行中バッチ
    const legacy = { id: "old", items: [{ tags: ["外:X", "音:低", "色:赤"], count: 2, done: 0 }], previous: null, next: 0, pending: null, mode: "random" };
    run(`localStorage.setItem(RANDOM_KEY + "room", ${JSON.stringify(JSON.stringify(legacy))}); restoreRandom(); renderRandom();`);
    const next = $("random-progress").children[0];
    assert.deepEqual(chipPairs(next), [["色", "赤"], ["音", "低"], ["外", "X"]]);
    await run("startRandom({ synced: true })");
    assert.deepEqual([...log.started[0].payload.tags], ["色:赤", "音:低", "外:X"]);
    // 実行中バッチの保存内容自体は書き換えない
    assert.deepEqual(stored().items[0].tags, ["外:X", "音:低", "色:赤"]);
  });

  test("記録一覧の選択式ラベルは ';' 連結ではなくチップで、カタログ順(カタログ外は記録順)に並ぶ", () => {
    const { run } = createHarness({ catalog: [{ name: "色:分類", items: ["赤"] }, { name: "音", items: ["低"] }] });
    const cellNode = run(`tagCell(["外:B", "音:低", "別:A", "色%3A分類:赤"])`);
    assert.deepEqual(chipPairs(cellNode), [["色:分類", "赤"], ["音", "低"], ["外", "B"], ["別", "A"]]);
    assert.doesNotMatch(cellNode.textContent, /;/);
    assert.equal(run("tagCell([]).textContent"), "—");
  });

  test("任意方式の開始時も selectedTags を同じ規則で整列して送信する", () => {
    assert.match(extractFunction(source, "startMeasurement"), /tags:\s*sortTags\(selectedTags\)/);
  });
});

describe("F-10-3 / F-10-4 / F-10-7 / F-9-13: 計測者画面の表示状態(renderRandom)", () => {
  const activeBatch = { id: "b1", items: [{ tags: ["音:低", "色:赤"], count: 3, done: 1 }, { tags: [], count: 2, done: 0 }], previous: ["色:白"], next: 0, pending: null, mode: "random" };

  test("任意方式ではスイッチがオフで、ランダム用の表示・中断ボタンは出ない", () => {
    const { $, run } = createHarness();
    run("renderRandom()");
    assert.equal($("measurement-mode").checked, false);
    for (const id of ["random-open", "random-progress", "random-presets", "random-interrupt"]) assert.equal($(id).hidden, true, id);
  });

  test("ランダム実行中は次回・残りを強調区画で分けて表示し、中断ボタンを有効にする", () => {
    const { $, run } = createHarness();
    run(`randomBatch = ${JSON.stringify(activeBatch)}; randomMode = "random"; renderRandom();`);
    assert.equal($("measurement-mode").checked, true);
    const sections = $("random-progress").children;
    assert.deepEqual(sections.map((s) => s.children[0].textContent), ["次回試行内容", "残り試行回数", "前回試行内容", "累計試行回数"]);
    assert.deepEqual(sections.map((s) => s.className.includes("trial-section--next")), [true, true, false, false]);
    assert.equal(sections[1].children[1], "4 回");
    assert.equal(sections[3].children[1], "1 回");
    assert.deepEqual(chipPairs(sections[2]), [["色", "白"]]);
    assert.equal($("random-interrupt").hidden, false);
    assert.equal($("random-interrupt").disabled, false);
    assert.equal($("random-interrupt").textContent, "ランダム計測を中断");
    assert.equal($("random-interrupt-hint").textContent, "");
  });

  test("前回が無い場合は「なし」、バッチ未確定時は案内文を表示する", () => {
    const { $, run } = createHarness();
    run(`randomBatch = ${JSON.stringify({ ...activeBatch, previous: null })}; randomMode = "random"; renderRandom();`);
    assert.equal($("random-progress").children[2].children[1].textContent, "なし");
    run("randomBatch = null; renderRandom();");
    assert.match($("random-progress").textContent, /設定ページで項目を登録/);
  });

  test("自分の試行が計測中なら同じ位置のボタンが「この試行を中止」になり、既存の中止処理へ試行IDを渡す", async () => {
    const { $, run, log } = createHarness();
    run(`randomBatch = ${JSON.stringify({ ...activeBatch, pending: { id: "trial-A", index: 0, payload: { randomBatchId: "b1" } } })};
      randomMode = "random"; randomRecord = { status: "running" }; state.activeId = "trial-A"; renderRandom();`);
    assert.equal($("random-interrupt").textContent, "この試行を中止");
    assert.equal($("random-interrupt").disabled, false);
    assert.equal($("measurement-mode").disabled, true);
    await $("random-interrupt").fire("click");
    assert.deepEqual(log.aborts, ["trial-A"]);
    assert.equal(log.confirms.length, 0, "中断の確認ではなく既存の中止処理に委ねる");
  });

  test("計測後の確認待ち・開始確認中は中断ボタンを無効化し、理由を示す", () => {
    const { $, run } = createHarness();
    const pending = { id: "trial-A", index: 0, payload: { randomBatchId: "b1" } };
    run(`randomBatch = ${JSON.stringify({ ...activeBatch, pending })}; randomMode = "random"; randomRecord = { status: "done" }; renderRandom();`);
    assert.equal($("random-interrupt").disabled, true);
    assert.equal($("random-interrupt-hint").textContent, "先に今回の記録の保存可否を選んでください。");
    assert.equal($("random-confirm").hidden, false);
    run("randomRecord = undefined; renderRandom();");
    assert.equal($("random-interrupt").disabled, true);
    assert.notEqual($("random-interrupt-hint").textContent, "");
  });

  test("設定ページの開閉ボタンは1つで、文言と aria-expanded が状態に一致する", async () => {
    const { $, run } = createHarness();
    run(`randomMode = "random"; $("random-settings").hidden = true; renderRandom();`);
    assert.equal($("random-open").getAttribute("aria-expanded"), "false");
    assert.match($("random-open").textContent, /開く/);
    await $("random-open").fire("click");
    run("renderRandom()");
    assert.equal($("random-settings").hidden, false);
    assert.equal($("random-open").getAttribute("aria-expanded"), "true");
    assert.match($("random-open").textContent, /閉じる/);
    await $("random-open").fire("click");
    run("renderRandom()");
    assert.equal($("random-settings").hidden, true);
    assert.equal($("random-open").getAttribute("aria-expanded"), "false");
  });
});

describe("F-10-3 / F-9-11 / F-9-13 / A-16 / A-20: 方式の切替と中断", () => {
  test("スイッチのオン/オフで方式とバッチの mode が切り替わり、設定ページは閉じる", async () => {
    const { $, run, stored } = createHarness();
    await run(`importRandomItems([{ tags: [], count: 2 }])`);
    $("measurement-mode").checked = false;
    run(`$("random-settings").hidden = false`);
    await $("measurement-mode").fire("change");
    assert.equal(run("randomMode"), "free");
    assert.equal(stored().mode, "free");
    assert.equal($("random-settings").hidden, true);
    $("measurement-mode").checked = true;
    await $("measurement-mode").fire("change");
    assert.equal(run("randomMode"), "random");
    assert.equal(stored().next, 0, "一時的にオフにしてもバッチは保持され、オンで再開できる");
  });

  test("中断は残り回数を示して確認し、確定後は任意に戻りスイッチもオフになる。再読込後も任意のまま", async () => {
    const { $, run, log, stored } = createHarness();
    await run(`importRandomItems([{ tags: ["色:赤"], count: 3 }, { tags: [], count: 2 }])`);
    await $("random-interrupt").fire("click");
    assert.match(log.confirms.at(-1), /残り 5 回を破棄/);
    assert.match(log.confirms.at(-1), /これまでの記録は残ります/);
    assert.equal(stored().next, null);
    assert.equal(stored().mode, "free");
    run("renderRandom()");
    assert.equal($("measurement-mode").checked, false);
    assert.equal($("random-interrupt").hidden, true);
    run("restoreRandom(); renderRandom();");
    assert.equal(run("randomMode"), "free");
    assert.equal(run("typeof randomSnapshot"), "string", "中断済みの状態を不正と誤判定しない");
    assert.equal($("random-message").textContent, "");
  });

  test("中断済みバッチは新しいインポート時の破棄確認の対象にならない", async () => {
    const { run, log, stored } = createHarness();
    await run(`importRandomItems([{ tags: [], count: 3 }])`);
    await run("interruptRandom()");
    const before = log.confirms.length;
    await run(`importRandomItems([{ tags: [], count: 1 }])`);
    assert.equal(log.confirms.length, before);
    assert.equal(stored().items[0].count, 1);
    assert.equal(run("randomMode"), "random");
  });

  test("全項目の試行を満たすと自動で任意に戻り、スイッチ表示もオフになる", async () => {
    const { $, run } = createHarness();
    await run(`importRandomItems([{ tags: [], count: 1 }])`);
    run(`randomBatch.pending = { id: "t1", index: 0, payload: { randomBatchId: randomBatch.id } };
      localStorage.setItem(RANDOM_KEY + "room", JSON.stringify(randomBatch)); randomSnapshot = JSON.stringify(randomBatch);`);
    await run(`settleRandom({ id: "t1", randomBatchId: randomBatch.id, randomOutcome: "confirmed" })`);
    run("renderRandom()");
    assert.equal(run("randomMode"), "free");
    assert.equal($("measurement-mode").checked, false);
  });
});

describe("F-9-14 / A-21: 保存済みセットのページ外呼び出し", () => {
  test("保存済みセットが無い場合は案内を表示し、呼び出しボタンを無効化する", () => {
    const { $, run } = createHarness();
    run(`randomMode = "random"; renderRandomSets(); renderRandom();`);
    assert.equal($("random-saved-empty").hidden, false);
    assert.equal($("random-saved-label").hidden, true);
    assert.equal($("random-load").disabled, true);
  });

  test("保存すると設定ページ外の選択欄が即時に更新される", async () => {
    const { $, run } = createHarness();
    run(`randomDraft = [{ tags: ["色:赤"], count: 2 }]; randomMode = "random";`);
    $("random-name").value = "セットA";
    await $("random-save").fire("click");
    run("renderRandom()");
    assert.deepEqual($("random-saved").options.map((o) => o.value), ["セットA"]);
    assert.equal($("random-saved-empty").hidden, true);
    assert.equal($("random-load").disabled, false);
  });

  test("設定ページを開かずに呼び出してバッチを確定でき、保存済みセットは書き換えない", async () => {
    const { $, run, stored, saveSets, backend, log } = createHarness();
    const sets = [{ name: "セットA", items: [{ tags: ["音:低", "色:赤"], count: 2 }] }];
    saveSets(sets);
    $("random-saved").value = "セットA";
    await $("random-load").fire("click");
    assert.equal($("random-settings").hidden, true);
    assert.equal(run("randomMode"), "random");
    assert.deepEqual(stored().items, [{ tags: ["色:赤", "音:低"], count: 2, done: 0 }]);
    assert.equal(log.confirms.length, 0);
    assert.deepEqual(JSON.parse(backend[Object.keys(backend).find((k) => k.endsWith("sets"))]), sets);
  });

  test("実行中バッチがあれば F-9-6 と同じ破棄確認を経て、取り消すと既存バッチを保持する", async () => {
    const { $, run, stored, saveSets, log } = createHarness();
    await run(`importRandomItems([{ tags: [], count: 5 }])`);
    saveSets([{ name: "セットB", items: [{ tags: [], count: 1 }] }]);
    $("random-saved").value = "セットB";
    log.answer = false;
    await $("random-load").fire("click");
    assert.match(log.confirms.at(-1), /既存バッチの残り試行分を破棄/);
    assert.equal(stored().items[0].count, 5);
    log.answer = true;
    await $("random-load").fire("click");
    assert.equal(stored().items[0].count, 1);
  });

  test("計測中・確認待ちや不正なセットは読み込まずに理由を表示する", async () => {
    const { $, run, stored, saveSets } = createHarness();
    saveSets([{ name: "セットC", items: [{ tags: [], count: 1 }] }]);
    $("random-saved").value = "セットC";
    run(`state.activeId = "running"`);
    await $("random-load").fire("click");
    assert.equal(stored(), null);
    assert.match($("random-message").textContent, /計測と確認を完了/);
    run(`state.activeId = null`);
    saveSets([{ name: "セットC", items: [{ tags: [], count: 0 }] }]);
    await $("random-load").fire("click");
    assert.equal(stored(), null);
    assert.match($("random-message").textContent, /試行回数/);
  });
});

describe("F-9-12 / F-10-9: 記録一覧と CSV のバッチ識別子", () => {
  test("記録一覧の方式表示はバッチ識別子を含まず、CSV の random_batch_id 列には出力する", () => {
    const { run } = createHarness();
    const record = { id: "s1", status: "done", mode: "random", randomBatchId: "batch-xyz", randomOutcome: "discarded", tags: ["色:赤", "音:低"] };
    assert.equal(run(`randomRecordText(${JSON.stringify(record)})`), "ランダム / ランダム試行内のエラーデータ");
    assert.equal(run(`randomRecordText({ mode: "random", randomBatchId: "b", randomOutcome: "confirmed" })`), "ランダム / 有効");
    assert.equal(run(`randomRecordText({})`), "任意");

    const exportBody = extractFunction(source, "exportCsv");
    const rowExpr = exportBody.slice(exportBody.indexOf("lines.push([") + "lines.push(".length, exportBody.indexOf('].join(",")') + 1);
    const headerStart = source.indexOf("const CSV_HEADER = [") + "const CSV_HEADER = ".length;
    const header = vm.runInNewContext(source.slice(headerStart, source.indexOf("];", headerStart) + 1));
    const csvContext = vm.createContext({});
    vm.runInContext(`${["csv", "csvText", "randomOutcomeText"].map((n) => extractFunction(source, n)).join("\n")}
      const formatFull = (v) => v ?? ""; const toIso = formatFull; const round1 = formatFull; const fromTimestamp = formatFull;
      var row = (s) => ${rowExpr};`, csvContext);
    const row = vm.runInContext(`row(${JSON.stringify(record)})`, csvContext);
    assert.equal(row.length, header.length);
    assert.equal(row[header.indexOf("random_batch_id")], "batch-xyz");
    assert.equal(row[header.indexOf("mode")], "ランダム");
    assert.equal(row[header.indexOf("random_outcome")], "ランダム試行内のエラーデータ");
    assert.equal(row[header.indexOf("tags")], "色:赤; 音:低", "CSV の tags 列は従来の ';' 連結のまま");
  });

  test("記録一覧の見出しは「方式 / 判定」で、バッチ列の文言が残っていない", () => {
    assert.match(html, /<th scope="col">方式 \/ 判定<\/th>/);
    assert.doesNotMatch(html, /方式 \/ バッチ/);
    const renderRecords = extractFunction(source, "renderRecords");
    assert.match(renderRecords, /tagCell\(s\.tags \?\? \[\]\)/);
    assert.match(renderRecords, /cell\(randomRecordText\(s\)\)/);
  });
});

describe("F-10 / A-16〜A-19: 画面構成の静的検査(index.html)", () => {
  const settingsStart = html.indexOf('<section id="random-settings"');
  const settings = html.slice(settingsStart, html.indexOf("</section>", settingsStart));

  test("計測条件はドロップダウンではなくスイッチで、ラベル付き", () => {
    assert.doesNotMatch(html, /<select id="measurement-mode"/);
    assert.match(html, /<label class="mode-switch">[\s\S]*ランダム条件で計測[\s\S]*<input id="measurement-mode" type="checkbox" role="switch">/);
  });

  test("設定ページ内に閉じるボタン・呼び出しUIが無く、開閉ボタンが aria-controls で結ばれている", () => {
    assert.doesNotMatch(html + source, /random-close/);
    assert.doesNotMatch(settings, /random-saved|random-load/);
    assert.match(settings, /id="random-save"/, "名前を付けて保存はページ内に残す");
    assert.match(html, /id="random-open"[^>]*aria-controls="random-settings"/);
    const presets = html.slice(html.indexOf('id="random-presets"'), settingsStart);
    assert.match(presets, /id="random-saved"/);
    assert.match(presets, /id="random-load"/);
  });

  test("カタログ説明文を削除し、保存確認は開始ボタンより下に alertdialog として置く", () => {
    assert.doesNotMatch(html, /カタログはこの端末に保存され/);
    assert.ok(html.indexOf('id="random-confirm"') > html.indexOf('id="btn-start"'));
    assert.ok(html.indexOf('id="random-interrupt"') > html.indexOf('id="random-progress"'));
    assert.ok(html.indexOf('id="random-interrupt"') < html.indexOf('id="btn-start"'));
    assert.match(html, /id="random-confirm" role="alertdialog"/);
  });
});

describe("F-10-1 / F-10-5 / A-23: スタイルの静的検査(css/style.css)", () => {
  const block = (selector) => {
    const m = new RegExp(`(?:^|\\n)${selector.replace(/[#.()-]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(m, `${selector} の宣言が見つかりません`);
    return m[1];
  };
  const px = (decl, prop) => Number(new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px`).exec(decl)?.[1]);

  test("システムフォントに Windows 用のフォールバックがあり、外部フォントを読み込まない", () => {
    assert.match(css, /font-family:\s*-apple-system,\s*BlinkMacSystemFont,[^;]*"Segoe UI"[^;]*"Yu Gothic UI"[^;]*Meiryo/);
    assert.doesNotMatch(css + html, /@import|fonts\.googleapis|@font-face/);
  });

  test("スイッチと主要ボタンのタップ領域が 44px 以上", () => {
    const sw = block("#measurement-mode");
    assert.ok(px(sw, "width") >= 44 && px(sw, "height") >= 44);
    assert.ok(px(block("#random-confirm .btn"), "min-height") >= 44);
    assert.ok(px(block("#screen-main .btn--sm, #screen-main .del"), "min-height") >= 44);
    assert.ok(px(block(".btn"), "min-height") >= 44);
  });

  test("設定ページの上端・下端に区切り線がある", () => {
    assert.match(block("#random-settings"), /border-block:\s*\d+px solid/);
    assert.match(block("#random-total"), /border-top:\s*1px solid/);
  });

  test("計測者画面の主要な文字色がライト/ダークとも WCAG AA(4.5:1)以上", () => {
    const vars = (text) => Object.fromEntries([...text.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
    const light = vars(/:root\s*\{([^}]*)\}/.exec(css)[1]);
    const dark = vars(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)[1]);
    const panels = [...css.matchAll(/#panel-start\s*\{([^}]*--accent[^}]*)\}/g)].map((m) => vars(m[1]));
    assert.equal(panels.length, 2, "#panel-start のライト/ダーク配色が見つかりません");
    const lum = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const yesInk = { light: "#ffffff", dark: /#random-confirm #random-yes\s*\{\s*color:\s*(#[0-9a-fA-F]{6})/.exec(css.slice(css.lastIndexOf("prefers-color-scheme: dark")))[1] };
    for (const [mode, base, panel] of [["light", light, panels[0]], ["dark", { ...light, ...dark }, panels[1]]]) {
      const v = { ...base, ...panel };
      const pairs = [
        ["ボタン文字(accent/surface-2)", v.accent, v["surface-2"]],
        ["次回試行見出し(accent/surface)", v.accent, v.surface],
        ["中断ボタン(end/surface-2)", v.end, v["surface-2"]],
        ["補助文字(text-dim/surface)", v["text-dim"], v.surface],
        ["チップのジャンル(text-dim/surface-2)", v["text-dim"], v["surface-2"]],
        ["Yes ボタン", yesInk[mode], v.accent],
        ["計測開始ボタン(start-ink/start)", v["start-ink"], v.start],
      ];
      for (const [name, fg, bg] of pairs) assert.ok(ratio(fg, bg) >= 4.5, `${mode} ${name}: ${ratio(fg, bg).toFixed(2)}`);
    }
  });
});
