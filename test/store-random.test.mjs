// F-9(ランダム条件測定)に伴う js/store.js の変更(受領記録 startReceipts、
// randomOutcome の一度限りの更新)の Test 工程での独立検証。
//
// js/store.js は Firestore(CDN)の modular API を import するトップレベルの
// モジュールであり、Node からネットワーク越しの import はできない。
// そこで js/app.js 向けの手法(test/support/extract-app-functions.mjs)と同様に、
// 検証対象の関数と、それが依存する参照ヘルパー(currentRef/sessionsCol/
// sessionRef)の**実ソースコードそのもの**を切り出し、Firestore の
// runTransaction/doc/collection を模した最小限のインメモリスタブと共に
// vm サンドボックスで実行する。実 Firebase・実 Firestore ルールエンジンでの
// 認可評価の代替ではない(Test.md 参照)。
//
// Review.md の R1-001(確認待ち記録の削除で古い計測が再作成される)・
// R1-002(初回通信断からの復旧で押下時刻が失われる)の修正がこのテスト実行
// でも保たれていることを回帰確認する。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readSource, extractFunction, extractConst } from "./support/extract-app-functions.mjs";

// vm サンドボックス(別レルム)で作られたオブジェクトは、構造が同じでも
// Node の Object コンストラクタと異なるため、assert.deepEqual が
// 「構造は同じだが reference-equal でない」として失敗する。JSON を介して
// 現在のレルムの素の値に変換してから比較する(test/catalog.test.mjs と同じ対処)。
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * doc/collection/runTransaction/serverTimestamp を模した、パスをキーにした
 * インメモリの Firestore ストア。実際のトランザクションの分離・アトミック性
 * (同時実行時の競合)までは再現していない、単一トランザクションが順に
 * 実行される前提の簡易スタブ。
 */
function createFirestoreStub() {
  const store = new Map();
  function collection(parent, ...rest) {
    const base = parent && typeof parent.path === "string" ? parent.path : "";
    return { path: [base, ...rest].filter(Boolean).join("/") };
  }
  function doc(parent, ...rest) {
    const base = parent && typeof parent.path === "string" ? parent.path : "";
    if (!rest.length) {
      const id = `auto-${store.size}-${Math.random().toString(36).slice(2, 8)}`;
      return { path: [base, id].filter(Boolean).join("/"), id };
    }
    return { path: [base, ...rest].filter(Boolean).join("/"), id: rest[rest.length - 1] };
  }
  function runTransaction(_db, updateFn) {
    const tx = {
      async get(ref) {
        const data = store.get(ref.path);
        return { exists: () => data !== undefined, data: () => data };
      },
      set(ref, data) { store.set(ref.path, data); },
      update(ref, partial) { store.set(ref.path, { ...store.get(ref.path), ...partial }); },
    };
    return Promise.resolve(updateFn(tx));
  }
  const serverTimestamp = () => "SERVER_TIMESTAMP";
  return { store, collection, doc, runTransaction, serverTimestamp };
}

function createStoreFunctions() {
  const src = readSource("js/store.js");
  const currentRef = extractConst(src, "currentRef");
  const sessionsCol = extractConst(src, "sessionsCol");
  const sessionRef = extractConst(src, "sessionRef");
  const startSessionBody = extractFunction(src, "startSession");

  const wrapped = `
    (function () {
      const currentRef  = ${currentRef};
      const sessionsCol = ${sessionsCol};
      const sessionRef  = ${sessionRef};
      ${startSessionBody}
      ${extractFunction(src, "decideSequenceSession")}
      return { startSession, decideSequenceSession };
    })()
  `;

  const stub = createFirestoreStub();
  const sandbox = { console };
  vm.createContext(sandbox);
  sandbox.collection = stub.collection;
  sandbox.doc = stub.doc;
  sandbox.runTransaction = stub.runTransaction;
  sandbox.serverTimestamp = stub.serverTimestamp;
  const fns = vm.runInContext(wrapped, sandbox);
  return { ...fns, store: stub.store, db: {} };
}

const randomPress = (overrides = {}) => ({
  at: 1000, rawAt: 1000, offsetMs: 0, accuracyMs: 10, synced: true,
  label: "", tags: ["色:赤"], uid: "uid-opener", mode: "random", randomBatchId: "batch-1",
  ...overrides,
});

describe("F-9 / R1-001・R1-002: startSession の受領記録(startReceipts)", () => {
  test("初回送信は計測記録と受領記録を同時に作成する", async () => {
    const { startSession, store, db } = createStoreFunctions();
    const result = await startSession(db, "room-1", randomPress(), "session-1");
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, undefined);
    const session = store.get("rooms/room-1/sessions/session-1");
    assert.equal(session.status, "running");
    assert.equal(session.mode, "random");
    assert.equal(session.randomBatchId, "batch-1");
    assert.deepEqual(plain(session.tags), ["色:赤"]);
    const receipt = store.get("rooms/room-1/startReceipts/session-1");
    assert.deepEqual(plain(receipt), { startedBy: "uid-opener" });
  });

  test("同じIDへの再送(進行中のまま)は重複として扱われ、開始時刻は変わらない", async () => {
    const { startSession, store, db } = createStoreFunctions();
    await startSession(db, "room-1", randomPress({ at: 12345 }), "session-1");
    // まだ進行中(meta/current が session-1 のまま)の状態での再送は、
    // 実体を見るまでもなく「進行中フラグが一致」で重複と判定される。
    const resend = await startSession(db, "room-1", randomPress({ at: 99999 }), "session-1");
    assert.equal(resend.ok, true);
    assert.equal(resend.duplicate, true);
    assert.equal(store.get("rooms/room-1/sessions/session-1").startMs, 12345, "再送で開始時刻が書き換わってはいけない");
  });

  test("同じIDへの再送(完了後・進行中フラグが別のセッションに移った後)も、実体を見て重複と判定する", async () => {
    const { startSession, store, db } = createStoreFunctions();
    await startSession(db, "room-1", randomPress({ at: 12345 }), "session-1");
    // 終了操作(endSession)が完了し、進行中フラグが解除された状態を模す。
    store.set("rooms/room-1/sessions/session-1", { ...store.get("rooms/room-1/sessions/session-1"), status: "done" });
    store.set("rooms/room-1/meta/current", { activeSessionId: null });

    const resend = await startSession(db, "room-1", randomPress({ at: 99999 }), "session-1");
    assert.equal(resend.ok, true);
    assert.equal(resend.duplicate, true);
    assert.equal(resend.status, "done");
    assert.equal(store.get("rooms/room-1/sessions/session-1").startMs, 12345, "再送で開始時刻が書き換わってはいけない");
  });

  test("R1-001: 受領記録はあるが記録本体が削除済みの場合、古い開始時刻で再作成せずSESSION_MISSINGを返す", async () => {
    const { startSession, store, db } = createStoreFunctions();
    await startSession(db, "room-1", randomPress({ at: 111 }), "session-1");
    // 終了(done)して進行中フラグが解除された後、確認待ちの記録が削除された状況を再現する
    // (個別削除・一括削除・別端末削除のいずれも sessions のみを対象とするため、
    // startReceipts は残る)。
    store.set("rooms/room-1/sessions/session-1", { ...store.get("rooms/room-1/sessions/session-1"), status: "done" });
    store.set("rooms/room-1/meta/current", { activeSessionId: null });
    store.delete("rooms/room-1/sessions/session-1");
    assert.equal(store.has("rooms/room-1/startReceipts/session-1"), true);

    const result = await startSession(db, "room-1", randomPress({ at: 111 }), "session-1");
    assert.deepEqual(plain(result), { ok: false, code: "SESSION_MISSING" });
    assert.equal(store.has("rooms/room-1/sessions/session-1"), false, "削除済み記録を古い開始時刻で再作成してはいけない");
  });

  test("R1-002: 受領記録も記録本体も無い(書き込み前に通信が切れた)場合、新方式の予約(existingOnly:false)は元の開始時刻で開始できる", async () => {
    const { startSession, store, db } = createStoreFunctions();
    const result = await startSession(db, "room-1", randomPress({ at: 555 }), "session-1", { existingOnly: false });
    assert.equal(result.ok, true);
    assert.equal(store.get("rooms/room-1/sessions/session-1").startMs, 555);
  });

  test("R1-002: 旧形式の予約(existingOnly:true)は未送信でも新規作成せず確認専用になる", async () => {
    const { startSession, store, db } = createStoreFunctions();
    const result = await startSession(db, "room-1", randomPress({ at: 555 }), "session-1", { existingOnly: true });
    assert.deepEqual(plain(result), { ok: false, code: "SESSION_MISSING" });
    assert.equal(store.has("rooms/room-1/sessions/session-1"), false);
  });

  test("他の計測が進行中(ALREADY_RUNNING)の場合は開始できない", async () => {
    const { startSession, store, db } = createStoreFunctions();
    store.set("rooms/room-1/meta/current", { activeSessionId: "other-session" });
    const result = await startSession(db, "room-1", randomPress(), "session-1");
    assert.deepEqual(plain(result), { ok: false, code: "ALREADY_RUNNING" });
  });

  test("任意方式(mode:'free')は受領記録を作らず、削除済みIDの再作成は防げない前提のまま挙動が変わらない", async () => {
    const { startSession, store, db } = createStoreFunctions();
    const press = { at: 1, rawAt: 1, offsetMs: 0, accuracyMs: 10, synced: true, label: "", tags: [], uid: "uid-1", mode: "free", randomBatchId: null };
    await startSession(db, "room-1", press, "session-free");
    assert.equal(store.has("rooms/room-1/startReceipts/session-free"), false, "任意方式は受領記録を作らない(F-9実装メモの対象外)");
  });
});

test("旧ランダム判定の書込経路は廃止し、旧クライアント用ルールは維持する", () => {
  assert.doesNotMatch(readSource('js/store.js'), /function decideRandomSession|tx\.update\(target, \{ randomOutcome:/);
  assert.match(readSource('firestore.rules'), /hasOnly\(\['randomOutcome'\]\)/);
});

describe("F-13: 順序反復の作成・受領・専用判定", () => {
  const press = () => randomPress({mode:"sequence",randomBatchId:null,sequenceRunId:"run-1",sequenceTrial:2,sequenceSet:1,sequencePosition:2});
  test("新方式の5項目と受領記録を作り、旧random項目を流用しない",async()=>{
    const {startSession,store,db}=createStoreFunctions();await startSession(db,"r",press(),"s");
    const d=store.get("rooms/r/sessions/s");assert.equal(d.mode,"sequence");assert.equal(d.randomBatchId,null);assert.equal(d.randomOutcome,null);
    assert.equal(d.sequenceRunId,"run-1");assert.equal(d.sequenceTrial,2);assert.equal(d.sequenceSet,1);assert.equal(d.sequencePosition,2);assert.equal(d.sequenceOutcome,null);
    assert.equal(store.get("rooms/r/startReceipts/s").startedBy,"uid-opener");
    store.delete("rooms/r/sessions/s");store.set("rooms/r/meta/current",{activeSessionId:null});
    const again=await startSession(db,"r",press(),"s");assert.equal(again.code,"SESSION_MISSING");assert.equal(store.has("rooms/r/sessions/s"),false);
  });
  test("専用判定は同じ値で冪等、逆の回答・不正値・計測中・旧記録を拒否",async()=>{
    const {startSession,decideSequenceSession,store,db}=createStoreFunctions();await startSession(db,"r",press(),"s");
    await assert.rejects(decideSequenceSession(db,"r","s","confirmed"));
    const path="rooms/r/sessions/s";store.set(path,{...store.get(path),status:"done"});
    await decideSequenceSession(db,"r","s","confirmed");await decideSequenceSession(db,"r","s","confirmed");
    assert.equal(store.get(path).sequenceOutcome,"confirmed");assert.equal(store.get(path).randomOutcome,null);
    await assert.rejects(decideSequenceSession(db,"r","s","discarded"),/既に判定/);
    await assert.rejects(decideSequenceSession(db,"r","s","other"));
    store.set(path,{...store.get(path),mode:"random"});await assert.rejects(decideSequenceSession(db,"r","s","confirmed"));
  });
  test("任意方式は新5項目をnullで作成し、開始時刻とタグを保持",async()=>{
    const {startSession,store,db}=createStoreFunctions();await startSession(db,"r",randomPress({mode:"free",randomBatchId:null}),"s");
    const d=store.get("rooms/r/sessions/s");for(const f of ["sequenceRunId","sequenceTrial","sequenceSet","sequencePosition","sequenceOutcome"])assert.equal(d[f],null);
    assert.equal(d.startMs,1000);assert.deepEqual(plain(d.tags),["色:赤"]);
  });
});
