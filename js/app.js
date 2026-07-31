// ─────────────────────────────────────────────────────────────
//  Okulab Time — 画面制御
// ─────────────────────────────────────────────────────────────

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";
import { ClockSync } from "./clock.js";
import {
  deriveRoomId, startSession, endSession, abortSession, deleteSession,
  subscribeSessions, subscribeCurrent, fetchAllSessions, SESSION_LIMIT,
} from "./store.js";

const STORAGE_KEY = "okulab-time/session";
const ROLE_LABEL = { start: "計測開始 担当", end: "計測終了 担当", view: "閲覧のみ" };
const PRESS_FRESH_MS = 2000;  // pointerdown で拾った時刻を有効とみなす猶予
const MAX_SEND_ATTEMPTS = 5;

// 一時的な障害。押した時刻を保持したまま送り直す価値があるもの。
const RETRYABLE = new Set(["unavailable", "deadline-exceeded", "internal", "aborted", "cancelled"]);

const $ = (id) => document.getElementById(id);

const el = {
  screens: {
    config:  $("screen-config"),
    join:    $("screen-join"),
    loading: $("screen-loading"),
    main:    $("screen-main"),
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
  panelStart:    $("panel-start"),
  panelEnd:      $("panel-end"),
  inputLabel:    $("input-label"),
  btnStart:      $("btn-start"),
  btnEnd:        $("btn-end"),
  startSub:      $("start-sub"),
  endSub:        $("end-sub"),
  actionError:   $("action-error"),
  recordCount:   $("record-count"),
  recordBody:    $("record-body"),
  recordEmpty:   $("record-empty"),
  recordNote:    $("record-note"),
  btnAbort:      $("btn-abort"),
  btnCsv:        $("btn-csv"),
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
};

let db = null;
let auth = null;
let authPromise = null;
let clock = null;
let stopSessions = null;
let stopCurrent = null;
let ticker = null;
let toastTimer = null;

// ── 起動 ────────────────────────────────────────────────────

main();

function main() {
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

  show("loading");
  if (!(await ensureAuth(el.joinError))) return;
  enterRoom(saved.roomId, saved.role);
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
  el.btnAbort.addEventListener("click", onAbort);
  el.recordBody.addEventListener("click", onRecordClick);

  bindPressButton(el.btnStart, onStart);
  bindPressButton(el.btnEnd, onEnd);
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
    () => {
      if (button.disabled) return;
      press = clock ? clock.snapshot() : { at: Date.now(), rawAt: Date.now(), offsetMs: 0, accuracyMs: null, synced: false };
      press.localAt = Date.now();
    },
    { passive: true }
  );

  button.addEventListener("pointercancel", () => { press = null; }, { passive: true });
  button.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") press = null;
  }, { passive: true });

  button.addEventListener("click", () => {
    const fresh = press && Date.now() - press.localAt < PRESS_FRESH_MS;
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

function enterRoom(roomId, role) {
  state.roomId = roomId;
  state.role = role;
  state.sessions = [];
  state.activeId = null;
  state.sessionsLoaded = false;
  state.currentLoaded = false;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ roomId, role }));
  } catch { /* プライベートブラウズなどでは保存できない */ }

  el.pillRole.textContent = ROLE_LABEL[role];
  el.pillRoom.textContent = "room " + roomId.slice(0, 6);
  el.panelStart.hidden = role !== "start";
  el.panelEnd.hidden = role !== "end";
  hideError(el.actionError);
  render();
  show("main");

  clock = new ClockSync(db, ["rooms", roomId, "clock", state.uid]);
  clock.onChange = () => { renderClock(); renderControls(); };
  renderClock();
  clock.start();

  stopSessions = watch(
    (onData, onError) => subscribeSessions(db, roomId, onData, onError),
    onSessions
  );
  stopCurrent = watch(
    (onData, onError) => subscribeCurrent(db, roomId, onData, onError),
    onCurrent
  );
}

/** 購読が切れたら指数バックオフで張り直す */
function watch(subscribe, onData) {
  let stopped = false;
  let unsubscribe = null;
  let delay = 1000;

  const attach = () => {
    if (stopped) return;
    unsubscribe = subscribe(
      (data) => {
        delay = 1000;
        hideError(el.actionError);
        onData(data);
      },
      (err) => {
        unsubscribe = null;
        if (stopped) return;
        if (err?.code === "permission-denied" || err?.code === "unauthenticated") {
          showError(el.actionError, describeError(err));
          return; // 張り直しても同じ結果になるので止める
        }
        showError(el.actionError, "サーバーとの接続が切れました。再接続しています…");
        setTimeout(attach, delay);
        delay = Math.min(delay * 2, 15000);
      }
    );
  };

  attach();
  return () => {
    stopped = true;
    if (unsubscribe) unsubscribe();
  };
}

function onLeave() {
  if (state.busy) return;
  if (!confirm("このルームから退出します。よろしいですか?")) return;
  leaveRoom();
}

function leaveRoom() {
  if (stopSessions) { stopSessions(); stopSessions = null; }
  if (stopCurrent) { stopCurrent(); stopCurrent = null; }
  if (clock) { clock.stop(); clock = null; }
  stopTicker();
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }

  state.roomId = null;
  state.role = null;
  state.sessions = [];
  state.activeId = null;
  state.sessionsLoaded = false;
  state.currentLoaded = false;

  render();               // 前のルームの記録を画面に残さない
  hideError(el.actionError);
  el.clockWarning.hidden = true;
  show("join");
  el.inputRoom.focus();
}

// ── データ受信 ──────────────────────────────────────────────

function onSessions(list) {
  state.sessions = list;
  state.sessionsLoaded = true;
  render();
}

function onCurrent(activeId) {
  state.activeId = activeId;
  state.currentLoaded = true;
  render();
}

/** 進行中セッションの本体(一覧の件数上限から漏れている場合は null) */
function activeSession() {
  if (!state.activeId) return null;
  return state.sessions.find((s) => s.id === state.activeId) ?? null;
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
    // meta/current は進行中を指しているのに本体が一覧に無い
    stopTicker();
    el.statusTime.textContent = "--:--.---";
    el.statusMeta.textContent = "進行中の記録を読み込めません。「計測を中止」で状態を戻せます。";
    return;
  }

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
  const ready = state.currentLoaded;
  const running = Boolean(state.activeId);
  const synced = Boolean(clock?.ok);

  el.btnStart.disabled = !ready || running || state.busy;
  el.btnEnd.disabled = !ready || !running || state.busy;
  el.btnAbort.hidden = !running || state.role === "view";
  el.btnLeave.disabled = state.busy;

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
  } else if (s.startSynced === false || s.endSynced === false) {
    td.classList.add("warn");
    td.title = "時刻同期が完了していない状態で記録されました(端末時計のままの値です)。";
  }
  return td;
}

// ── 操作 ────────────────────────────────────────────────────

async function onStart(press) {
  if (state.busy || !state.roomId) return;
  if (!press.synced && !confirmUnsynced()) return;

  await withBusy(async () => {
    const result = await send(() =>
      startSession(db, state.roomId, {
        ...press,
        label: el.inputLabel.value.trim().slice(0, 80),
        uid: state.uid,
      })
    );
    if (result.ok) toast("計測を開始しました");
    else handleCode(result.code);
  });
}

async function onEnd(press) {
  if (state.busy || !state.roomId) return;
  if (!press.synced && !confirmUnsynced()) return;

  await withBusy(async () => {
    const result = await send(() =>
      endSession(db, state.roomId, { ...press, uid: state.uid })
    );
    if (result.ok) toast(`計測終了 — ${formatSeconds(result.durationMs)} 秒`);
    else handleCode(result.code);
  });
}

function confirmUnsynced() {
  return confirm(
    "サーバー時刻との同期がまだ完了していません。\n" +
    "このまま記録すると、2 台の端末の時計のズレが誤差として残ります。\n\n" +
    "端末の時計のまま記録しますか?"
  );
}

async function onAbort() {
  if (!state.activeId) return;
  if (!confirm("進行中の計測を中止します。よろしいですか?")) return;
  await withBusy(async () => {
    const result = await send(() => abortSession(db, state.roomId, { uid: state.uid }));
    if (result.ok) toast("計測を中止しました");
    else handleCode(result.code);
  });
}

async function onRecordClick(event) {
  const button = event.target.closest("button.del");
  if (!button) return;
  if (!confirm("この記録を削除します。よろしいですか?")) return;
  try {
    await deleteSession(db, state.roomId, button.dataset.id);
    toast("記録を削除しました");
  } catch (err) {
    showError(el.actionError, describeError(err));
  }
}

/**
 * 一時的な通信障害では押した時刻を保持したまま送り直す。
 * 押し直しを強いると「押した瞬間」が失われるため。
 */
async function send(operation) {
  let delay = 400;
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await operation();
      state.sending = false;
      return result;
    } catch (err) {
      if (attempt >= MAX_SEND_ATTEMPTS || !RETRYABLE.has(err?.code)) {
        state.sending = false;
        throw err;
      }
      state.sending = true;
      renderControls();
      await sleep(delay);
      delay = Math.min(delay * 2, 4000);
    }
  }
}

function handleCode(code) {
  showError(el.actionError, describeCode(code));
  if (code === "ALREADY_RUNNING" && state.role !== "view") {
    // 状態がずれていても復旧できるよう、中止ボタンを必ず出す
    el.btnAbort.hidden = false;
  }
}

async function withBusy(fn) {
  state.busy = true;
  renderControls();
  hideError(el.actionError);
  try {
    await fn();
  } catch (err) {
    showError(el.actionError, describeError(err));
  } finally {
    state.busy = false;
    state.sending = false;
    renderControls();
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
  if (!state.roomId) return;
  el.btnCsv.disabled = true;
  el.btnCsv.textContent = "取得中…";
  try {
    const rows = await fetchAllSessions(db, state.roomId);
    if (rows.length === 0) return toast("書き出す記録がありません");

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
    const name = `okulab-time_${state.roomId.slice(0, 6)}_${stamp()}.csv`;
    await saveFile(name, text);
    toast(`${rows.length} 件を書き出しました`);
  } catch (err) {
    showError(el.actionError, describeError(err));
  } finally {
    el.btnCsv.disabled = false;
    el.btnCsv.textContent = "CSV 書き出し";
  }
}

/**
 * ホーム画面に追加した状態(standalone)の iOS では <a download> が
 * 無反応になることがあるため、共有シート経由の保存を先に試す。
 */
async function saveFile(filename, text) {
  const file = new File([text], filename, { type: "text/csv" });
  const standalone =
    window.navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;

  if (standalone && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return; // 利用者が共有シートを閉じた
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

function hideError(node) {
  node.hidden = true;
  node.textContent = "";
}

function toast(message) {
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
  return (err?.message ?? String(err)) + (code ? `(${code})` : "");
}
