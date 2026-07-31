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
  serverTimestamp, deleteDoc, getDocs,
} from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";

/** 画面に一覧表示する件数の上限(CSV 書き出しは全件を取り直す) */
export const SESSION_LIMIT = 300;

/** 合言葉 → ルーム ID(SHA-256) */
export async function deriveRoomId(passphrase) {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
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
    if (existing.exists()) return { ok: true, id: sessionId, duplicate: true };

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
      // 送信は届いていて、応答だけを受け取れなかった場合
      if (prev.exists() && prev.data().status === "done" && prev.data().endMs === press.at) {
        return { ok: true, id: expectedId, durationMs: prev.data().durationMs, duplicate: true };
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

/** 記録を 1 件削除する(進行中のものはルール側でも拒否される) */
export function deleteSession(db, roomId, id) {
  return deleteDoc(sessionRef(db, roomId, id));
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

/** CSV 書き出し用に全件を取得する(古い順) */
export async function fetchAllSessions(db, roomId) {
  const snap = await getDocs(query(sessionsCol(db, roomId), orderBy("startMs", "asc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
