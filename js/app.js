// ─────────────────────────────────────────────────────────────
//  Okulab Time — 画面制御
// ─────────────────────────────────────────────────────────────

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";
import { ClockSync } from "./clock.js";
import { PASSAGES } from "./passages.js";
import {
  deriveRoomId, newSessionId, startSession, endSession, abortSession, deleteSession,
  subscribeSessions, subscribeCurrent, fetchCurrentFromServer, fetchAllSessions,
  collectDeletable, deleteSessions, isUncertain, SESSION_LIMIT,
} from "./store.js";

export const APP_VERSION = "v.02.1";

const STORAGE_KEY = "okulab-time/session";
const READ_KEY = "okulab-time/passages";   // ルームごとに既出の文章を覚えておく
const LATE_KEY = "okulab-time/late";       // 退出後に終わった操作の結果(再読み込みでも失わない)
const MAX_LATE_REPORTS = 20;               // 持ち越す知らせの上限
// 削除の件数は画面にしか残らない。再読み込みを促す文言より前に出す。
const RELOAD_WARNING = "【この件数は再読み込みすると消えます。先に控えてください。】";
const ROLE_LABEL = { start: "計測開始 担当", end: "計測終了 担当", view: "閲覧のみ" };
const PRESS_FRESH_MS = 15000;   // pointerdown で拾った時刻を有効とみなす猶予
const MAX_SEND_ATTEMPTS = 5;
const SEND_DEADLINE_MS = 20000; // 再送を打ち切るまでの上限
const MAX_RESUBSCRIBE = 8;      // 購読の張り直し回数の上限
const MISSING_GRACE_MS = 1500;  // 進行中の実体待ちを不整合と判断するまでの猶予
const GOOD_ACCURACY_MS = 250;   // 時刻補正がこれより粗い記録には注意を出す
const RECONCILE_EVERY_MS = 45000;  // 進行中フラグをサーバーと突き合わせる間隔
const RECONCILE_TIMEOUT_MS = 8000; // 突き合わせの打ち切り
const RESUBSCRIBE_GAP_MS = 10000;  // 購読を作り直す最小間隔
const MIN_PASSAGE_PX = 13.5;       // 読み物の文字サイズの下限(これ以下にはしない)
const CSV_LABEL = "CSV 書き出し";
const CLEAR_LABEL = "一括削除";

// 一時的な障害。押した時刻を保持したまま送り直す価値があるもの。
const RETRYABLE = new Set(["unavailable", "deadline-exceeded", "internal", "aborted", "cancelled"]);

const $ = (id) => document.getElementById(id);

const el = {
  screens: {
    config:  $("screen-config"),
    join:    $("screen-join"),
    loading: $("screen-loading"),
    main:    $("screen-main"),
    participant: $("screen-participant"),
  },
  configDetail:  $("config-detail"),
  loadingDetail: $("loading-detail"),
  joinForm:      $("join-form"),
  inputRoom:     $("input-room"),
  btnReveal:     $("btn-reveal"),
  btnJoin:       $("btn-join"),
  joinError:     $("join-error"),
  pillRole:      $("pill-role"),
  pillRoom:      $("pill-room"),
  pillClock:     $("pill-clock"),
  clockWarning:  $("clock-warning"),
  btnLeave:      $("btn-leave"),
  statusCard:    $("status-card"),
  statusLabel:   $("status-label"),
  statusTime:    $("status-time"),
  statusMeta:    $("status-meta"),
  connError:     $("conn-error"),
  panelStart:    $("panel-start"),
  panelEnd:      $("panel-end"),
  inputLabel:    $("input-label"),
  btnStart:      $("btn-start"),
  btnEnd:        $("btn-end"),
  startSub:      $("start-sub"),
  endSub:        $("end-sub"),
  actionError:   $("action-error"),
  btnDismissReport: $("btn-dismiss-report"),
  lateReport:        $("late-report"),
  lateReportMain:    $("late-report-main"),
  btnDismissLate:     $("btn-dismiss-late"),
  btnDismissLateMain: $("btn-dismiss-late-main"),
  recordCount:   $("record-count"),
  recordBody:    $("record-body"),
  recordEmpty:   $("record-empty"),
  recordNote:    $("record-note"),
  btnAbort:      $("btn-abort"),
  btnCsv:        $("btn-csv"),
  btnClear:      $("btn-clear"),
  btnParticipant: $("btn-participant"),
  screenParticipant: $("screen-participant"),
  btnDetect:     $("btn-detect"),
  btnExperimenter: $("btn-experimenter"),
  passageText:   $("passage-text"),
  version:       $("version"),
  toast:         $("toast"),
};

const state = {
  uid: null,
  roomId: null,
  role: null,
  sessions: [],
  activeId: null,        // meta/current が指す進行中セッション(これが正)
  sessionsLoaded: false,
  currentLoaded: false,
  busy: false,
  sending: false,
  abortHint: false,    // 状態のずれを検知し、中止での復旧を促している
  showMissing: false,  // 進行中フラグに対応する記録が読み込めていない
  participant: false,  // 被験者用画面を表示している
};

let db = null;
let auth = null;
let authPromise = null;
let clock = null;
let stopSessions = null;
let stopCurrent = null;
let ticker = null;
let toastTimer = null;
let missingTimer = null;
let roomEpoch = 0;                   // ルームを離れた送信・再接続を無効化するための世代
let reconcileTimer = null;
let reconcileEpoch = null;      // 実行中の突き合わせの世代(null なら実行していない)
let reconcileFailures = 0;
let suspectTimer = null;        // 購読どうしの食い違いを疑ってからの猶予
let lastResubscribe = 0;
let participantFailures = 0;    // 被験者用画面で記録できなかった操作の数
let recordsInFlight = 0;        // 走っている記録操作(書き出し・削除)の数
let recordsOwner = 0;           // その操作の通し番号(後始末の横取りを防ぐ)
const shownPassages = new Map();     // ルームごとの既出の文章(localStorage の代わりにもなる)
const connErrors = new Map();        // 購読ごとの接続エラー

// エラー欄は 2 段構え。削除の内訳は、件数が画面にしか残らないため、
// ほかの操作の知らせより優先して残す(操作を挟んだだけで消えない)。
let deleteReports = [];         // 未解決の削除結果({ kind, key, text })
let noticeText = "";            // その後ろに添える、ほかの操作からの知らせ
let noticeOwner = null;         // その知らせを出した操作
let noticeKey = null;           // その知らせが指している対象(記録の id など)
let lateReports = [];           // 退出したあとに終わった操作の結果({ text, important })

// ── 起動 ────────────────────────────────────────────────────

main();

function main() {
  el.version.textContent = APP_VERSION;

  window.addEventListener("unhandledrejection", (event) => {
    console.error("[okulab-time] 未処理のエラー:", event.reason);
  });

  if (!isConfigured(firebaseConfig)) {
    show("config");
    el.configDetail.textContent = "現在の projectId: " + (firebaseConfig.projectId || "(未設定)");
    return;
  }

  try {
    const fbApp = initializeApp(firebaseConfig);
    auth = getAuth(fbApp);
    db = getFirestore(fbApp);
  } catch (err) {
    show("config");
    el.configDetail.textContent = "初期化エラー: " + (err?.message ?? err);
    return;
  }

  signIn();
  bindEvents();
  loadLateReports();      // 前回の起動で伝えきれなかった結果を出し直す
  renderLateReports();
  restore();
}

function isConfigured(cfg) {
  const required = ["apiKey", "authDomain", "projectId", "appId"];
  return required.every((k) => typeof cfg[k] === "string" && cfg[k] && !cfg[k].startsWith("YOUR_"));
}

function signIn() {
  authPromise = signInAnonymously(auth);
  // 実際のエラーは await 側で扱う。ここでは未処理拒否の警告だけ抑える。
  authPromise.catch(() => {});
  return authPromise;
}

async function restore() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    saved = null;
  }

  if (!saved?.roomId || !ROLE_LABEL[saved.role]) {
    show("join");
    el.inputRoom.focus();
    return;
  }

  // 被験者用画面のまま再読み込みされた場合、接続中の案内も見せない
  const wasParticipant = saved.participant === true && saved.role === "end";
  if (wasParticipant) show("participant");
  else show("loading");

  const slow = setTimeout(() => {
    el.loadingDetail.textContent = "接続に時間がかかっています。通信状況を確認してください。";
  }, 4000);
  const authorized = await ensureAuth(el.joinError);
  clearTimeout(slow);
  el.loadingDetail.textContent = "Firebase に接続中";
  if (!authorized) return;
  enterRoom(saved.roomId, saved.role, wasParticipant);
}

/** 匿名認証の完了を待つ。失敗したら参加画面にエラーを出して false を返す。 */
async function ensureAuth(errorNode) {
  if (state.uid) return true;
  try {
    const cred = await authPromise;
    state.uid = cred.user.uid;
    return true;
  } catch (err) {
    show("join");
    showError(errorNode, describeError(err));
    signIn(); // 次回の参加操作に備えて張り直す
    return false;
  }
}

// ── イベント登録 ────────────────────────────────────────────

function bindEvents() {
  el.joinForm.addEventListener("submit", onJoin);
  el.btnReveal.addEventListener("click", toggleReveal);
  el.btnLeave.addEventListener("click", onLeave);
  el.btnCsv.addEventListener("click", exportCsv);
  el.btnClear.addEventListener("click", onClearAll);
  el.btnAbort.addEventListener("click", onAbort);
  el.recordBody.addEventListener("click", onRecordClick);
  // 消すのは押した意思のあるときだけ。欄そのものを押せるようにすると、
  // 大きな計測ボタンの隣で誤って触れ、確認ダイアログが次の押下を飲み込む。
  el.btnDismissReport.addEventListener("click", dismissActionError);
  el.btnDismissLate.addEventListener("click", dismissLateReports);
  el.btnDismissLateMain.addEventListener("click", dismissLateReports);

  el.btnParticipant.addEventListener("click", () => setParticipant(true));
  el.btnExperimenter.addEventListener("click", () => setParticipant(false));
  // 画面の回転や表示領域の変化で収まらなくなることがある。
  // iOS ではアドレスバーの伸縮でも発生するため、まとめて処理する。
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (!state.participant) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitPassage, 150);
  });

  bindPressButton(el.btnStart, onStart);
  bindPressButton(el.btnEnd, onEnd);
  bindPressButton(el.btnDetect, onDetect);
}

// ── 被験者用画面 ────────────────────────────────────────────
//
//  被験者は実験の内容を知らされていないため、この画面では
//  計測の状態(待機中か計測中か)を一切表に出さない。
//  ボタンは常に押せて、進行中の計測が無いときは黙って無視する。

function setParticipant(on) {
  state.participant = on && state.role === "end";
  saveSession();

  if (state.participant) {
    // 表示中の通知が被験者に見えないよう、切り替える前に消す
    clearTimeout(toastTimer);
    el.toast.hidden = true;
    el.toast.textContent = "";
  }

  showRoomScreen();

  // 文字サイズの調整は、画面が表示されてからでないと寸法を測れない
  if (state.participant) {
    if (el.passageText.textContent) fitPassage();
    else nextPassage();
  }
}

function saveSession() {
  if (!state.roomId || !state.role) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      roomId: state.roomId, role: state.role, participant: state.participant,
    }));
  } catch { /* プライベートブラウズなどでは保存できない */ }
}

function showRoomScreen() {
  show(state.participant ? "participant" : "main");
}

/**
 * 被験者用画面での失敗を実験者に伝える。
 * 被験者の画面には何も出せないため、実験者用画面に残る形で数だけ知らせる。
 */
function noteParticipantFailure(code) {
  participantFailures += 1;
  console.warn(`[okulab-time] 被験者用画面での操作を記録できませんでした(${code})`);
  setConnError(
    "participant",
    `被験者用画面での操作を ${participantFailures} 件記録できませんでした。` +
    "計測が開始されていなかった可能性があります。記録一覧を確認してください。"
  );
}

/**
 * そのルームで既に出した文章の番号。
 * localStorage が使えない環境(プライベートブラウズなど)でも
 * 重複防止が失われないよう、メモリ上の記録を正とする。
 */
function readShown(roomId) {
  if (shownPassages.has(roomId)) return shownPassages.get(roomId);

  let list = [];
  try {
    const all = JSON.parse(localStorage.getItem(READ_KEY) ?? "{}");
    if (all && typeof all === "object" && !Array.isArray(all) && Array.isArray(all[roomId])) {
      list = all[roomId].filter((n) => Number.isInteger(n));
    }
  } catch { /* 読めなければ空から始める */ }

  shownPassages.set(roomId, list);
  return list;
}

function writeShown(roomId, list) {
  shownPassages.set(roomId, list);
  try {
    const raw = JSON.parse(localStorage.getItem(READ_KEY) ?? "{}");
    const all = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    all[roomId] = list;
    localStorage.setItem(READ_KEY, JSON.stringify(all));
  } catch { /* 保存できなくてもメモリ上の記録で重複は防げる */ }
}

/**
 * 次の文章を選ぶ。
 * 同じルームでは繰り返さない。すべて出しきったら最初から選び直す。
 */
function nextPassage() {
  const roomId = state.roomId;
  if (!roomId) return;

  let shown = readShown(roomId);
  let remaining = PASSAGES.map((_, i) => i).filter((i) => !shown.includes(i));

  if (remaining.length === 0) {
    // 出しきったので選び直す。ただし、いま出ている文章は続けて出さない。
    // 押しても画面が変わらないと、それ自体が手がかりになってしまうため。
    const current = shown.at(-1);
    shown = Number.isInteger(current) ? [current] : [];
    remaining = PASSAGES.map((_, i) => i).filter((i) => i !== current);
    if (remaining.length === 0) remaining = PASSAGES.map((_, i) => i);
  }

  const index = remaining[Math.floor(Math.random() * remaining.length)];
  shown.push(index);
  writeShown(roomId, shown);

  el.passageText.textContent = PASSAGES[index];
  fitPassage();
  el.passageText.parentElement.scrollTop = 0;   // 新しい文章は先頭から
}

/**
 * 文章が枠に収まるよう文字を少しだけ小さくする。
 * 読みづらくなっては本末転倒なので下限を決めておき、
 * それでも収まらない分は枠の中でスクロールしてもらう。
 */
function fitPassage() {
  const box = el.passageText.parentElement;
  el.passageText.style.fontSize = "";               // いったん CSS の指定へ戻す
  let size = parseFloat(getComputedStyle(el.passageText).fontSize);
  if (!Number.isFinite(size)) return;

  for (let i = 0; i < 12 && size - 0.5 >= MIN_PASSAGE_PX; i++) {
    if (box.scrollHeight <= box.clientHeight) break;
    size -= 0.5;
    el.passageText.style.fontSize = size + "px";
  }
}

/**
 * 被験者用画面の「気づきを検出」
 *
 * 押したときの反応を、計測中かどうかで変えてはならない。
 * 変化の有無そのものが「いま計測が動いている」という手がかりになるため、
 * 成否にかかわらず、押した時点で必ず文章を切り替える。
 *
 * 送信も条件を付けずに行う。画面の状態がサーバーとずれている場合に
 * 押下を握りつぶすと、記録すべき「押した瞬間」を失うため。
 * 進行中の計測が無ければサーバー側が弾き、その結果は被験者には見えない。
 */
async function onDetect(press) {
  nextPassage();
  await onEnd(press);
}

/**
 * ボタンを押した「瞬間」の状態を pointerdown で切り出し、click で確定する。
 * click まで待つと指を離すまでの時間が誤差として乗るため。
 *
 * タッチ入力ではポインタが pointerup 直後に消滅し、仕様上かならず
 * pointerleave が発火する。そのため pointerleave での取り消しは
 * マウス操作(要素外へドラッグして離す)に限定する。
 */
function bindPressButton(button, handler) {
  let press = null;

  button.addEventListener(
    "pointerdown",
    (event) => {
      // 2 本目以降の指で押下時刻が上書きされないようにする
      if (!event.isPrimary) return;
      // disabled のボタンにはそもそもイベントが届かないため、
      // ここに来た時点で押せる状態にある
      press = clock ? clock.snapshot() : null;
    },
    { passive: true }
  );

  button.addEventListener("pointercancel", () => { press = null; }, { passive: true });
  button.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") press = null;
  }, { passive: true });

  button.addEventListener("click", () => {
    // 鮮度の判定には、OS の時刻補正で飛ばない performance.now() を使う
    const fresh = press && performance.now() - press.perfAt < PRESS_FRESH_MS;
    // キーボード操作など pointerdown を伴わない経路ではここで取り直す
    const snapshot = fresh ? press : (clock ? clock.snapshot() : null);
    press = null;
    if (!snapshot) return;
    handler(snapshot);
  });
}

function toggleReveal() {
  const revealed = el.inputRoom.type === "text";
  el.inputRoom.type = revealed ? "password" : "text";
  el.btnReveal.textContent = revealed ? "表示" : "隠す";
  el.btnReveal.setAttribute("aria-pressed", String(!revealed));
}

// ── 参加 / 退出 ─────────────────────────────────────────────

async function onJoin(event) {
  event.preventDefault();
  hideError(el.joinError);

  const passphrase = el.inputRoom.value.trim();
  const role = el.joinForm.querySelector('input[name="role"]:checked')?.value;

  if (!passphrase) return showError(el.joinError, "合言葉を入力してください。");
  if (!role) return showError(el.joinError, "この端末の役割を選んでください。");

  // 合言葉の変換は通信を伴わないので、認証より先に済ませる
  let roomId;
  try {
    roomId = await deriveRoomId(passphrase);
  } catch (err) {
    return showError(el.joinError, describeError(err));
  }

  el.btnJoin.disabled = true;
  el.btnJoin.textContent = "接続中…";
  try {
    if (!(await ensureAuth(el.joinError))) return;
    el.inputRoom.value = "";
    if (el.inputRoom.type === "text") toggleReveal();
    enterRoom(roomId, role);
  } finally {
    el.btnJoin.disabled = false;
    el.btnJoin.textContent = "この端末を参加させる";
  }
}

function enterRoom(roomId, role, participant = false) {
  teardownRoom();   // 二重購読を防ぐ

  state.roomId = roomId;
  state.role = role;
  state.sessions = [];
  state.activeId = null;
  state.sessionsLoaded = false;
  state.currentLoaded = false;
  state.abortHint = false;
  state.showMissing = false;

  state.participant = participant && role === "end";
  saveSession();

  el.pillRole.textContent = ROLE_LABEL[role];
  el.pillRoom.textContent = "room " + roomId.slice(0, 6);
  el.panelStart.hidden = role !== "start";
  el.panelEnd.hidden = role !== "end";
  el.btnParticipant.hidden = role !== "end";   // 被験者用画面は終了側の端末だけ
  el.btnClear.hidden = role === "view";        // 削除は 1 件ずつの操作と同じ扱い
  resetRecordsLabels();                        // 前のルームの途中経過を持ち越さない
  syncRecordsButtons();                        // 走っている操作があれば止めたままにする
  recordsOwner += 1;                           // 前のルームの後始末に触らせない
  el.passageText.textContent = "";
  participantFailures = 0;
  clearActionError();
  render();
  showRoomScreen();
  if (state.participant) nextPassage();   // 画面を出してから寸法を測る

  clock = new ClockSync(db, ["rooms", roomId, "clock", state.uid]);
  clock.onChange = () => { renderClock(); renderControls(); };
  renderClock();
  clock.start();

  attachSubscriptions(roomId);
  startWatchdog();
}

/**
 * @param {"all"|"current"|"sessions"} scope 作り直す購読の範囲。
 *   記録一覧の購読は張り直すたびに最大 300 件を読み直すため、
 *   疑わしい側だけを作り直して読み取りの無駄を抑える。
 */
function attachSubscriptions(roomId, scope = "all") {
  const sessions = scope === "all" || scope === "sessions";
  const current = scope === "all" || scope === "current";

  if (sessions && stopSessions) { stopSessions(); stopSessions = null; }
  if (current && stopCurrent) { stopCurrent(); stopCurrent = null; }

  if (sessions) stopSessions = watch(
    (onData, onError) => subscribeSessions(db, roomId, onData, onError),
    onSessions,
    "sessions"
  );
  if (current) stopCurrent = watch(
    (onData, onError) => subscribeCurrent(db, roomId, onData, onError),
    applyCurrent,
    "current"
  );
}

/** 購読を作り直す(短時間に繰り返さないよう間隔を空ける) */
function resubscribe(scope) {
  if (!state.roomId) return;
  const now = Date.now();
  if (now - lastResubscribe < RESUBSCRIBE_GAP_MS) return;
  lastResubscribe = now;
  attachSubscriptions(state.roomId, scope);
}

/**
 * 接続エラーは操作エラーとは別枠で表示する。
 * 同じ場所に出すと、他方の購読の復帰や次の操作で消えてしまい、
 * 原因が分からないまま操作不能になることがある。
 */
function setConnError(key, message) {
  if (message) connErrors.set(key, message);
  else connErrors.delete(key);

  const messages = [...new Set(connErrors.values())];
  el.connError.textContent = messages.join(" ");
  el.connError.hidden = messages.length === 0;
}

// ── 購読の生存監視 ──────────────────────────────────────────
//
//  onSnapshot は、接続が切れてもエラーを返さないまま更新が止まることがある
//  (画面ロックやアプリ切替でページが凍結された後に起こる)。
//  エラー時の再接続だけでは復旧できないため、進行中フラグを定期的に
//  サーバーへ直接問い合わせ、食い違っていれば購読ごと張り直す。

const onResume = () => reconcile("復帰");
const onVisible = () => { if (document.visibilityState === "visible") reconcile("復帰"); };

function startWatchdog() {
  stopWatchdog();
  reconcileTimer = setInterval(() => {
    if (document.visibilityState === "visible") reconcile("定期");
  }, RECONCILE_EVERY_MS);

  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pageshow", onResume);
  window.addEventListener("focus", onResume);
  window.addEventListener("online", onResume);
}

function stopWatchdog() {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  reconcileFailures = 0;
  clearSuspect();
  // 実行中の突き合わせは世代で無効化されるため、ここでは触らない

  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("pageshow", onResume);
  window.removeEventListener("focus", onResume);
  window.removeEventListener("online", onResume);
}

/** サーバーの進行中フラグと画面の状態を突き合わせ、ずれていれば直す */
async function reconcile(reason) {
  if (!db || !state.roomId || reconcileEpoch !== null) return;

  const epoch = roomEpoch;
  const roomId = state.roomId;
  reconcileEpoch = epoch;

  try {
    const serverId = await withTimeout(fetchCurrentFromServer(db, roomId), RECONCILE_TIMEOUT_MS);
    if (epoch !== roomEpoch) return;

    reconcileFailures = 0;
    setConnError("stale", null);

    if (serverId !== state.activeId) {
      // 購読が取りこぼしていた。状態を直したうえで、その購読だけ作り直す。
      console.warn(
        `[okulab-time] 進行中フラグの取りこぼしを検出(${reason}): サーバー=${serverId} 画面=${state.activeId}`
      );
      applyCurrent(serverId);
      resubscribe("current");
    }
  } catch {
    if (epoch !== roomEpoch) return;
    reconcileFailures += 1;
    // 一時的な失敗で警告を出すと煩いので、続けて失敗したときだけ知らせる
    if (reconcileFailures >= 2) {
      setConnError(
        "stale",
        "サーバーと同期できていません。画面の表示が実際の状態と異なっている可能性があります。通信状況を確認してください。"
      );
    }
  } finally {
    // 別の世代が動き出していれば、その解除は相手に任せる
    if (reconcileEpoch === epoch) reconcileEpoch = null;
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); }),
  ]);
}

/**
 * 購読が切れたら指数バックオフで張り直す。
 * 張り直しても結果が変わらない障害(設定漏れ・権限・枠超過)では原因を表示して止める。
 */
function watch(subscribe, onData, key) {
  let stopped = false;
  let unsubscribe = null;
  let timer = null;
  let delay = 1000;
  let attempts = 0;

  const attach = () => {
    if (stopped) return;
    unsubscribe = subscribe(
      (data) => {
        if (stopped) return;   // 解除直後に届いたスナップショットを反映しない
        delay = 1000;
        attempts = 0;
        setConnError(key, null);
        onData(data);
      },
      (err) => {
        unsubscribe = null;
        if (stopped) return;

        if (!RETRYABLE.has(err?.code)) {
          setConnError(key, describeError(err));
          return;
        }
        if (attempts >= MAX_RESUBSCRIBE) {
          setConnError(key,
            "再接続を繰り返しましたが復旧しませんでした。通信状況を確認して、ページを再読み込みしてください。");
          return;
        }
        attempts += 1;
        setConnError(key, `サーバーとの接続が切れました。再接続しています…(${attempts})`);
        timer = setTimeout(attach, delay);
        delay = Math.min(delay * 2, 15000);
      }
    );
  };

  attach();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (unsubscribe) unsubscribe();
    setConnError(key, null);
  };
}

function onLeave() {
  // 何が中断され、何が最後まで走るのかを取り違えさせない
  const notes = [];
  if (state.busy) {
    notes.push("計測の送信は取りやめます(すでにサーバーに届いていた場合は記録として残ります)");
  }
  if (recordsInFlight > 0) {
    notes.push("記録の書き出し・削除は最後まで行い、結果はその場でお知らせします");
  }

  const warning = notes.length > 0
    ? "処理中の操作があります。このまま退出しますか?\n" +
      notes.map((n) => `・${n}`).join("\n")
    : "このルームから退出します。よろしいですか?";

  // 未解決の削除の件数は持ち越すが、添えられた知らせは消える。
  // どちらも、決める前にその場で見せる。
  const report = deleteReportText();
  const shown = [
    report ? `${report}\n― この内容は持ち越します ―` : "",
    noticeText ? `${noticeText}\n― この内容は退出すると消えます ―` : "",
  ].filter(Boolean).join("\n\n");
  const message = shown ? `${shown}\n\n${warning}` : warning;

  if (!confirm(message)) return;
  leaveRoom();
}

/** ルームに紐づく購読・タイマー・送信中の操作をすべて無効化する */
function teardownRoom() {
  roomEpoch += 1;   // 実行中の再送があっても、その結果を反映させない
  stopWatchdog();
  if (stopSessions) { stopSessions(); stopSessions = null; }
  if (stopCurrent) { stopCurrent(); stopCurrent = null; }
  if (clock) { clock.stop(); clock = null; }
  stopTicker();
  clearMissingTimer();
  connErrors.clear();
  el.connError.textContent = "";
  el.connError.hidden = true;
}

function leaveRoom() {
  // 退出でエラー欄は消える。未解決の件数はここにしか残らないので、
  // 持ち越す知らせへ移してから消す(そちらは保存され、参加画面にも出る)。
  // 1 件ずつ積むと上限を食いつぶすため、まとめて 1 つにする。
  if (deleteReports.length > 0) {
    reportLate("退出したルームについて。" + deleteReportText(), state.roomId, 2);
  }

  teardownRoom();
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }

  state.roomId = null;
  state.role = null;
  state.sessions = [];
  state.activeId = null;
  state.sessionsLoaded = false;
  state.currentLoaded = false;
  state.busy = false;
  state.sending = false;
  state.abortHint = false;
  state.showMissing = false;
  state.participant = false;
  el.passageText.textContent = "";

  render();               // 前のルームの記録を画面に残さない
  clearActionError();
  el.clockWarning.hidden = true;
  show("join");
  el.inputRoom.focus();
}

// ── データ受信 ──────────────────────────────────────────────

function onSessions(list) {
  state.sessions = list;
  state.sessionsLoaded = true;
  render();
  checkAgreement();
}

/**
 * 進行中フラグを反映する。
 * 購読からの通知のほか、トランザクションの結果からも直接呼ぶ。
 * トランザクションの書き込みはローカルに先行反映されないため、
 * 操作した本人の画面も、これを呼ばないと購読の到着まで変わらない。
 */
function applyCurrent(activeId) {
  if (activeId !== state.activeId) {
    state.abortHint = false;
    state.showMissing = false;
    clearMissingTimer();
    clearSuspect();
  }
  state.activeId = activeId;
  state.currentLoaded = true;
  render();
  checkAgreement();
}

/**
 * 記録側と進行中フラグ側の食い違いを監視する。
 *
 * 2 つの購読は独立していて到着順が保証されないため、
 * 計測のたびに一瞬食い違うのは正常。すぐ異常と決めつけると、
 * 正常時にも購読の作り直しが走ってしまう。
 * 猶予を置いても解消しない場合にだけ、購読を疑って突き合わせる。
 */
function checkAgreement() {
  const disagrees = state.activeId
    ? state.sessions.some((s) => s.id === state.activeId && s.status !== "running")
    : state.sessions.some((s) => s.status === "running");

  if (!disagrees) { clearSuspect(); return; }
  if (suspectTimer) return;

  suspectTimer = setTimeout(() => {
    suspectTimer = null;
    reconcile("記録側との食い違い");
  }, MISSING_GRACE_MS);
}

function clearSuspect() {
  if (suspectTimer) clearTimeout(suspectTimer);
  suspectTimer = null;
}

/**
 * 2 つの購読は独立しているため、進行中フラグが記録本体より先に届くことがある。
 * すぐ不整合と決めつけず、猶予を置いてから警告する。
 */
function scheduleMissingCheck() {
  if (missingTimer || state.showMissing) return;
  missingTimer = setTimeout(() => {
    missingTimer = null;
    // 進行中を指しているのに記録そのものが猶予を超えて届かない
    if (state.activeId && !state.sessions.some((s) => s.id === state.activeId)) {
      state.showMissing = true;
      render();
      resubscribe("sessions");   // 記録側の購読を疑う
    }
  }, MISSING_GRACE_MS);
}

function clearMissingTimer() {
  if (missingTimer) clearTimeout(missingTimer);
  missingTimer = null;
}

/**
 * 進行中セッションの本体。
 * 一覧の件数上限から漏れている場合や、実体が既に終了している場合は null。
 * 終了済みの記録で経過時間を数え続けないようにするための判定でもある。
 */
function activeSession() {
  if (!state.activeId) return null;
  const session = state.sessions.find((s) => s.id === state.activeId) ?? null;
  return session && session.status === "running" ? session : null;
}

function render() {
  renderStatus();
  renderControls();
  renderRecords();
}

function renderStatus() {
  const running = Boolean(state.activeId);
  const active = activeSession();
  el.statusCard.dataset.state = running ? "running" : "idle";

  if (!running) {
    stopTicker();
    el.statusLabel.textContent = "待機中";
    el.statusTime.textContent = "--:--.---";
    const last = state.sessions.find((s) => s.status === "done");
    el.statusMeta.textContent = last
      ? `直近の記録: ${formatSeconds(last.durationMs)} 秒${last.label ? `(${last.label})` : ""}`
      : "計測は開始されていません";
    return;
  }

  el.statusLabel.textContent = "計測中";
  if (!active) {
    stopTicker();
    el.statusTime.textContent = "--:--.---";

    // 記録は届いているが既に終了している = フラグ側の反映待ち。
    // 正常な終了直後にも起こるため、異常として扱わない。
    const settled = state.sessions.find((s) => s.id === state.activeId);
    if (settled) {
      el.statusMeta.textContent = "終了を反映しています…";
      return;
    }

    // 記録そのものが届いていない
    if (state.showMissing) {
      el.statusMeta.textContent = "進行中の記録を読み込めません。「計測を中止」で状態を戻せます。";
    } else {
      el.statusMeta.textContent = "記録を読み込んでいます…";
      scheduleMissingCheck();
    }
    return;
  }

  clearMissingTimer();
  state.showMissing = false;
  el.statusMeta.textContent =
    `${formatClock(active.startMs)} 開始` + (active.label ? ` — ${active.label}` : "");
  startTicker();
}

function startTicker() {
  if (ticker) return;
  const update = () => {
    const active = activeSession();
    if (!active || !clock) return;
    el.statusTime.textContent = formatDuration(clock.now() - active.startMs);
  };
  update();
  ticker = setInterval(update, 47);
}

function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

function renderControls() {
  syncRecordsButtons();   // 計測中は一括削除も押せない。見た目を合わせる
  const ready = state.currentLoaded;
  const running = Boolean(state.activeId);
  const synced = Boolean(clock?.ok);

  // 表示が実際の状態と食い違っていても操作不能にならないよう、
  // 可否の最終判断はサーバーのトランザクションに委ねる。
  // 押せないようにすると、その間の「押した瞬間」が失われてしまう。
  el.btnStart.disabled = !ready || state.busy;
  el.btnEnd.disabled = !ready || state.busy;
  // 想定外の操作は見た目で抑制する(押すことはできる)
  el.btnStart.classList.toggle("bigbtn--unexpected", ready && running);
  el.btnEnd.classList.toggle("bigbtn--unexpected", ready && !running);
  // 状態がずれているときは、進行中フラグが読めていなくても復旧できるように出す
  el.btnAbort.hidden = (!running && !state.abortHint) || state.role === "view";
  // 送信中の中止は、確定寸前の押下時刻を捨ててしまうので受け付けない
  el.btnAbort.disabled = state.busy;

  el.startSub.textContent = subText(running ? "計測中です" : null, synced, ready);
  el.endSub.textContent = subText(running ? null : "開始待ちです", synced, ready);
}

function subText(blocked, synced, ready) {
  if (state.sending) return "送信中…(押した時刻は保持しています)";
  if (!ready) return "接続中…";
  if (blocked) return blocked;
  if (!synced) return "時刻同期がまだです(押すと確認します)";
  return "タップした瞬間を記録します";
}

function renderClock() {
  if (!clock) {
    el.pillClock.textContent = "同期待ち";
    el.pillClock.classList.remove("pill--bad");
    el.clockWarning.hidden = true;
    return;
  }

  const quality = clock.quality;
  const acc = clock.accuracyMs;
  const label = {
    good:    () => `同期 ±${Math.round(acc)}ms`,
    rough:   () => `同期 ±${(acc / 1000).toFixed(1)}s`,
    stale:   () => "同期(古い)",
    failed:  () => "同期失敗",
    pending: () => "同期中…",
  }[quality]();

  el.pillClock.textContent = label;
  el.pillClock.classList.toggle("pill--bad", quality === "failed");

  // title はタッチ端末では読めないので、警告は本文に出す
  if (quality === "failed") {
    el.clockWarning.textContent =
      "サーバー時刻と同期できていません。このまま計測すると、端末の時計の値がそのまま記録され、" +
      "2 台の時計のズレが誤差として残ります。通信状態を確認してください。";
    el.clockWarning.hidden = false;
  } else if (quality === "stale") {
    el.clockWarning.textContent =
      "時刻同期が古くなっています。通信が回復すると自動的に取り直します。";
    el.clockWarning.hidden = false;
  } else {
    el.clockWarning.hidden = true;
  }
}

function renderRecords() {
  const rows = state.sessions;
  el.recordCount.textContent = rows.length >= SESSION_LIMIT ? `${SESSION_LIMIT}+` : String(rows.length);
  el.recordEmpty.hidden = rows.length > 0 || !state.sessionsLoaded;
  el.recordNote.hidden = rows.length < SESSION_LIMIT;
  el.recordBody.replaceChildren();

  for (const s of rows) {
    const tr = document.createElement("tr");
    if (s.status === "running") tr.className = "row-running";
    if (s.status === "aborted") tr.className = "row-aborted";

    tr.append(
      cell(s.label || "—", "label-cell", s.label || ""),
      cell(formatClock(s.startMs), "mono", formatFull(s.startMs)),
      cell(s.status === "running" ? "—" : formatClock(s.endMs), "mono",
           typeof s.endMs === "number" ? formatFull(s.endMs) : ""),
      durationCell(s)
    );

    const td = document.createElement("td");
    if (s.status !== "running" && state.role !== "view") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "del";
      button.dataset.id = s.id;
      button.title = "この記録を削除";
      button.setAttribute("aria-label", "この記録を削除");
      button.textContent = "×";
      button.disabled = recordsInFlight > 0;
      td.append(button);
    }
    tr.append(td);
    el.recordBody.append(tr);
  }
}

function cell(text, className = "", title = "") {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  if (title) td.title = title;
  return td;
}

function durationCell(s) {
  if (s.status === "running") return cell("計測中", "num");
  if (s.status === "aborted") return cell("中止", "num");

  const td = cell(formatSeconds(s.durationMs), "num");
  if (typeof s.durationMs === "number" && s.durationMs < 0) {
    td.classList.add("bad");
    td.title = "終了時刻が開始時刻より前になっています。端末の時計を確認してください。";
    return td;
  }

  const worst = worstAccuracy(s);
  if (s.startSynced === false || s.endSynced === false) {
    td.classList.add("warn");
    td.title = "時刻同期が完了していない状態で記録されました(端末時計のままの値です)。";
  } else if (worst !== null && worst > GOOD_ACCURACY_MS) {
    td.classList.add("warn");
    td.title = `時刻補正の推定誤差が大きい状態で記録されました(±${Math.round(worst)}ms)。`;
  }
  return td;
}

/** 開始側・終了側のうち精度が悪いほうの推定誤差 */
function worstAccuracy(s) {
  const values = [s.startAccuracyMs, s.endAccuracyMs]
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  return values.length ? Math.max(...values) : null;
}

// ── 操作 ────────────────────────────────────────────────────

async function onStart(press) {
  if (state.busy || !state.roomId) return;
  if (!press.synced && !confirmUnsynced()) return;

  // 送信先は操作した時点のルームに固定する(再送中に退出・再参加されても移らない)
  const room = state.roomId;
  const epoch = roomEpoch;
  // 再送しても同じ記録になるよう、ID は送信前に 1 回だけ決める
  const sessionId = newSessionId(db, room);
  const payload = {
    ...press,
    label: el.inputLabel.value.trim().slice(0, 80),
    uid: state.uid,
  };

  await withBusy(async () => {
    const result = await send(
      () => startSession(db, room, payload, sessionId),
      () => epoch !== roomEpoch
    );
    // 既に別のルームにいる。画面は触らないが、結果は伝える
    if (epoch !== roomEpoch) return reportLateResult("計測開始", result, room);
    if (!result.ok) return handleCode(result.code);

    if (result.duplicate && result.status && result.status !== "running") {
      toast("この計測は既に終了しています(再送を確認)");
      reconcile("送信後の確認");
    } else {
      // トランザクションの結果は権威ある情報。購読の到着を待たずに反映する
      applyCurrent(sessionId);
      toast(result.duplicate ? "計測を開始しました(再送を確認)" : "計測を開始しました");
    }
  }, epoch);
}

async function onEnd(press) {
  if (state.busy || !state.roomId) return;
  // 被験者に確認ダイアログを見せない(未補正の記録は保存側の印で判別できる)
  if (!press.synced && !state.participant && !confirmUnsynced()) return;

  const room = state.roomId;
  const epoch = roomEpoch;
  const expectedId = state.activeId;
  const payload = { ...press, uid: state.uid };

  await withBusy(async () => {
    const result = await send(
      () => endSession(db, room, payload, expectedId),
      () => epoch !== roomEpoch
    );
    if (epoch !== roomEpoch) return reportLateResult("計測終了", result, room);
    if (result.ok) {
      applyCurrent(null);   // 購読の到着を待たずに待機中へ戻す
      toast(`計測終了 — ${formatSeconds(result.durationMs)} 秒` + (result.duplicate ? "(再送を確認)" : ""));
    } else if (state.participant) {
      // 被験者には見せられないので、実験者用画面に残る形で知らせる
      noteParticipantFailure(result.code);
    } else {
      handleCode(result.code);
    }
  }, epoch);
}

function confirmUnsynced() {
  return confirm(
    "サーバー時刻との同期がまだ完了していません。\n" +
    "このまま記録すると、2 台の端末の時計のズレが誤差として残ります。\n\n" +
    "端末の時計のまま記録しますか?"
  );
}

async function onAbort() {
  if (state.busy || !state.roomId) return;

  const room = state.roomId;
  const epoch = roomEpoch;
  const uid = state.uid;
  const expectedId = state.activeId;

  const message = expectedId
    ? "進行中の計測を中止します。よろしいですか?"
    : "サーバー側で進行中になっている計測を中止します。よろしいですか?";
  if (!confirm(message)) return;

  await withBusy(async () => {
    const result = await send(
      () => abortSession(db, room, { uid, expectedId }),
      () => epoch !== roomEpoch
    );
    if (epoch !== roomEpoch) return reportLateResult("計測の中止", result, room);
    state.abortHint = false;
    if (result.ok) {
      applyCurrent(null);
      toast("計測を中止しました");
    } else {
      notice(describeCode(result.code), "action");
    }
  }, epoch);
}

async function onRecordClick(event) {
  const button = event.target.closest("button.del");
  if (!button) return;
  const id = button.dataset.id;
  // 一括削除・書き出しと重ねない。重ねると、まとめ送りが数える件数と
  // 実際に消えた件数が食い違う。
  if (recordsInFlight > 0 || !state.roomId) return;
  if (!confirm("この記録を削除します。よろしいですか?")) return;

  // 送信中に退出されても、別のルームの記録を消したり
  // 別のルームの画面に書き込んだりしない
  const room = state.roomId;
  const epoch = roomEpoch;
  // どの記録だったかは、消えたあとでは分からなくなる。先に控える。
  const target = state.sessions.find((s2) => s2.id === id);
  const handle = target ? `${formatClock(target.startMs)} 開始の記録` : "この記録";
  // 記録操作として数える。数えないと、この削除の最中に書き出しや一括削除を
  // 始められてしまい、退出の警告にも出ない(取り消せない操作なのに)。
  const token = startRecordsWork();

  try {
    await deleteSession(db, room, id);
    if (epoch !== roomEpoch) return reportLate("退出したルームの記録を 1 件削除しました。", room);
    // 前に「消えたか分からない」と伝えた記録なら、確かに消えたので取り下げる
    resolveDeleteReport("row", id);
    clearNotice("row", id);
    toast("記録を削除しました");
  } catch (err) {
    // 消えたかどうか分からない場合に「削除できませんでした」と言い切ると、
    // 残っていない記録を残っていることにしてしまう(まとめ削除の
    // pending と同じ判断を 1 件削除でも使う)。
    const uncertain = isUncertain(err);
    const text = uncertain
      ? `${handle}は、削除できたかどうか確認できませんでした` +
        `(あとから削除される場合があります)。${reasonForReport(err)}` +
        "記録一覧で結果を確かめてください。"
      : `${handle}を削除できませんでした。${reasonBesideReport(err)}`;

    // 退出後はエラー欄が別のルームのものになる。黙って終わらせない。
    if (epoch !== roomEpoch) return reportLate("退出したルームについて。" + text, room, uncertain ? 2 : 1);

    // 結果不明を伝える文言は、計測操作では消さない
    if (uncertain) keepDeleteReport("row", text, id);
    else notice(text, "row", id);
  } finally {
    finishRecordsWork(token);
  }
}

/**
 * 一時的な通信障害では押した時刻を保持したまま送り直す。
 * 押し直しを強いると「押した瞬間」が失われるため。
 */
async function send(operation, cancelled = () => false) {
  const deadline = Date.now() + SEND_DEADLINE_MS;
  let delay = 400;
  // state.sending を戻すのは withBusy の役目(世代が変わっていたら触らないため)
  for (let attempt = 1; ; attempt++) {
    // 取り消しでも「一度も送っていない」と「送ったが結果を確認できていない」は
    // 意味がまったく違う。後者は、サーバー側で成立している可能性が残る。
    if (cancelled()) return { ok: false, code: "CANCELLED", sent: attempt > 1 };
    try {
      return await operation();
    } catch (err) {
      if (cancelled()) return { ok: false, code: "CANCELLED", sent: true };
      const givingUp =
        !RETRYABLE.has(err?.code) ||
        attempt >= MAX_SEND_ATTEMPTS ||
        Date.now() + delay > deadline;
      if (givingUp) throw err;
      state.sending = true;
      renderControls();
      await sleep(delay);
      delay = Math.min(delay * 2, 4000);
    }
  }
}

function handleCode(code) {
  notice(describeCode(code), "action");
  if (code === "ALREADY_RUNNING" && state.role !== "view") {
    // 進行中フラグが読めていなくても中止で復旧できるようにする
    state.abortHint = true;
  }
}

/**
 * @param {number} epoch 操作を始めた時点のルーム世代。
 *   退出後に古い送信が終わっても、新しいルームの状態を触らないようにする。
 */
async function withBusy(fn, epoch = roomEpoch) {
  state.busy = true;
  renderControls();
  // 削除の内訳は消さない。計測操作を挟んだだけで、確かめるべき件数が
  // 失われることになる。それ以外の知らせは、ここで片付けてよい。
  clearNotice();
  try {
    await fn();
  } catch (err) {
    if (epoch === roomEpoch) notice(describeError(err), "action");
  } finally {
    if (epoch === roomEpoch) {
      state.busy = false;
      state.sending = false;
      renderControls();
    }
  }
}

// ── 記録の書き出しと一括削除 ────────────────────────────────
//
//  どちらも全件をサーバーから読むため、同時に走らせてはならない。
//  削除中に書き出すと、消えた分が抜けた CSV が「成功」として出てしまう。

/**
 * 記録操作(書き出し・一括削除)を始め、後始末の権利を受け取る。
 *
 * 後始末に世代ガードをかけてはならない(9-01)。退出すると復帰処理ごと
 * 飛ばされ、ボタンが固まる。かわりに所有権で判断し、あとから終わった
 * 古い操作が、いま動いている操作の状態を戻さないようにする。
 */
function startRecordsWork() {
  recordsInFlight += 1;
  syncRecordsButtons();
  return ++recordsOwner;
}

/** 後始末する。すでに次の操作が始まっていれば、その操作に任せる。 */
function finishRecordsWork(token) {
  recordsInFlight = Math.max(recordsInFlight - 1, 0);
  if (recordsInFlight === 0) resetRecordsLabels();
  syncRecordsButtons();

  if (recordsOwner !== token) return;   // すでに次の操作が状態を握っている
  renderControls();
}

/**
 * 記録操作のボタンを、走っている操作の数から組み立てる。
 *
 * 表示だけを戻すと、押しても何も起きないボタンになる。逆に走っている
 * 操作を無視して押せるようにすると、全件を読む操作が重なり、
 * 欠けた CSV が「成功」として出る(9-02)。
 */
function syncRecordsButtons() {
  const working = recordsInFlight > 0;
  // 見た目と、押したときの判定を必ず一致させる。押せるのに何も起きない
  // ボタンは、操作の取りこぼしと区別がつかない。
  el.btnCsv.disabled = working;
  el.btnClear.disabled = working || state.busy;
  // 行ごとの削除も止める(再描画のたびに作り直されるため、ここでも当てる)
  for (const button of el.recordBody.querySelectorAll("button.del")) button.disabled = working;
}

/**
 * ボタンの表示を既定に戻す。
 * 走っている操作の途中経過を持ち越すと、入り直したルームで
 * 「削除中… 12/300」が残り、そのルームで何かが動いているように見える。
 */
function resetRecordsLabels() {
  el.btnCsv.textContent = CSV_LABEL;
  el.btnClear.textContent = CLEAR_LABEL;
}

/**
 * そのルームの記録をすべて消す。**元に戻せない。**
 * 研究データを失う操作なので、実際の件数を示したうえで確認を二段階にしている。
 */
async function onClearAll() {
  // 入室でボタンの表示は戻るが、前のルームの操作がまだ走っていることがある。
  // 全件を読む操作どうしを重ねると、欠けた CSV が「成功」として出る(9-02)。
  if (recordsInFlight > 0 || state.busy || !state.roomId) return;

  const room = state.roomId;
  const epoch = roomEpoch;

  const token = startRecordsWork();
  el.btnClear.textContent = "確認中…";
  // 計測操作は止めない(state.busy を立てない)。一括削除は数え上げと
  // 確定で 30 秒を超えることがあり、その間に被験者が終了を押すと、
  // 押した瞬間そのものが失われる。削除の対象は開始前に数え終えている
  // ため、計測と重なっても影響しない。
  renderControls();

  let total = 0;                     // 失敗時の内訳を出すため catch からも見る
  let skipped = 0;                   // 進行中のため対象外にした件数
  let started = false;               // 1 件でも削除を送ったか

  try {
    // 一覧の購読は上限があり、止まっていることもある。
    // 同意を得る件数は、必ずサーバーの実数にする。
    const counted = await collectDeletable(db, room);
    const refs = counted.refs;
    total = refs.length;
    skipped = counted.skipped;
    if (epoch !== roomEpoch) return;

    if (refs.length === 0) {
      // 消えたか分からなかった記録も、もう残っていないことが確かめられた
      clearDeleteReport();
      clearNotice("clear");
      toast(skipped > 0 ? "進行中の計測しかありません" : "削除する記録がありません");
      return;
    }

    if (!confirm(
      `このルームの記録 ${refs.length} 件をすべて削除します。\n` +
      "削除した記録は元に戻せません。\n\n" +
      "必要な記録は、先に CSV 書き出しで保存してください。\n\n" +
      "続けますか?"
    )) return;

    const typed = prompt("確認のため「削除」と入力してください。");
    if (typed === null) {
      // 入力欄が出ない環境では、この経路でしか止まらない
      return toast("確認できなかったため削除しませんでした");
    }
    if (typed.trim() !== "削除") return toast("削除を取り消しました");

    el.btnClear.textContent = `削除中… 0/${refs.length}`;
    started = true;
    const deleted = await deleteSessions(db, refs, (done, all) => {
      if (epoch === roomEpoch) el.btnClear.textContent = `削除中… ${done}/${all}`;
    });

    const note = skipped > 0 ? `(進行中の ${skipped} 件は残しました)` : "";
    if (epoch !== roomEpoch) {
      // 退出後に終わった。取り消せない操作を黙って終わらせない
      return reportLate(`退出したルームの記録 ${deleted} 件を削除しました${note}`, room);
    }

    // ここまで来れば前回の内訳は解決済み。古い件数も、前回の知らせも残さない
    clearDeleteReport();
    clearNotice("clear");
    clearNotice("row");
    toast(`${deleted} 件を削除しました${note}`);
  } catch (err) {
    // 対象を数える段階での失敗。まだ何も送っていないので、
    // 「中断した」と伝えると消えたかどうかを疑わせてしまう。
    if (!started) {
      const text = "削除する記録を数えられませんでした。" + reasonBesideReport(err);
      if (epoch === roomEpoch) notice(text, "clear");
      else reportLate("退出したルームについて。" + text, room);   // 黙って終わらせない
      return;
    }

    // 対象の全件を、確定・結果不明・未着手に分けて必ず伝える。
    // どれか 1 つでも欠けると、残っている記録を見落とすことになる。
    const count = (v) => (typeof v === "number" && v > 0 ? v : 0);
    const deleted = count(err?.deleted);
    const pending = count(err?.pending);      // 送ったが結果を確認できなかった分
    const untouched = Math.max(total - deleted - pending, 0);

    const done = deleted > 0
      ? `${deleted} 件を削除したところで中断しました。`
      : "削除を中断しました。";
    // 打ち切った分は「消えたとも残ったとも言えない」。
    // 消えた前提で扱うと、残っている記録を見落とす。
    const unknown = pending > 0
      ? `次の ${pending} 件は、削除できたかどうか確認できませんでした` +
        "(あとから削除される場合があります)。"
      : "";
    const left = untouched > 0 ? `残る ${untouched} 件は削除していません。` : "";
    // 一覧を見比べたときに数が合うよう、最初から対象外の分も伝える
    const kept = (skipped > 0 ? `進行中の ${skipped} 件は最初から対象外です。` : "") +
      (deleted > 0 || pending > 0 ? "記録一覧で結果を確かめてください。" : "");
    const body = done + reasonForReport(err) + unknown + left + kept;

    // ルームを離れたあとに終わった場合、エラー欄はもう別のルームのもの。
    // 件数を捨てるわけにはいかないので、その場で知らせる。
    // 持ち越す知らせは保存されるため、再読み込みの注意は付けない。
    if (epoch !== roomEpoch) {
      return reportLate("退出したルームについて。" + body, room, 2);
    }

    if (deleted > 0 || pending > 0) {
      // 新しい内訳のほうが確かなので、こちらを控えとして残す
      keepDeleteReport("clear", body);
    } else {
      // 今回は何も送れていない。前回の「確認できなかった件数」は
      // まだ有効なので、消さずに後ろへ添える。
      notice(body, "clear");
    }
  } finally {
    // 世代が変わっていてもボタンは必ず戻す(戻さないと次のルームで操作できなくなる)。
    // ただし、あとから終わった古い操作が今の操作の状態を戻さないようにする。
    finishRecordsWork(token);
  }
}

// ── CSV 書き出し ────────────────────────────────────────────

const CSV_HEADER = [
  "session_id", "label", "status",
  "start_local", "start_iso", "start_ms",
  "end_local", "end_iso", "end_ms",
  "duration_ms", "duration_sec",
  "start_raw_ms", "end_raw_ms",
  "start_offset_ms", "end_offset_ms",
  "start_accuracy_ms", "end_accuracy_ms",
  "start_synced", "end_synced",
  "server_started_at", "server_ended_at",
  "started_by", "ended_by",
];

async function exportCsv() {
  if (recordsInFlight > 0 || !state.roomId) return;
  // 読み込み中に退出されても、書き出し先は操作した時点のルームに固定する
  // (state から取り直すと、退出後に null を触って黙って失敗する)
  const room = state.roomId;
  const epoch = roomEpoch;
  const here = () => epoch === roomEpoch;

  const token = startRecordsWork();
  el.btnCsv.textContent = "取得中…";
  try {
    const rows = await fetchAllSessions(db, room);

    if (rows.length === 0) {
      // 黙って終わると、書き出せたのかどうかが分からない
      if (here()) toast("書き出す記録がありません");
      else reportLate("退出したルームには、書き出す記録がありませんでした。", room);
      return;
    }

    const lines = [CSV_HEADER.join(",")];
    for (const s of rows) {
      lines.push([
        csv(s.id), csvText(s.label), csv(s.status),
        csv(formatFull(s.startMs)), csv(toIso(s.startMs)), csv(s.startMs),
        csv(formatFull(s.endMs)), csv(toIso(s.endMs)), csv(s.endMs),
        csv(s.durationMs), csv(s.durationMs != null ? (s.durationMs / 1000).toFixed(3) : ""),
        csv(s.startRawMs), csv(s.endRawMs),
        csv(round1(s.startOffsetMs)), csv(round1(s.endOffsetMs)),
        csv(round1(s.startAccuracyMs)), csv(round1(s.endAccuracyMs)),
        csv(s.startSynced), csv(s.endSynced),
        csv(fromTimestamp(s.startedAt)), csv(fromTimestamp(s.endedAt)),
        csv(s.startedBy), csv(s.endedBy),
      ].join(","));
    }

    // 先頭の BOM は Excel に UTF-8 と認識させるために必要
    const text = "﻿" + lines.join("\r\n") + "\r\n";
    const name = `okulab-time_${room.slice(0, 6)}_${stamp()}.csv`;
    // 退出していても、控えたルームの内容で書き出しは最後まで行う。
    // 触らないのは画面の表示だけ(いまは別のルームのもの)。
    const saved = await saveFile(name, text);

    if (!here()) {
      // 退出後に終わった。取り消された場合は、記録がまだ手元に無いことを
      // 必ず伝える(黙って終わると、保存できた前提で削除に進んでしまう)。
      return reportLate(saved === "cancelled"
        ? "退出したルームの CSV 書き出しは保存が取り消されました。記録はまだ保存されていません。"
        : `退出したルームの記録 ${rows.length} 件を書き出しました。`,
        room, saved === "cancelled" ? 1 : 0);
    }

    clearNotice("csv");   // 前回の失敗の表示を残さない
    // 取り消した場合に「書き出しました」と伝えると、保存できた前提で
    // 一括削除に進んでしまう。取り消しは取り消しとして伝える。
    if (saved === "cancelled") {
      notice("書き出しを取り消しました。記録はまだ保存されていません。", "csv");
    } else {
      toast(`${rows.length} 件を書き出しました(保存先を確かめてください)`);
    }
  } catch (err) {
    const failure = "CSV 書き出しに失敗しました。" + reasonBesideReport(err);
    // 退出後はエラー欄が別のルームのものになる。黙って終わらせない。
    if (!here()) return reportLate("退出したルームの" + failure, room, 1);
    notice(failure, "csv");
  } finally {
    finishRecordsWork(token);
  }
}

/**
 * ホーム画面に追加した状態(standalone)の iOS では <a download> が
 * 無反応になることがあるため、共有シート経由の保存を先に試す。
 */
/**
 * @returns {Promise<"cancelled"|"unknown">}
 *   取り消されたことだけは分かる。それ以外は、手元に取り出せる
 *   ファイルが残ったかどうかをブラウザから知る手段がないため
 *   "unknown" を返す(「保存できた」と言い切らない)。
 */
async function saveFile(filename, text) {
  const file = new File([text], filename, { type: "text/csv" });
  const standalone =
    window.navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;

  if (standalone && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      // 共有先に渡ったことは分かるが、取り出せるファイルとして残ったかは
      // 分からない(クリップボードや、受け取りを断られた送信でも解決する)
      return "unknown";
    } catch (err) {
      // 利用者が共有シートを閉じた。保存はされていない
      if (err?.name === "AbortError") return "cancelled";
      // それ以外は通常のダウンロードにフォールバック
    }
  }

  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  // ブラウザに渡すところまで。保存先の選択を取り消されても分からない。
  return "unknown";
}

function csv(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** 自由入力の文字列。表計算ソフトに数式として解釈されないようにする。 */
function csvText(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return csv(text);
}

const round1 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : "");

function fromTimestamp(ts) {
  try {
    return ts?.toDate ? ts.toDate().toISOString() : "";
  } catch {
    return "";
  }
}

// ── 表示ユーティリティ ──────────────────────────────────────

const pad = (n, width = 2) => String(Math.trunc(Math.abs(n))).padStart(width, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 経過時間 → M:SS.mmm(1 時間以上なら H:MM:SS.mmm) */
function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "--:--.---";
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600000);
  const m = Math.floor(abs / 60000) % 60;
  const s = Math.floor(abs / 1000) % 60;
  const milli = Math.floor(abs) % 1000;
  return h > 0
    ? `${sign}${h}:${pad(m)}:${pad(s)}.${pad(milli, 3)}`
    : `${sign}${pad(m)}:${pad(s)}.${pad(milli, 3)}`;
}

/** 秒数(小数 3 桁) */
function formatSeconds(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? (ms / 1000).toFixed(3) : "—";
}

/** 時刻 → HH:MM:SS.mmm */
function formatClock(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 時刻 → YYYY-MM-DD HH:MM:SS.mmm(ローカル) */
function formatFull(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function toIso(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  try {
    return new Date(ms).toISOString();
  } catch {
    return ""; // 表現できない範囲の値
  }
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
         `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function show(name) {
  for (const [key, node] of Object.entries(el.screens)) node.hidden = key !== name;
}

function showError(node, message) {
  node.textContent = message;
  node.hidden = false;
}

/**
 * エラー欄を描き直す。
 *
 * 削除の件数は画面のこの欄にしか残らない。通信が切れている場面では
 * 削除の打ち切りと次の操作の失敗が続けて起こるため、後から来た知らせで
 * 上書きすると、確かめるべき件数そのものが失われる。
 * 毎回 2 つの控えから作り直すので、繰り返しても文言は積み上がらない。
 */
function renderActionError() {
  const report = deleteReportText();
  // 注意は表示するときだけ付ける。控えに含めると、持ち越した知らせ
  // (保存され、再読み込みでも残る)にまで付いて事実に反する。
  const shown = report ? RELOAD_WARNING + report : "";
  const text = shown && noticeText
    ? `${shown}(続けて: ${noticeText})`
    : shown || noticeText;

  el.btnDismissReport.hidden = report === "";
  if (!text) {
    el.actionError.hidden = true;
    el.actionError.textContent = "";
    return;
  }
  el.actionError.textContent = text;
  el.actionError.hidden = false;
}

/** 未解決の削除結果をひとつなぎにしたもの(空なら "") */
function deleteReportText() {
  return deleteReports.map((r) => r.text).join("\n");
}

/** ほかの操作からの知らせを出す(削除の内訳は消さない) */
function notice(message, owner, key = null) {
  noticeText = message;
  noticeOwner = owner;
  noticeKey = key;
  renderActionError();
}

/**
 * 知らせを消す。
 * 持ち主を指定すると自分が出した分だけ、対象まで指定すると
 * その対象についての分だけを消す(別の記録についての知らせを
 * 巻き添えにしない)。何も指定しなければ、どの知らせでも消す。
 */
function clearNotice(owner, key) {
  if (owner !== undefined && noticeOwner !== owner) return;
  if (key !== undefined && noticeKey !== key) return;
  noticeText = "";
  noticeOwner = null;
  noticeKey = null;
  renderActionError();
}

/**
 * 削除の結果を控える。以後、ほかの操作では消えない。
 *
 * まとめ削除の内訳は、新しいものがサーバーを読み直した結果なので
 * 置き換える。1 件削除の「消えたか分からない」は件ごとに別の事実なので
 * 積み上げる(同じ記録を押し直した場合だけ重ねない)。
 */
function keepDeleteReport(kind, text, key = kind) {
  if (kind === "clear") deleteReports = deleteReports.filter((r) => r.kind !== "clear");

  const existing = deleteReports.find((r) => r.kind === kind && r.key === key);
  if (existing) existing.text = text;
  else deleteReports.push({ kind, key, text });

  // 画面から消えても追えるよう、控えた時点で必ず記録に残す
  console.warn("[okulab-time] 削除の結果: " + text);

  // 自分が前に出した、同じ対象についての知らせだけを置き換える
  if (noticeOwner === kind && (noticeKey === null || noticeKey === key)) {
    noticeText = "";
    noticeOwner = null;
    noticeKey = null;
  }
  renderActionError();
}

/** 削除の結果が解決したので取り下げる(添えられた知らせは残す) */
function clearDeleteReport() {
  deleteReports = [];
  renderActionError();
}

/** その対象だけ解決した(押し直して確かに消えた場合など) */
function resolveDeleteReport(kind, key) {
  const before = deleteReports.length;
  deleteReports = deleteReports.filter((r) => !(r.kind === kind && r.key === key));
  if (deleteReports.length !== before) renderActionError();
}

/** 読み終えた内訳を消す(内訳がある間だけ効く) */
function dismissActionError() {
  if (deleteReports.length === 0) return;
  // 取り消せない操作の件数。誤って触れただけで消さない。
  // 添えられた知らせも一緒に消えるので、確認にも載せる。
  const shown = [deleteReportText(), noticeText].filter(Boolean).join("\n");
  if (!confirm(`${shown}\n\nこの内容を消します。控えましたか?`)) return;
  clearDeleteReport();
  clearNotice();
}

/**
 * 退出したあとに終わった操作の結果を伝える。
 *
 * 元のルームのエラー欄はもう無いので、いまの画面に出すしかない。
 * 出す先は実験者用画面と参加画面だけなので、被験者には見えない。
 * 割り込むダイアログは使わない(実験中に出ると計測の押下そのものを
 * 奪い、押下時刻が閉じた時刻になる)。
 *
 * @param {number} [rank] 残す優先度。0 = 記録一覧で確かめられる結果、
 *   1 = 保存できていない・失敗(やり直せる)、2 = 消えたかどうか
 *   分からない(ここにしか残らない)。上限で落とすときは低いものから。
 */
function reportLate(message, room, rank = 0) {
  // 画面から消えても追えるよう、必ず記録に残す
  console.warn("[okulab-time] " + message);

  // 同じ文言でも別の操作の結果なので、まとめない。どれがいつ・どのルームの
  // ことか分かるよう、日時とルームを添える。
  const where = room ? ` [room ${room.slice(0, 6)}]` : "";
  lateReports.push({ text: `${formatFull(Date.now())}${where} ${message}`, rank });

  // 上限を超えたら、優先度の低いものから、同じなら古いものから落とす。
  // 一律に古い順で落とすと、ここにしか残らない件数が真っ先に消える。
  while (lateReports.length > MAX_LATE_REPORTS) {
    const lowest = Math.min(...lateReports.map((r) => r.rank ?? 0));
    lateReports.splice(lateReports.findIndex((r) => (r.rank ?? 0) === lowest), 1);
  }

  saveLateReports();
  renderLateReports();
}

/**
 * 退出後に終わった計測操作の結果を伝える。
 *
 * 押した瞬間は取り戻せない。成功なら記録一覧で確かめられるが、
 * 失敗はどこにも残らないため、必ず知らせる(とくに終了の失敗は、
 * その計測が進行中のまま残ることを意味する)。
 */
function reportLateResult(what, result, room) {
  if (result.ok) {
    reportLate(`退出したルームで${what}の送信が完了しました。`, room, 0);
    return;
  }
  if (result.code === "CANCELLED") {
    // 一度も送っていなければ、伝えることがない
    if (!result.sent) return;
    // 送ったあとに取り消した場合は、届いていた可能性が残る。
    // 「記録できなかった」とも「できた」とも言えない。
    reportLate(
      `退出したルームで${what}を送りましたが、記録できたかどうか確認できませんでした。` +
      "記録一覧で結果を確かめてください。",
      room, 2
    );
    return;
  }
  reportLate(`退出したルームで${what}を記録できませんでした。${describeCode(result.code)}`, room, 2);
}

/** 持ち越している知らせをひとつなぎにしたもの */
function lateReportText() {
  return lateReports.map((r) => r.text).join("\n");
}

/**
 * 持ち越している知らせを、参加画面と実験者用画面の両方に出す。
 *
 * 件数はここにしか残らない。参加画面にいる間は実験者用画面の欄が
 * 隠れているため、両方に出さないと読む機会が無いまま消える。
 */
function renderLateReports() {
  const shown = lateReportText();
  for (const node of [el.lateReport, el.lateReportMain]) {
    node.textContent = shown;
    node.hidden = shown === "";
  }
  el.btnDismissLate.hidden = shown === "";
  el.btnDismissLateMain.hidden = shown === "";
}

/** 読み終えた知らせを消す */
function dismissLateReports() {
  if (lateReports.length === 0) return;
  // 取り消せない操作の結果。誤って触れただけで消さない。
  if (!confirm(`${lateReportText()}\n\nこの内容を消します。控えましたか?`)) return;
  lateReports = [];
  saveLateReports();
  renderLateReports();
}

function saveLateReports() {
  try {
    if (lateReports.length > 0) localStorage.setItem(LATE_KEY, JSON.stringify(lateReports));
    else localStorage.removeItem(LATE_KEY);
  } catch { /* プライベートブラウズなどでは保存できない */ }
}

function loadLateReports() {
  try {
    const saved = JSON.parse(localStorage.getItem(LATE_KEY) ?? "[]");
    if (!Array.isArray(saved)) return;
    lateReports = saved
      .map((r) => (typeof r === "string" ? { text: r, rank: 2 } : r))
      .filter((r) => r && typeof r.text === "string");
  } catch { /* 読めなければ何も持ち越さない */ }
}

/**
 * エラー欄を空にする(ルームの出入り)。
 * この欄は必ず控えから組み立てる。直接書き込むと、次の知らせで黙って消える。
 */
function clearActionError() {
  deleteReports = [];
  noticeText = "";
  noticeOwner = null;
  noticeKey = null;
  renderActionError();
}

function hideError(node) {
  node.hidden = true;
  node.textContent = "";
}

function toast(message) {
  // 被験者用画面では、計測の成否を示す表示を一切出さない
  if (state.participant) return;
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

// ── エラーメッセージ ────────────────────────────────────────

function describeCode(code) {
  return {
    ALREADY_RUNNING: "すでに計測中です。先に終了するか、「計測を中止」で状態を戻してください。",
    NOT_RUNNING:     "進行中の計測がありません。もう一方の端末で開始してください。",
    STALE_CLEARED:   "進行中の記録が見つからなかったため、状態を初期化しました。もう一度開始してください。",
    SESSION_CHANGED: "操作しようとした計測が、別の計測に切り替わっていました。" +
                     "取り違えを避けるため何もしていません。画面の状態を確認してから操作し直してください。",
    ALREADY_ENDED:   "この計測は、すでに別の端末で終了しています。",
    // 呼び出し側が世代の照合で先に抜けるため、いまは表示に至らない。
    // 照合の順序が変わったときに文言が無い状態にしないため残している。
    CANCELLED:       "ルームを移動したため、操作を取り消しました。",
  }[code] ?? `処理できませんでした(${code})`;
}

function describeError(err) {
  const code = err?.code ?? "";
  const table = {
    "permission-denied":
      "Firestore に拒否されました。セキュリティルール(firestore.rules)が反映されているか確認してください。",
    "unavailable":
      "サーバーに接続できません。ネットワーク状況を確認してください。",
    "failed-precondition":
      "Firestore の準備ができていません。Firebase コンソールでデータベースが作成済みか確認してください。",
    "deadline-exceeded":
      "サーバーの応答がありませんでした。通信状況を確認してもう一度お試しください。",
    "cancelled":
      "処理が中断されました。もう一度お試しください。",
    "resource-exhausted":
      "Firebase の無料枠の上限に達した可能性があります。時間をおいて再度お試しください。",
    "unauthenticated":
      "ログインが切れました。ページを再読み込みしてください。",
    "auth/configuration-not-found":
      "匿名ログインが無効です。Firebase コンソール → Authentication → Sign-in method で「匿名」を有効にしてください。",
    "auth/admin-restricted-operation":
      "匿名ログインが無効です。Firebase コンソール → Authentication → Sign-in method で「匿名」を有効にしてください。",
    "auth/unauthorized-domain":
      "このドメインは Firebase に許可されていません。Authentication → Settings → 承認済みドメイン に " +
      location.hostname + " を追加してください。",
    "auth/network-request-failed":
      "認証サーバーに接続できません。ネットワーク状況を確認してください。",
    "auth/invalid-api-key":
      "API キーが正しくありません。js/firebase-config.js を確認してください。",
  };
  if (table[code]) return table[code];

  // こちらが利用者向けに書いた文言だけをそのまま出す
  if (err?.userMessage) return err.userMessage;

  // 処理系のメッセージを見出しにしても、利用者には手がかりにならない。
  // ただし実機は iPad でコンソールを開けないため、消してしまうと
  // 開発者に伝える手段が無くなる(この版で直した不具合も、利用者が
  // 画面のメッセージを写して報告したことで分かった)。
  // 案内を主にしたうえで、詳細も添える。
  console.error("[okulab-time] 想定外のエラー", err);
  const raw = err?.message ?? (typeof err === "string" ? err : "");
  const detail = [code, raw].filter(Boolean).join(": ").slice(0, 120);
  return "予期しないエラーが発生しました。ページを再読み込みしてください。" +
    (detail ? `(詳細: ${detail})` : "");
}

/**
 * 削除の内訳に添える理由。
 *
 * 「ページを再読み込みしてください」「もう一度お試しください」は取り除く。
 * 件数は画面にしか残らないため、その場で従うと確かめるべき数が消える。
 * 語句単位で消すと「通信状況を確認してもう一度お試しください。」が
 * 「通信状況を確認して」で切れるので、文の切れ目にあるものだけを外す。
 */
function reasonForReport(err) {
  return describeError(err)
    .replace(/(^|。)(?:ページを再読み込みしてください|もう一度お試しください)。/g, "$1");
}

/**
 * 件数と同じ欄に並ぶときだけ、案内を外した文言にする。
 *
 * 外すのは「その場で従うと件数が消える」ためであり、件数が無いときは
 * 対処の手立てを削るだけになる(取り消し・ログイン切れなど)。
 */
function reasonBesideReport(err) {
  return deleteReports.length > 0 ? reasonForReport(err) : describeError(err);
}
