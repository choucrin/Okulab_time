// F-9(ランダム条件測定)の Test 工程での独立検証。
//
// js/app.js から実際の関数本体を切り出して実行するため(test/support 参照)、
// テスト用に書き直した別実装ではなく出荷対象のコードを検証している。
// ただし実ブラウザ・実 Firebase・実機での検証の代替ではない(Test.md 参照)。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createPureFunctions, createRandomTab,
  createSharedLockManager, createSharedStorageBackend, createLocalStorage,
} from "./support/sandbox.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));

describe("F-9-3: ランダム項目の検証(validateRandomItems)", () => {
  const { validateRandomItems } = createPureFunctions();

  test("項目が1つもない場合は拒否する", () => {
    assert.throws(() => validateRandomItems([]));
    assert.throws(() => validateRandomItems(null));
  });

  test("試行回数が1以上の整数でない項目は拒否する(0・負数・小数)", () => {
    assert.throws(() => validateRandomItems([{ tags: [], count: 0 }]));
    assert.throws(() => validateRandomItems([{ tags: [], count: -1 }]));
    assert.throws(() => validateRandomItems([{ tags: [], count: 1.5 }]));
  });

  test("タグは21個以上を拒否する(F-8-6と同じ上限20)", () => {
    const tags = Array.from({ length: 21 }, (_, i) => `ジャンル${i}:内容`);
    assert.throws(() => validateRandomItems([{ tags, count: 1 }]));
    const ok = Array.from({ length: 20 }, (_, i) => `ジャンル${i}:内容`);
    assert.equal(validateRandomItems([{ tags: ok, count: 1 }]), 1);
  });

  test("同一項目内で同じジャンルのタグを複数指定すると拒否する(F-8-6と同様1ジャンル1個)", () => {
    assert.throws(() => validateRandomItems([{ tags: ["色:赤", "色:青"], count: 1 }]));
  });

  test("不正な形式のタグ文字列(区切りコロンなし等)を拒否する", () => {
    assert.throws(() => validateRandomItems([{ tags: ["いろあか"], count: 1 }]));
  });

  test("総試行回数を正しく合計して返す(F-9-4)", () => {
    const total = validateRandomItems([
      { tags: ["色:赤"], count: 3 },
      { tags: [], count: 5 },
    ]);
    assert.equal(total, 8);
  });

  test("総試行回数が安全な整数の範囲を超える場合は拒否する", () => {
    assert.throws(() => validateRandomItems([
      { tags: [], count: Number.MAX_SAFE_INTEGER },
      { tags: [], count: 1 },
    ]));
  });
});

describe("F-9-8: 次回試行内容の重み付き抽選(chooseRandomItem)", () => {
  const { chooseRandomItem } = createPureFunctions();

  test("残り試行回数が0の項目は選ばれない", () => {
    const items = [{ count: 1, done: 1 }, { count: 2, done: 0 }];
    // rng が返す値によらず、残り0の項目(index 0)は選ばれてはいけない。
    for (const rng of [() => 0, () => 0.4999, () => 0.999999]) {
      assert.equal(chooseRandomItem(items, rng), 1);
    }
  });

  test("すべての項目の残りが0の場合は null を返す(F-9-11)", () => {
    const items = [{ count: 1, done: 1 }, { count: 2, done: 2 }];
    assert.equal(chooseRandomItem(items, () => 0.5), null);
  });

  test("残り試行回数に比例した境界で選ばれる項目が切り替わる", () => {
    // 残り: [2, 1, 3] 合計6。境界は 2/6, 3/6, 6/6。
    const items = [{ count: 2, done: 0 }, { count: 1, done: 0 }, { count: 3, done: 0 }];
    assert.equal(chooseRandomItem(items, () => 0), 0);
    assert.equal(chooseRandomItem(items, () => 1.9 / 6), 0);
    assert.equal(chooseRandomItem(items, () => 2.1 / 6), 1);
    assert.equal(chooseRandomItem(items, () => 2.9 / 6), 1);
    assert.equal(chooseRandomItem(items, () => 3.1 / 6), 2);
    assert.equal(chooseRandomItem(items, () => 5.9 / 6), 2);
  });
});

describe("F-9-12: 記録の方式・判定表示(randomOutcomeText/randomRecordText)", () => {
  const { randomOutcomeText, randomRecordText } = createPureFunctions();

  test("任意方式の記録は方式表示が『任意』になる", () => {
    assert.equal(randomRecordText({ mode: "free" }), "任意");
  });

  test("mode フィールドが無い旧記録は『任意』として扱う(後方互換)", () => {
    assert.equal(randomRecordText({}), "任意");
    assert.equal(randomOutcomeText({}), "");
  });

  test("ランダム方式は判定に応じて『有効』『ランダム試行内のエラーデータ』『未確定』を返す", () => {
    assert.equal(randomOutcomeText({ mode: "random", randomOutcome: "confirmed" }), "有効");
    assert.equal(randomOutcomeText({ mode: "random", randomOutcome: "discarded" }), "ランダム試行内のエラーデータ");
    assert.equal(randomOutcomeText({ mode: "random", randomOutcome: null }), "未確定");
  });

  test("ランダム方式の記録表示にバッチ識別子を含めない(F-10-9)", () => {
    const text = randomRecordText({ mode: "random", randomBatchId: "batch-xyz", randomOutcome: "confirmed" });
    assert.doesNotMatch(text, /batch-xyz/);
    assert.match(text, /有効/);
  });
});

describe("F-9-5: 保存済みランダム条件セットの検証(readRandomSets)", () => {
  test("正常なセットを読み込める", () => {
    const backend = createSharedStorageBackend();
    backend["okulab-time/random/sets"] = JSON.stringify([
      { name: "セットA", items: [{ tags: ["色:赤"], count: 2, done: 0 }] },
    ]);
    const tab = createRandomTab({ localStorage: createLocalStorage(backend), locks: createSharedLockManager() });
    assert.deepEqual(plain(tab.readRandomSets()), [
      { name: "セットA", items: [{ tags: ["色:赤"], count: 2, done: 0 }] },
    ]);
  });

  test("保存名が重複していると拒否する(F-9-5)", () => {
    const backend = createSharedStorageBackend();
    backend["okulab-time/random/sets"] = JSON.stringify([
      { name: "同名", items: [{ tags: [], count: 1, done: 0 }] },
      { name: "同名", items: [{ tags: [], count: 1, done: 0 }] },
    ]);
    const tab = createRandomTab({ localStorage: createLocalStorage(backend), locks: createSharedLockManager() });
    assert.throws(() => tab.readRandomSets());
  });

  test("保存名が空文字・41文字以上だと拒否する(catalogName と同じ上限)", () => {
    const backend = createSharedStorageBackend();
    backend["okulab-time/random/sets"] = JSON.stringify([
      { name: "あ".repeat(41), items: [{ tags: [], count: 1, done: 0 }] },
    ]);
    const tab = createRandomTab({ localStorage: createLocalStorage(backend), locks: createSharedLockManager() });
    assert.throws(() => tab.readRandomSets());
  });

  test("未保存(null)の場合は空配列を返す", () => {
    const backend = createSharedStorageBackend();
    const tab = createRandomTab({ localStorage: createLocalStorage(backend), locks: createSharedLockManager() });
    assert.deepEqual(plain(tab.readRandomSets()), []);
  });
});

describe("複数タブでのランダム進行状況の競合検出(mutateRandomのR2-001相当)", () => {
  test("古いスナップショットのまま更新しようとすると拒否され、最新の内容に復旧する", async () => {
    const backend = createSharedStorageBackend();
    const locks = createSharedLockManager();
    const tabA = createRandomTab({ localStorage: createLocalStorage(backend), locks });
    const tabB = createRandomTab({ localStorage: createLocalStorage(backend), locks });

    const items = [{ tags: [], count: 3, done: 0 }];
    await tabA.mutateRandom(() => ({ id: "batch-1", items, next: 0, previous: null, pending: null, mode: "random" }));

    // タブBはタブAの確定(インポート)を知らないまま、古い(null の)状態を基準に更新しようとする。
    await assert.rejects(() => tabB.mutateRandom((b) => { b.mode = "free"; return b; }));

    // 拒否された時点でタブBの表示はタブAの最新内容に復旧しているはず(データ消失や無断上書きがない)。
    assert.deepEqual(plain(tabB.randomBatch), {
      id: "batch-1", items, next: 0, previous: null, pending: null, mode: "random",
    });

    // 復旧後に最新のスナップショットを基準に再操作すれば成功する。
    await tabB.mutateRandom((b) => { b.mode = "free"; return b; });
    assert.equal(tabB.randomBatch.mode, "free");
    assert.equal(JSON.parse(backend["okulab-time/random/room-1"]).mode, "free");
  });

  test("破損した保存内容は復旧時に上書きせず、安全側に倒す", () => {
    const backend = createSharedStorageBackend();
    backend["okulab-time/random/room-1"] = "{not json";
    const tab = createRandomTab({ localStorage: createLocalStorage(backend), locks: createSharedLockManager() });
    tab.restoreRandom();
    assert.equal(tab.randomBatch, null);
    assert.equal(backend["okulab-time/random/room-1"], "{not json", "破損データが上書きされてはいけない");
  });
});
