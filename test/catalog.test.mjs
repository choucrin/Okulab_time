// F-8(ラベルカタログ)の Test 工程での独立検証。
//
// js/app.js から実際の関数本体を切り出して実行するため(test/support 参照)、
// テスト用に書き直した別実装ではなく出荷対象のコードを検証している。
// ただし実ブラウザ・実 Firebase・実機での検証の代替ではない(Test.md 参照)。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createPureFunctions, createCatalogTab,
  createSharedLockManager, createSharedStorageBackend, createLocalStorage,
} from "./support/sandbox.mjs";

// vm サンドボックス(別レルム)から返る配列・オブジェクトは、構造が同じでも
// Node の Array/Object コンストラクタと異なるため、assert.deepEqual が
// 「構造は同じだが reference-equal でない」として失敗する。JSON を介して
// 現在のレルムの素の値に変換してから比較する。
const plain = (value) => JSON.parse(JSON.stringify(value));

describe("F-8-3: カタログの名前検証(catalogName)", () => {
  const { catalogName } = createPureFunctions();

  test("前後の空白を除去する", () => {
    assert.equal(catalogName("  赤  "), "赤");
  });
  test("空文字(空白のみ含む)を拒否する", () => {
    assert.throws(() => catalogName("   "));
  });
  test("40文字ちょうどは許可する", () => {
    const name = "あ".repeat(40);
    assert.equal(catalogName(name), name);
  });
  test("41文字は拒否する", () => {
    assert.throws(() => catalogName("あ".repeat(41)));
  });
});

describe("F-8-6/R1-001: 選択識別子の生成(catalogTag)と衝突回避", () => {
  const { catalogTag } = createPureFunctions();

  test("通常の名前は『ジャンル:内容』の形式になる", () => {
    assert.equal(catalogTag("色", "赤"), "色:赤");
  });

  test("ジャンル名・内容にコロンを含んでいても、識別子が衝突しない(R1-001)", () => {
    const a = catalogTag("A:B", "C");
    const b = catalogTag("A", "B:C");
    assert.notEqual(a, b, "『A:B』『C』と『A』『B:C』が同じ識別子になってはいけない");
  });

  test("符号化後も区切りのコロンは1個だけ残り、decodeURIComponent で元の名前に復元できる", () => {
    // %XX で符号化するのは ASCII の制御文字(%:;\r\n)のみで、多バイト文字はそのまま
    // 残すため、decodeURIComponent で安全に復元できる(実装メモに記載の復元手段)。
    const decode = (s) => decodeURIComponent(s);
    const genre = "A:B;C\r\nD色";
    const item = "E%F青";
    const tag = catalogTag(genre, item);
    const boundary = tag.indexOf(":"); // エスケープされていない最初のコロンが境界
    assert.equal(decode(tag.slice(0, boundary)), genre);
    assert.equal(decode(tag.slice(boundary + 1)), item);
  });

  test("最小長(1文字+1文字)は firestore.rules の下限3文字と一致する", () => {
    const tag = catalogTag("A", "B");
    assert.equal(tag, "A:B");
    assert.equal(tag.length, 3);
  });

  test("上限40文字の名前が全てエスケープ対象文字のときの最大長は241文字(firestore.rules と一致)", () => {
    const worst = ":".repeat(40);
    const tag = catalogTag(worst, worst);
    assert.equal(tag.length, 241);
  });
});

describe("F-8-1/F-8-3: カタログの読込検証(readCatalog)", () => {
  const { readCatalog } = createPureFunctions();

  test("空カタログ(null/未保存)を読み込める", () => {
    assert.deepEqual(plain(readCatalog(null)), []);
  });

  test("正常なカタログを読み込める", () => {
    const raw = JSON.stringify([{ name: "色", items: ["赤", "青"] }]);
    assert.deepEqual(plain(readCatalog(raw)), [{ name: "色", items: ["赤", "青"] }]);
  });

  test("同一ジャンル名の重複を拒否する", () => {
    const raw = JSON.stringify([{ name: "色", items: [] }, { name: "色", items: [] }]);
    assert.throws(() => readCatalog(raw));
  });

  test("同一ジャンル内での内容の重複を拒否する", () => {
    const raw = JSON.stringify([{ name: "色", items: ["赤", "赤"] }]);
    assert.throws(() => readCatalog(raw));
  });

  test("配列でないデータを拒否する", () => {
    assert.throws(() => readCatalog(JSON.stringify({ not: "array" })));
  });

  test("壊れた JSON を拒否する(例外を投げる)", () => {
    assert.throws(() => readCatalog("{not json"));
  });
});

describe("F-5-2: CSV 出力のエスケープ(csv/csvText)", () => {
  const { csv, csvText } = createPureFunctions();

  test("カンマ・引用符・改行を含む値は引用符で囲み、内部の引用符を二重化する", () => {
    assert.equal(csv('a,"b"\nc'), '"a,""b""\nc"');
  });
  test("通常の値はそのまま出力する", () => {
    assert.equal(csv("赤;青"), "赤;青");
  });
  test("数式として解釈されうる先頭文字(=,+,-,@)にアポストロフィを付与する", () => {
    assert.equal(csvText("=SUM(A1)"), "'=SUM(A1)");
    assert.equal(csvText("+1"), "'+1");
    assert.equal(csvText("-1"), "'-1");
    assert.equal(csvText("@user"), "'@user");
  });
  test("複数タグを結合した文字列も数式対策の対象になる(F-5-2)", () => {
    const tags = ["=evil:tag", "色:赤"].join("; ");
    assert.equal(csvText(tags), "'" + tags);
  });
});

describe("R2-001: 複数タブでのカタログ編集の競合検出", () => {
  test("古いスナップショットのまま保存しようとすると拒否され、既存の変更が失われない", async () => {
    const backend = createSharedStorageBackend();
    const locks = createSharedLockManager();
    const tabA = createCatalogTab({ localStorage: createLocalStorage(backend), locks });
    const tabB = createCatalogTab({ localStorage: createLocalStorage(backend), locks });
    tabA.init(null);
    tabB.init(null);

    const okA = await tabA.editCatalog((draft) => draft.push({ name: "色", items: [] }));
    assert.equal(okA, true);

    // タブB はタブAの変更を知らないまま(スナップショットが古いまま)保存しようとする。
    const okB = await tabB.editCatalog((draft) => draft.push({ name: "形", items: [] }));
    assert.equal(okB, false, "古いスナップショットでの保存は拒否されるべき");

    // 拒否された時点でタブBの表示は最新化され、タブAの「色」が見えているはず。
    assert.deepEqual(plain(tabB.catalog), [{ name: "色", items: [] }]);

    // 最新化された状態で再操作すれば成功し、両方の変更が残る(データ消失なし)。
    const okB2 = await tabB.editCatalog((draft) => draft.push({ name: "形", items: [] }));
    assert.equal(okB2, true);
    assert.deepEqual(plain(tabB.catalog), [{ name: "色", items: [] }, { name: "形", items: [] }]);

    const finalRaw = backend["okulab-time/catalog"];
    assert.deepEqual(JSON.parse(finalRaw), [{ name: "色", items: [] }, { name: "形", items: [] }]);
  });

  test("同一タブ内で await せず連続発火した場合、後発は安全側に拒否されうるが、データは失われず再操作で反映される", async () => {
    // editCatalog は「読込・比較・保存」をロック内で直列化する一方、比較対象の
    // 期待値(expected)はロック取得**前**(呼び出し直後)に同期的に確定する
    // (js/app.js の editCatalog 実装コメント「待機中に画面が更新された場合、
    // 古い画面の添字による操作も拒否する」参照)。そのため、同一タブ内でも
    // 1件目の保存が完了する前に2件目を発火すると、2件目は「他の操作で
    // 更新された」ものとして拒否されうる。これはデータを失わない安全な
    // 失敗であり、UI 側が結果を見て再操作を促す設計と一致する。
    const backend = createSharedStorageBackend();
    const locks = createSharedLockManager();
    const tab = createCatalogTab({ localStorage: createLocalStorage(backend), locks });
    tab.init(null);

    const [r1, r2] = await Promise.all([
      tab.editCatalog((draft) => draft.push({ name: "色", items: [] })),
      tab.editCatalog((draft) => draft.push({ name: "形", items: [] })),
    ]);
    assert.equal(r1, true, "先に確定した1件目は保存される");
    // 2件目は拒否されてもデータが消えてはいけない(1件目の内容が残っている)。
    if (r2 === false) {
      assert.deepEqual(plain(tab.catalog), [{ name: "色", items: [] }]);
      const retry = await tab.editCatalog((draft) => draft.push({ name: "形", items: [] }));
      assert.equal(retry, true, "最新状態での再操作は成功する");
    }
    assert.equal(tab.catalog.length, 2, "最終的に両方の変更が反映される(データ消失なし)");
  });
});

describe("F-8-6: 選択済みタグの整合(pruneSelectedTags)", () => {
  test("カタログから削除された内容は選択状態からも除外される", async () => {
    const backend = createSharedStorageBackend();
    const locks = createSharedLockManager();
    const tab = createCatalogTab({ localStorage: createLocalStorage(backend), locks });
    tab.init(null);
    await tab.editCatalog((draft) => draft.push({ name: "色", items: ["赤", "青"] }));
    const tag = tab.catalogTag("色", "赤");
    tab.selectedTags.add(tag);
    assert.equal(tab.selectedTags.has(tag), true);

    // 「赤」を削除。
    await tab.editCatalog((draft) => { draft[0].items = draft[0].items.filter((i) => i !== "赤"); });
    assert.equal(tab.selectedTags.has(tag), false, "削除された内容の選択は残ってはいけない");
  });
});
