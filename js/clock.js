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
//
//  区間 t1 − t0 の測定には、OS の時刻補正が走っても影響を受けない
//  performance.now()(単調増加)を使う。
// ─────────────────────────────────────────────────────────────

import {
  doc, setDoc, getDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";

const DEFAULT_ROUNDS   = 5;
const RESYNC_ROUNDS    = 3;
const RESYNC_EVERY_MS  = 4 * 60 * 1000; // 定期再同期
const STALE_AFTER_MS   = 6 * 60 * 1000; // これを超えたら「古い」扱い
const GOOD_ACCURACY_MS = 250;           // これ以下なら良好とみなす
const MAX_ACCURACY_MS  = 5000;          // これを超える標本は捨てる
const MAX_OFFSET_MS    = 400 * 24 * 60 * 60 * 1000; // 明らかに異常な標本を捨てる

export class ClockSync {
  /**
   * @param {import('firebase/firestore').Firestore} db
   * @param {string[]} pathSegments プローブ用ドキュメントのパス
   */
  constructor(db, pathSegments) {
    this.ref = doc(db, ...pathSegments);
    this.offsetMs = 0;
    this.accuracyMs = null;   // ± ミリ秒(小さいほど良い)
    this.syncedAt = null;     // 最後に成功した時刻(ローカル)
    this.ok = false;          // 一度でも同期に成功したか
    this.onChange = () => {};

    this._timer = null;
    this._busy = false;
    this._queued = false;     // 実行中に来た同期要求を取りこぼさない
    this._stopped = false;
    this._failedRounds = 0;

    // iOS Safari では visibilitychange だけでは復帰を取りこぼすことがあるため
    // pageshow / focus / online も拾う
    this._wake = () => {
      if (document.visibilityState === "visible") this.sync(RESYNC_ROUNDS);
    };
    this._wakeAlways = () => this.sync(RESYNC_ROUNDS);
  }

  /** サーバー基準に補正した現在時刻(整数ミリ秒) */
  now() {
    return Math.round(Date.now() + this.offsetMs);
  }

  /** 押下時点の補正状態をまとめて切り出す(後から読み直すとズレるため) */
  snapshot() {
    return {
      at: this.now(),
      rawAt: Date.now(),
      offsetMs: this.offsetMs,
      accuracyMs: this.ok ? this.accuracyMs : null,
      synced: this.ok,
    };
  }

  /** 同期状態の要約 */
  get quality() {
    if (!this.ok) return this._failedRounds > 0 ? "failed" : "pending";
    if (Date.now() - this.syncedAt > STALE_AFTER_MS) return "stale";
    return this.accuracyMs !== null && this.accuracyMs <= GOOD_ACCURACY_MS ? "good" : "rough";
  }

  async start() {
    this._stopped = false;
    document.addEventListener("visibilitychange", this._wake);
    window.addEventListener("pageshow", this._wake);
    window.addEventListener("focus", this._wake);
    window.addEventListener("online", this._wakeAlways);
    this._timer = setInterval(() => this.sync(RESYNC_ROUNDS), RESYNC_EVERY_MS);
    await this.sync(DEFAULT_ROUNDS);
  }

  stop() {
    this._stopped = true;
    this._queued = false;
    document.removeEventListener("visibilitychange", this._wake);
    window.removeEventListener("pageshow", this._wake);
    window.removeEventListener("focus", this._wake);
    window.removeEventListener("online", this._wakeAlways);
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** @param {number} rounds 試行回数 */
  async sync(rounds = DEFAULT_ROUNDS) {
    if (this._stopped) return;
    if (this._busy) { this._queued = true; return; }

    this._busy = true;
    try {
      let best = null;
      for (let i = 0; i < rounds; i++) {
        if (this._stopped) return;
        try {
          const sample = await this._probe();
          if (sample && (!best || sample.accuracyMs < best.accuracyMs)) best = sample;
        } catch {
          // 単発の失敗は無視して次の試行へ
        }
        if (i < rounds - 1) await sleep(60);
      }
      if (this._stopped) return;

      if (best) {
        this.offsetMs = best.offsetMs;
        this.accuracyMs = best.accuracyMs;
        this.syncedAt = Date.now();
        this.ok = true;
        this._failedRounds = 0;
      } else {
        this._failedRounds += 1;
      }
      this.onChange(this);
    } finally {
      this._busy = false;
      if (this._queued && !this._stopped) {
        this._queued = false;
        this.sync(RESYNC_ROUNDS);
      }
    }
  }

  async _probe() {
    const wall0 = Date.now();
    const perf0 = performance.now();
    await setDoc(this.ref, { t: serverTimestamp() });
    const elapsed = performance.now() - perf0;

    // この読み取りは推定精度には影響しない(サーバー時刻は書き込み時点で確定済み)。
    // 未確定なら serverTimestamps:'none' の既定により null が返るため下で弾かれる。
    const snap = await getDoc(this.ref);
    const ts = snap.get("t");
    if (!ts || typeof ts.toMillis !== "function") {
      throw new Error("server timestamp is not resolved");
    }

    const accuracyMs = elapsed / 2;
    const offsetMs = ts.toMillis() - (wall0 + elapsed / 2);

    // 極端な標本は採用しない(通信の詰まり、時計の飛びなど)
    if (!Number.isFinite(offsetMs) || !Number.isFinite(accuracyMs)) return null;
    if (accuracyMs < 0 || accuracyMs > MAX_ACCURACY_MS) return null;
    if (Math.abs(offsetMs) > MAX_OFFSET_MS) return null;

    return { offsetMs, accuracyMs };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
