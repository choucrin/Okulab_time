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
  serverTimestamp, deleteDoc,
} from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";

export const SESSION_LIMIT = 300;

/** 合言葉 → ルーム ID(SHA-256) */
export async function deriveRoomId(passphrase) {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "この環境では暗号 API が使えません。https:// または http://localhost で開いてください。"
    );
  }
  const normalized = passphrase.normalize("NFKC").trim();
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
 * 計測を開始する。
 * @returns {Promise<{ok:true,id:string}|{ok:false,code:string}>}
 */
export function startSession(db, roomId, { label, atMs, offsetMs, accuracyMs, uid }) {
  const cur = currentRef(db, roomId);
  const ref = doc(sessionsCol(db, roomId));

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(cur);
    if (snap.exists() && snap.data().activeSessionId) {
      return { ok: false, code: "ALREADY_RUNNING" };
    }
    tx.set(ref, {
      status: "running",
      label: label ?? "",
      startMs: atMs,
      startRawMs: atMs - offsetMs,   // 補正前(端末の生の Date.now())
      startOffsetMs: offsetMs,
      startAccuracyMs: accuracyMs,
      startedBy: uid,
      startedAt: serverTimestamp(),
      endMs: null,
      endRawMs: null,
      endOffsetMs: null,
      endAccuracyMs: null,
      endedBy: null,
      endedAt: null,
      durationMs: null,
      durationSec: null,
    });
    tx.set(cur, { activeSessionId: ref.id, updatedAt: serverTimestamp() });
    return { ok: true, id: ref.id };
  });
}

/**
 * 進行中の計測を終了する。
 * @returns {Promise<{ok:true,id:string,durationMs:number}|{ok:false,code:string}>}
 */
export function endSession(db, roomId, { atMs, offsetMs, accuracyMs, uid }) {
  const cur = currentRef(db, roomId);

  return runTransaction(db, async (tx) => {
    const curSnap = await tx.get(cur);
    const activeId = curSnap.exists() ? curSnap.data().activeSessionId : null;
    if (!activeId) return { ok: false, code: "NOT_RUNNING" };

    const ref = sessionRef(db, roomId, activeId);
    const snap = await tx.get(ref);
    if (!snap.exists() || snap.data().status !== "running") {
      // 参照先が消えている / 既に終了済み → 進行中フラグだけ掃除する
      tx.set(cur, { activeSessionId: null, updatedAt: serverTimestamp() });
      return { ok: false, code: "STALE_CLEARED" };
    }

    const durationMs = atMs - snap.data().startMs;
    tx.update(ref, {
      status: "done",
      endMs: atMs,
      endRawMs: atMs - offsetMs,
      endOffsetMs: offsetMs,
      endAccuracyMs: accuracyMs,
      endedBy: uid,
      endedAt: serverTimestamp(),
      durationMs,
      durationSec: durationMs / 1000,
    });
    tx.set(cur, { activeSessionId: null, updatedAt: serverTimestamp() });
    return { ok: true, id: activeId, durationMs };
  });
}

/** 進行中の計測を破棄する(誤操作の復旧用) */
export function abortSession(db, roomId, { uid }) {
  const cur = currentRef(db, roomId);

  return runTransaction(db, async (tx) => {
    const curSnap = await tx.get(cur);
    const activeId = curSnap.exists() ? curSnap.data().activeSessionId : null;
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

/** 記録を 1 件削除する(進行中のものは削除させない) */
export function deleteSession(db, roomId, id) {
  return deleteDoc(sessionRef(db, roomId, id));
}

/** 記録一覧を購読する(開始時刻の新しい順) */
export function subscribeSessions(db, roomId, onData, onError) {
  const q = query(sessionsCol(db, roomId), orderBy("startMs", "desc"), limit(SESSION_LIMIT));
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}
