// v.03.2(F-11)の Test 工程での独立した受け入れ検証(RSD 7-3 の必須単体テスト)。
//
// js/app.js から実際の関数本体を切り出し、最小限の偽 DOM と共に vm で実行する
// (test/support 参照)。描画・横幅・実ブラウザでの順序は e2e/ のブラウザ E2E で確認する。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readSource, extractFunction } from "./support/extract-app-functions.mjs";

const source = readSource("js/app.js");
const html = readSource("index.html");

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.ownText = "";
    this.className = "";
    this.title = "";
    this.type = "";
    this.disabled = false;
    this.dataset = {};
    this.attrs = {};
    const owner = this;
    this.classList = {
      add(name) { owner.className = [...new Set([...owner.className.split(" ").filter(Boolean), name])].join(" "); },
      contains(name) { return owner.className.split(" ").includes(name); },
    };
  }
  get textContent() {
    return this.ownText + this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.ownText = ""; this.children = [...nodes]; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
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

const FUNCTIONS = [
  "catalogTag", "sortTags", "sortRecordTags", "tagChips", "tagCell", "cell", "durationCell",
  "worstAccuracy", "randomOutcomeText", "randomRecordText", "formatSeconds", "formatClock",
  "formatFull", "renderRecords",
];

function createHarness(catalog = []) {
  const context = vm.createContext({
    document: { createElement: (tag) => new FakeElement(tag), createTextNode: (text) => String(text) },
  });
  vm.runInContext(`
    const SESSION_LIMIT = 300, GOOD_ACCURACY_MS = 250;
    const pad = (n, width = 2) => String(Math.trunc(Math.abs(n))).padStart(width, "0");
    let catalog = ${JSON.stringify(catalog)};
    let state = { sessions: [], sessionsLoaded: true, role: "start" };
    let recordsInFlight = 0;
    const el = {
      recordCount: document.createElement("span"), recordEmpty: document.createElement("p"),
      recordNote: document.createElement("p"), recordBody: document.createElement("tbody"),
    };
    ${FUNCTIONS.map((name) => extractFunction(source, name)).join("\n")}
  `, context);
  const run = (code) => vm.runInContext(code, context);
  const sort = (tags) => {
    context.input = tags;
    return JSON.parse(run("JSON.stringify(sortRecordTags(input))"));
  };
  return { run, sort, context };
}

const chipPairs = (node) => node.find("tag-chip").map((chip) => chip.children.map((c) => c.textContent));
const multiset = (list) => [...list].sort();

describe("F-11-3 / A-26: 記録一覧の選択式ラベルの固定順(sortRecordTags)", () => {
  const catalogs = {
    "カタログ無し(iPhone 相当)": [],
    "パターン→色の順のカタログ": [{ name: "パターン", items: ["縞"] }, { name: "色", items: ["白"] }],
    "色→パターンの順のカタログ": [{ name: "色", items: ["白"] }, { name: "パターン", items: ["縞"] }],
  };

  for (const [label, catalog] of Object.entries(catalogs)) {
    test(`${label}でも結果が同じ: 逆順保存・片方のみ・空・その他ジャンル`, () => {
      const { sort } = createHarness(catalog);
      assert.deepEqual(sort(["パターン:縞", "色:白"]), ["色:白", "パターン:縞"]);
      assert.deepEqual(sort(["色:白", "パターン:縞"]), ["色:白", "パターン:縞"]);
      assert.deepEqual(sort(["パターン:縞"]), ["パターン:縞"]);
      assert.deepEqual(sort(["色:赤"]), ["色:赤"]);
      assert.deepEqual(sort([]), []);
      // その他のジャンルは「色」「パターン」の後ろに UTF-16 コード単位順(S U+0053 < 形 U+5F62 < 音 U+97F3)
      assert.deepEqual(
        sort(["音:低", "パターン:縞", "形:丸", "Size:L", "色:白"]),
        ["色:白", "パターン:縞", "Size:L", "形:丸", "音:低"],
      );
    });
  }

  test("その他ジャンルの比較は localeCompare ではなくコード単位順(大文字が小文字より前)", () => {
    const { sort } = createHarness();
    assert.deepEqual(sort(["b:1", "B:1", "a:1", "パターン:x"]), ["パターン:x", "B:1", "a:1", "b:1"]);
  });

  test("旧形式タグ(':' 無し)はタグ全体をジャンルキーとして扱い、欠落させない", () => {
    const { sort } = createHarness();
    assert.deepEqual(sort(["メモ", "パターン:縞", "色"]), ["色", "パターン:縞", "メモ"]);
  });

  test("符号化されたジャンル名(%3A 等)は復号後の名前で比較する", () => {
    const { sort, run } = createHarness();
    const encoded = run(`catalogTag("色:分類", "赤")`);
    assert.equal(encoded, "色%3A分類:赤");
    // 復号後のジャンル名「色:分類」は「色」ではないので、その他として後ろに並ぶ
    assert.deepEqual(sort([encoded, "パターン:縞", "色:白"]), ["色:白", "パターン:縞", encoded]);
    // 復号前("X%3AY", '%' < '0')と復号後("X:Y", '0' < ':')で順序が変わる組。小文字の符号も同じ扱い
    assert.deepEqual(sort(["X%3AY:1", "X0:1"]), ["X0:1", "X%3AY:1"]);
    assert.deepEqual(sort(["X%3aY:1", "X0:1"]), ["X0:1", "X%3aY:1"]);
  });

  test("NFD で保存された「パターン」も NFC 正規化して 2 番目に並ぶ", () => {
    const { sort } = createHarness();
    const nfd = "パターン".normalize("NFD");
    assert.notEqual(nfd, "パターン");
    const tag = `${nfd}:縞`;
    assert.deepEqual(sort(["音:低", tag, "色:白"]), ["色:白", tag, "音:低"]);
  });

  test("同一ジャンルの重複(過去データ)は保存文字列全体の順で並べ、欠落も追加もしない", () => {
    const { sort } = createHarness();
    const input = ["色:白", "パターン:縞", "色:赤", "色:白", "パターン:A"];
    const output = sort(input);
    assert.deepEqual(output, ["色:白", "色:白", "色:赤", "パターン:A", "パターン:縞"]);
    assert.deepEqual(multiset(output), multiset(input));
  });

  test("入力配列を書き換えない(保存データの tags を変えない)", () => {
    const { run } = createHarness();
    const result = JSON.parse(run(`
      const original = ["パターン:縞", "音:低", "色:白"];
      const frozen = Object.freeze([...original]);
      const sorted = sortRecordTags(frozen);
      JSON.stringify({ same: sorted === frozen, input: frozen, original, sorted });
    `));
    assert.equal(result.same, false);
    assert.deepEqual(result.input, ["パターン:縞", "音:低", "色:白"]);
    assert.deepEqual(result.sorted, ["色:白", "パターン:縞", "音:低"]);
  });

  test("入力順に依存しない(全順列で同じ結果・決定的)", () => {
    const { sort } = createHarness();
    const tags = ["音:低", "パターン:縞", "色:白", "形:丸"];
    const permutations = (list) => list.length <= 1 ? [list]
      : list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((p) => [x, ...p]));
    const expected = ["色:白", "パターン:縞", "形:丸", "音:低"];
    for (const order of permutations(tags)) assert.deepEqual(sort(order), expected);
  });

  test("記録一覧のセル(tagCell)は端末カタログに依存せず色→パターン→その他のチップになる", () => {
    for (const catalog of Object.values(catalogs)) {
      const { run } = createHarness(catalog);
      const node = run(`tagCell(["音:低", "パターン:縞", "色:白"])`);
      assert.deepEqual(chipPairs(node), [["色", "白"], ["パターン", "縞"], ["音", "低"]]);
      assert.equal(run(`tagCell([]).textContent`), "—");
    }
  });

  test("ランダム設定・送信用の sortTags は従来どおり端末カタログ順のまま(記録一覧のみ切替)", () => {
    const { run } = createHarness([{ name: "パターン", items: ["縞"] }, { name: "色", items: ["白"] }]);
    assert.equal(run(`JSON.stringify(sortTags(["色:白", "パターン:縞"]))`), '["パターン:縞","色:白"]');
    assert.deepEqual(chipPairs(run(`tagChips(["色:白", "パターン:縞"])`)), [["パターン", "縞"], ["色", "白"]]);
  });
});

describe("F-11-2 / A-25: 記録一覧の列順", () => {
  const EXPECTED = ["ラベル", "経過(秒)", "選択式ラベル", "方式 / 判定", "開始", "終了", "操作"];

  const headings = () => {
    const thead = /<thead>([\s\S]*?)<\/thead>/.exec(html)?.[1];
    assert.ok(thead, "index.html に <thead> がありません");
    return [...thead.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)]
      .map((m) => m[1].replace(/<[^>]+>/g, "").trim());
  };

  test("index.html の <thead> 見出し順が仕様どおり", () => {
    assert.deepEqual(headings(), EXPECTED);
  });

  test("renderRecords のセル生成順が見出しと一致する(完了・計測中・中止・ランダム)", () => {
    const { run } = createHarness();
    const rows = JSON.parse(run(`
      state.sessions = [
        { id: "a", status: "done", label: "被験者A", tags: ["パターン:縞", "色:白"], mode: "free",
          startMs: 1000, endMs: 3500, durationMs: 2500, startSynced: true, endSynced: true },
        { id: "b", status: "running", label: "", tags: [], mode: "free", startMs: 5000, endMs: null },
        { id: "c", status: "aborted", label: "L", tags: ["色:赤"], mode: "random", randomOutcome: null,
          startMs: 6000, endMs: null },
        { id: "d", status: "done", label: "R", tags: ["色:白"], mode: "random", randomOutcome: "confirmed",
          startMs: 7000, endMs: 8250, durationMs: 1250 },
      ];
      renderRecords();
      JSON.stringify(el.recordBody.children.map((tr) => tr.children.map((td) => ({
        text: td.textContent, className: td.className,
      }))));
    `));
    assert.equal(rows.length, 4);
    for (const row of rows) assert.equal(row.length, EXPECTED.length, "見出しとセル数が一致しない");

    const [done, running, aborted, random] = rows;
    assert.equal(done[0].text, "被験者A");
    assert.equal(done[1].text, "2.500");
    assert.match(done[1].className, /\bnum\b/);
    assert.equal(done[2].className, "tags-cell");
    assert.equal(done[2].text, "色白パターン縞");
    assert.equal(done[3].text, "任意");
    assert.equal(done[4].className, "mono");
    assert.equal(done[5].className, "mono");
    assert.equal(done[6].text, "×");

    assert.equal(running[0].text, "—");
    assert.equal(running[1].text, "計測中");
    assert.equal(running[2].text, "—");
    assert.equal(running[5].text, "—");
    assert.equal(running[6].text, "", "計測中の行に削除ボタンを出さない");

    assert.equal(aborted[1].text, "中止");
    assert.equal(aborted[3].text, "ランダム / 未確定");

    assert.equal(random[1].text, "1.250");
    assert.equal(random[3].text, "ランダム / 有効");
  });

  test("経過(秒)セルの警告表示(warn/bad と title)は維持される", () => {
    const { run } = createHarness();
    const result = JSON.parse(run(`
      const unsynced = durationCell({ status: "done", durationMs: 1000, startSynced: false, endSynced: true });
      const rough = durationCell({ status: "done", durationMs: 1000, startAccuracyMs: 400, endAccuracyMs: 10 });
      const negative = durationCell({ status: "done", durationMs: -5 });
      JSON.stringify([unsynced, rough, negative].map((td) => ({ className: td.className, title: td.title })));
    `));
    assert.match(result[0].className, /\bwarn\b/);
    assert.match(result[0].title, /時刻同期が完了していない/);
    assert.match(result[1].className, /\bwarn\b/);
    assert.match(result[1].title, /±400ms/);
    assert.match(result[2].className, /\bbad\b/);
  });

  test("CSV の列順は変更されていない(tags は保存順の '; ' 連結)", () => {
    const body = extractFunction(source, "exportCsv");
    assert.match(body, /csv\(s\.id\), csvText\(s\.label\), csvText\(\(s\.tags \?\? \[\]\)\.join\("; "\)\), csv\(s\.status\)/);
    assert.doesNotMatch(body, /sortRecordTags|sortTags/);
  });
});

describe("F-11-1 / F-11-4: 回避策で症状を隠していない", () => {
  const css = readSource("css/style.css");

  test("viewport のズーム禁止をしていない", () => {
    const meta = /<meta name="viewport" content="([^"]+)">/.exec(html)?.[1];
    assert.ok(meta);
    assert.match(meta, /width=device-width/);
    assert.match(meta, /initial-scale=1/);
    assert.doesNotMatch(meta, /user-scalable\s*=\s*no|maximum-scale/);
  });

  test("html / body に overflow-x: hidden を付けていない", () => {
    for (const block of css.matchAll(/(^|[},])\s*([^{}]*)\{([^{}]*)\}/g)) {
      const selectors = block[2].split(",").map((s) => s.trim());
      if (selectors.some((s) => s === "html" || s === "body") && /overflow(-x)?\s*:\s*(hidden|clip)/.test(block[3])) {
        assert.fail(`html/body に overflow の隠蔽があります: ${block[2]}`);
      }
    }
  });
});
