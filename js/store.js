// ─────────────────────────────────────────────────────────────
//  Firestore アクセス層
//
//  データ構造:
//    rooms/{roomId}/meta/current      … 進行中セッションの排他制御
//    rooms/{roomId}/sessions/{id}     … 1 回の計測 = 1 ドキュメント
//    rooms/{roomId}/clock/{uid}       … 時計同期用のプローブ置き場
//
//  roomId は合言葉の SHA-256(先頭 40 桁)。合言葉そのものは
//  ネットワークにも保存領域にも出さない。
//
//  開始と終了の対応付けはトランザクションで行うため、
//  Cloud Functions を使わずに「同時に 2 本走る」事故を防げる。
// ─────────────────────────────────────────────────────────────

import {
  collection, doc, runTransaction, onSnapshot, query, orderBy, limit,
  serverTimestamp, deleteDoc, getDocFromServer, getDocsFromServer, writeBatch,
} from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";

/** 画面に一覧表示する件数の上限(CSV 書き出しは全件を取り直す) */
export const SESSION_LIMIT = 300;

/** 一括削除の 1 回あたりの件数(Firestore の上限は 500 操作) */
const BATCH_SIZE = 400;

/**
 * 削除の確定を待つ上限。
 * 通信が切れると解決も棄却もしないことがあるため、必ず打ち切る。
 */
const COMMIT_TIMEOUT_MS = 15000;

/**
 * 全件の読み出しを待つ上限。
 * 打ち切らないと、書き出しと一括削除が動いたままになり、
 * どちらの操作も始められなくなる。
 */
const READ_TIMEOUT_MS = 20000;

/**
 * 「消えなかった」と言い切れるコード。サーバーが書き込みを拒んだ場合に限る。
 *
 * 送信は commit() を呼んだ時点で出ていくため、これ以外の失敗では
 * 届いていた可能性が残る。列挙するのは確実な側だけにし、
 * 知らないコードは結果不明として扱う(誤って「残っている」と
 * 伝えると、消えた記録を見落とすことになる)。
 *
 * not-found は入れない。削除では「見つからない = すでに無い」であり、
 * 残っていることの証明にはならない。
 */
const REJECTED = new Set([
  "permission-denied", "invalid-argument", "failed-precondition",
  "out-of-range", "unimplemented",
]);

/** 合言葉 → ルーム ID(SHA-256) */
export async function deriveRoomId(passphrase) {
  if (!globalThis.crypto?.subtle) {
    throw userError(
      "この環境では暗号 API が使えません。https:// または http://localhost で開いてください。"
    );
  }
  // 全角/半角・大文字小文字の食い違いで別ルームになるのを防ぐ
  const normalized = passphrase.normalize("NFKC").trim().toLowerCase();
  const bytes = new TextEncoder().encode(`okulab-time:v1:${normalized}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
}

const currentRef  = (db, roomId) => doc(db, "rooms", roomId, "meta", "current");
const sessionsCol = (db, roomId) => collection(db, "rooms", roomId, "sessions");
const sessionRef  = (db, roomId, id) => doc(db, "rooms", roomId, "sessions", id);

/**
 * 新しいセッション ID を先に採番する。
 * 送信を再試行しても同じ ID を使うことで、二重登録を防ぐ。
 */
export function newSessionId(db, roomId) {
  return doc(sessionsCol(db, roomId)).id;
}

/**
 * 計測を開始する。
 * @returns {Promise<{ok:true,id:string,duplicate?:boolean}|{ok:false,code:string}>}
 */
export function startSession(db, roomId, press, sessionId) {
  const cur = currentRef(db, roomId);
  const ref = doc(sessionsCol(db, roomId), sessionId);

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(cur);
    const activeId = snap.exists() ? snap.data().activeSessionId : null;

    // 送信は届いていたが応答を受け取れず再送した場合。
    // 進行中フラグだけでなく実体も見る(再送前に終了まで進んでいることがある)。
    if (activeId === sessionId) return { ok: true, id: sessionId, duplicate: true };
    const existing = await tx.get(ref);
    if (existing.exists()) {
      return { ok: true, id: sessionId, duplicate: true, status: existing.data().status };
    }

    if (activeId) return { ok: false, code: "ALREADY_RUNNING" };

    tx.set(ref, {
      status: "running",
      label: press.label ?? "",
      startMs: press.at,
      startRawMs: press.rawAt,          // 補正前(端末の生の Date.now())
      startOffsetMs: press.offsetMs,
      startAccuracyMs: press.accuracyMs,
      startSynced: press.synced,        // false なら未補正の記録
      startedBy: press.uid,
      startedAt: serverTimestamp(),
      endMs: null,
      endRawMs: null,
      endOffsetMs: null,
      endAccuracyMs: null,
      endSynced: null,
      endedBy: null,
      endedAt: null,
      durationMs: null,
      durationSec: null,
    });
    tx.set(cur, { activeSessionId: sessionId, updatedAt: serverTimestamp() });
    return { ok: true, id: sessionId };
  });
}

/**
 * 進行中の計測を終了する。
 * @param {string|null} expectedId 終了させるつもりだったセッション(再送の判定に使う)
 * @returns {Promise<{ok:true,id:string,durationMs:number,duplicate?:boolean}|{ok:false,code:string}>}
 */
export function endSession(db, roomId, press, expectedId) {
  const cur = currentRef(db, roomId);

  return runTransaction(db, async (tx) => {
    const curSnap = await tx.get(cur);
    const activeId = curSnap.exists() ? curSnap.data().activeSessionId : null;

    // 終了させるつもりだったものと、いま進行中のものが食い違う場合は
    // 絶対に別のセッションを終了させない(再送や同時操作で起こりうる)。
    if (expectedId && activeId !== expectedId) {
      const prev = await tx.get(sessionRef(db, roomId, expectedId));
      if (prev.exists() && prev.data().status === "done") {
        // 押した時刻が一致する = 送信は届いていて応答だけを受け取れなかった
        if (prev.data().endMs === press.at) {
          return { ok: true, id: expectedId, durationMs: prev.data().durationMs, duplicate: true };
        }
        // 別の計測が進行中なら、そちらを終了し損ねていることを伝える
        return { ok: false, code: activeId ? "SESSION_CHANGED" : "ALREADY_ENDED" };
      }
      return { ok: false, code: activeId ? "SESSION_CHANGED" : "NOT_RUNNING" };
    }

    if (!activeId) return { ok: false, code: "NOT_RUNNING" };

    const ref = sessionRef(db, roomId, activeId);
    const snap = await tx.get(ref);
    if (!snap.exists() || snap.data().status !== "running") {
      // 参照先が消えている / 既に終了済み → 進行中フラグだけ掃除する
      tx.set(cur, { activeSessionId: null, updatedAt: serverTimestamp() });
      return { ok: false, code: "STALE_CLEARED" };
    }

    const durationMs = press.at - snap.data().startMs;
    tx.update(ref, {
      status: "done",
      endMs: press.at,
      endRawMs: press.rawAt,
      endOffsetMs: press.offsetMs,
      endAccuracyMs: press.accuracyMs,
      endSynced: press.synced,
      endedBy: press.uid,
      endedAt: serverTimestamp(),
      durationMs,
      durationSec: durationMs / 1000,
    });
    tx.set(cur, { activeSessionId: null, updatedAt: serverTimestamp() });
    return { ok: true, id: activeId, durationMs };
  });
}

/** 進行中の計測を破棄する(誤操作の復旧用) */
export function abortSession(db, roomId, { uid, expectedId }) {
  const cur = currentRef(db, roomId);

  return runTransaction(db, async (tx) => {
    const curSnap = await tx.get(cur);
    const activeId = curSnap.exists() ? curSnap.data().activeSessionId : null;

    // 中止しようとしたものと食い違う場合は、別のセッションを巻き添えにしない。
    // expectedId が無い場合だけは「いま進行中のものを止める」強制復旧として扱う。
    if (expectedId && activeId !== expectedId) {
      const prev = await tx.get(sessionRef(db, roomId, expectedId));
      if (prev.exists() && prev.data().status === "aborted") {
        return { ok: true, id: expectedId, duplicate: true };
      }
      return { ok: false, code: activeId ? "SESSION_CHANGED" : "NOT_RUNNING" };
    }

    if (!activeId) return { ok: false, code: "NOT_RUNNING" };

    const ref = sessionRef(db, roomId, activeId);
    const snap = await tx.get(ref);
    if (snap.exists() && snap.data().status === "running") {
      tx.update(ref, {
        status: "aborted",
        endedBy: uid,
        endedAt: serverTimestamp(),
      });
    }
    tx.set(cur, { activeSessionId: null, updatedAt: serverTimestamp() });
    return { ok: true, id: activeId };
  });
}

/**
 * 記録を 1 件削除する(進行中のものはルール側でも拒否される)。
 * まとめ送りと同じく、通信が切れたまま固まらないよう打ち切る。
 *
 * 打ち切りは「送ったが結果が分からない」状態。何が起きたかだけを返し、
 * 「消えたか分からない」という言い方は呼び出し側が添える(重複を避ける)。
 */
export function deleteSession(db, roomId, id) {
  return withTimeout(deleteDoc(sessionRef(db, roomId, id)), COMMIT_TIMEOUT_MS);
}

/**
 * 削除できる記録を数え上げる。
 *
 * 進行中の記録は対象から外す(ルール側でも削除は拒否される)。
 * 一覧の購読には上限があるため、対象は必ずサーバーから取り直す。
 * 並べ替えを指定すると、その項目を持たない記録が結果から漏れるため指定しない。
 */
export async function collectDeletable(db, roomId) {
  const snap = await withTimeout(
    getDocsFromServer(sessionsCol(db, roomId)),
    READ_TIMEOUT_MS,
    "記録の数え上げに時間がかかりすぎました。通信状況を確認してください。"
  );
  const targets = snap.docs.filter((d) => d.data().status !== "running");
  return { refs: targets.map((d) => d.ref), skipped: snap.docs.length - targets.length };
}

/**
 * 記録をまとめて削除する。**元に戻せない。**
 *
 * まとめて送る単位ごとに、全部消えるか 1 件も消えないかのどちらかになる。
 * 途中で失敗した場合、そこまでの内訳を例外に添えて返す。
 *
 * 例外には次を添える:
 *   deleted … 確実に消えた件数(ここまでは確定)
 *   pending … 結果を確認できなかった件数。送った後の失敗は、
 *             後からサーバー側で確定することがあるため、
 *             消えたとも残ったとも言えない。
 *
 * @param {(done:number, total:number) => void} [onProgress]
 * @returns {Promise<number>} 削除できた件数
 */
export async function deleteSessions(db, refs, onProgress) {
  let deleted = 0;

  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    const chunk = refs.slice(i, i + BATCH_SIZE);
    let sent = false;

    // まとめ送りの組み立ても try の中で行う。ここで投げた例外に
    // 件数が付かないと、消えた記録を「残っている」と伝えてしまう。
    try {
      const batch = writeBatch(db);
      for (const ref of chunk) batch.delete(ref);
      // 送信が出ていくのは commit() を呼んだ瞬間。呼ぶ前に印を付けると、
      // 呼び出し自体が投げた場合(何も送っていない)まで結果不明になる。
      const committing = batch.commit();
      sent = true;
      // 通信が切れると解決も棄却もしないことがあるため打ち切る
      await withTimeout(committing, COMMIT_TIMEOUT_MS);
    } catch (cause) {
      // 文字列などが投げられても目印を付けられるようにする
      const err = cause && typeof cause === "object" ? cause : new Error(String(cause));
      err.deleted = deleted;       // ここまでは確実に消えている
      // 拒否された場合だけ「消えなかった」と言える。送信を出した後は、
      // それ以外の失敗では届いていた可能性が残る。
      if (sent && !REJECTED.has(err.code)) err.pending = chunk.length;
      throw err;
    }

    deleted += chunk.length;

    try {
      onProgress?.(deleted, refs.length);
    } catch (err) {
      // 進捗の表示は削除の成否と関係ない。ここで抜けると、
      // 消えた件数を伝えられないまま失敗したように見えてしまう。
      console.error("[okulab-time] 進捗の通知に失敗しました", err);
    }
  }

  return deleted;
}

/**
 * その失敗のあと、削除が成立している可能性が残るか。
 *
 * 送信は呼んだ時点で出ていくため、サーバーが拒んだと分かる場合を除いて
 * 「消えたとも残ったとも言えない」。まとめ削除の pending と同じ判断を、
 * 1 件削除でも使えるようにしたもの。
 */
export function isUncertain(err) {
  return Boolean(err?.timedOut) || !REJECTED.has(err?.code);
}

function withTimeout(promise, ms, message = COMMIT_TIMEOUT_MESSAGE) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(userError(message), { timedOut: true })), ms);
    }),
  ]);
}

const COMMIT_TIMEOUT_MESSAGE = "削除の確定に時間がかかりすぎました。通信状況を確認してください。";

/**
 * そのまま画面に出してよい例外。
 * 目印が無い例外は処理系のメッセージなので、利用者には見せない
 * (js/app.js の describeError を参照)。
 */
function userError(message) {
  const err = new Error(message);
  err.userMessage = message;
  return err;
}

/** 記録一覧を購読する(開始時刻の新しい順・最新 SESSION_LIMIT 件) */
export function subscribeSessions(db, roomId, onData, onError) {
  const q = query(sessionsCol(db, roomId), orderBy("startMs", "desc"), limit(SESSION_LIMIT));
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}

/**
 * 進行中フラグを購読する。
 * 一覧クエリは件数上限があるため、「計測中かどうか」はこちらを正とする。
 */
export function subscribeCurrent(db, roomId, onData, onError) {
  return onSnapshot(
    currentRef(db, roomId),
    (snap) => onData(snap.exists() ? (snap.data().activeSessionId ?? null) : null),
    onError
  );
}

/**
 * 進行中フラグをサーバーから直接読む。
 * 購読が無言で止まっていても現状を確かめられるようにするための経路で、
 * キャッシュではなく必ずサーバーに問い合わせる。
 */
export async function fetchCurrentFromServer(db, roomId) {
  const snap = await getDocFromServer(currentRef(db, roomId));
  return snap.exists() ? (snap.data().activeSessionId ?? null) : null;
}

/**
 * CSV 書き出し用に全件を取得する(古い順)。
 * 通常の取得はオフライン時に黙ってキャッシュへ落ち、
 * 購読済みの分だけを「全件」として返してしまうため、必ずサーバーから読む。
 */
export async function fetchAllSessions(db, roomId) {
  const snap = await withTimeout(
    getDocsFromServer(query(sessionsCol(db, roomId), orderBy("startMs", "asc"))),
    READ_TIMEOUT_MS,
    "記録の読み出しに時間がかかりすぎました。通信状況を確認してください。"
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
