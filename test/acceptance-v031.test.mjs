// v.04.0への対応: 旧F-10の画面・順序・保存・中断の検証はsequence-ui.test.mjsへ移行。
// 旧記録/CSV・共通スタイルの互換性検証はこのファイルで維持する。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readSource,extractFunction} from "./support/extract-app-functions.mjs";
import {createHarness} from "./support/sequence-app.mjs";
const source=readSource("js/app.js"),html=readSource("index.html"),css=readSource("css/style.css");
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
    vm.runInContext(`${["csv", "csvText", "randomOutcomeText", "modeText", "sequenceOutcomeText"].map((n) => extractFunction(source, n)).join("\n")}
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
    assert.match(html, /<label class="mode-switch">[\s\S]*順序反復で計測[\s\S]*<input id="measurement-mode" type="checkbox" role="switch">/);
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
