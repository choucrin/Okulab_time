// ─────────────────────────────────────────────────────────────
//  端末時計とサーバー時計のズレを推定する
//
//  2台の端末がそれぞれ Date.now() で時刻を取ると、端末どうしの
//  時計のズレ(通常 数十〜数百ミリ秒)がそのまま計測誤差になる。
//  そこで Firestore の serverTimestamp() を基準時計として使い、
//  「サーバー時刻 − 自端末時刻」のオフセットを推定して補正する。
//
//  推定方法(SNTP と同じ考え方):
//    t0 = 書き込み直前のローカル時刻
//    t1 = 書き込み完了直後のローカル時刻
//    サーバーが時刻を刻んだのは t0〜t1 のどこか
//      → offset ≈ server − (t0 + t1) / 2
//      → 誤差   ≈ (t1 − t0) / 2
//  往復時間が最も短かった試行を採用する(標準的な手法)。
// ─────────────────────────────────────────────────────────────

import {
  doc, setDoc, getDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";

const DEFAULT_ROUNDS   = 5;
const RESYNC_EVERY_MS  = 4 * 60 * 1000; // 定期再同期
const STALE_AFTER_MS   = 6 * 60 * 1000; // これを超えたら「古い」扱い
const GOOD_ACCURACY_MS = 250;           // これ以下なら良好とみなす

export class ClockSync {
  /**
   * @param {import('firebase/firestore').Firestore} db
   * @param {string[]} pathSegments プローブ用ドキュメントのパス
   */
  constructor(db, pathSegments) {
    this.ref = doc(db, ...pathSegments);
    this.offsetMs = 0;
    this.accuracyMs = null;   // ± ミリ秒(小さいほど良い)
    this.syncedAt = null;     // ローカル時刻
    this.ok = false;
    this.onChange = () => {};

    this._timer = null;
    this._busy = false;
    this._onVisible = () => {
      if (document.visibilityState === "visible") this.sync(3);
    };
  }

  /** サーバー基準に補正した現在時刻(ミリ秒) */
  now() {
    return Date.now() + this.offsetMs;
  }

  /** 同期状態の要約 */
  get quality() {
    if (!this.ok) return "unsynced";
    if (this.syncedAt !== null && Date.now() - this.syncedAt > STALE_AFTER_MS) return "stale";
    return this.accuracyMs !== null && this.accuracyMs <= GOOD_ACCURACY_MS ? "good" : "rough";
  }

  async start() {
    document.addEventListener("visibilitychange", this._onVisible);
    this._timer = setInterval(() => this.sync(3), RESYNC_EVERY_MS);
    await this.sync(DEFAULT_ROUNDS);
  }

  stop() {
    document.removeEventListener("visibilitychange", this._onVisible);
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** @param {number} rounds 試行回数 */
  async sync(rounds = DEFAULT_ROUNDS) {
    if (this._busy) return;
    this._busy = true;
    try {
      let best = null;
      for (let i = 0; i < rounds; i++) {
        try {
          const s = await this._probe();
          if (!best || s.accuracyMs < best.accuracyMs) best = s;
        } catch {
          // 単発の失敗は無視して次の試行へ
        }
        if (i < rounds - 1) await sleep(60);
      }
      if (best) {
        this.offsetMs = best.offsetMs;
        this.accuracyMs = best.accuracyMs;
        this.syncedAt = Date.now();
        this.ok = true;
      } else if (this.syncedAt === null) {
        this.ok = false;
      }
      this.onChange(this);
    } finally {
      this._busy = false;
    }
  }

  async _probe() {
    const t0 = Date.now();
    await setDoc(this.ref, { t: serverTimestamp() });
    const t1 = Date.now();

    const snap = await getDoc(this.ref);
    const ts = snap.get("t");
    if (!ts || typeof ts.toMillis !== "function") {
      throw new Error("server timestamp is not resolved");
    }
    return {
      offsetMs: ts.toMillis() - (t0 + t1) / 2,
      accuracyMs: (t1 - t0) / 2,
    };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
