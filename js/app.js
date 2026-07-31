// ─────────────────────────────────────────────────────────────
//  Okulab Time — 画面制御
// ─────────────────────────────────────────────────────────────

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";
import { ClockSync } from "./clock.js";
import {
  deriveRoomId, startSession, endSession, abortSession,
  deleteSession, subscribeSessions,
} from "./store.js";

const STORAGE_KEY = "okulab-time/session";
const ROLE_LABEL = { start: "計測開始 担当", end: "計測終了 担当", view: "閲覧のみ" };
const PRESS_FRESH_MS = 2000; // pointerdown で拾った時刻を有効とみなす猶予

const $ = (id) => document.getElementById(id);

const el = {
  screens:     { config: $("screen-config"), join: $("screen-join"), main: $("screen-main") },
  configDetail: $("config-detail"),
  joinForm:    $("join-form"),
  inputRoom:   $("input-room"),
  btnJoin:     $("btn-join"),
  joinError:   $("join-error"),
  pillRole:    $("pill-role"),
  pillRoom:    $("pill-room"),
  pillClock:   $("pill-clock"),
  btnLeave:    $("btn-leave"),
  statusCard:  $("status-card"),
  statusLabel: $("status-label"),
  statusTime:  $("status-time"),
  statusMeta:  $("status-meta"),
  panelStart:  $("panel-start"),
  panelEnd:    $("panel-end"),
  inputLabel:  $("input-label"),
  btnStart:    $("btn-start"),
  btnEnd:      $("btn-end"),
  actionError: $("action-error"),
  recordCount: $("record-count"),
  recordBody:  $("record-body"),
  recordEmpty: $("record-empty"),
  btnAbort:    $("btn-abort"),
  btnCsv:      $("btn-csv"),
  toast:       $("toast"),
};

const state = {
  uid: null,
  roomId: null,
  role: null,
  sessions: [],
  active: null,
  busy: false,
};

let db = null;
let auth = null;
let authPromise = null;
let clock = null;
let unsubscribe = null;
let ticker = null;
let toastTimer = null;

// ── 起動 ────────────────────────────────────────────────────

main();

function main() {
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

  authPromise = signInAnonymously(auth);
  bindEvents();
  restore();
}

function isConfigured(cfg) {
  const required = ["apiKey", "authDomain", "projectId", "appId"];
  return required.every((k) => typeof cfg[k] === "string" && cfg[k] && !cfg[k].startsWith("YOUR_"));
}

function restore() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    saved = null;
  }
  if (saved?.roomId && ROLE_LABEL[saved.role]) {
    enterRoom(saved.roomId, saved.role);
  } else {
    show("join");
    el.inputRoom.focus();
  }
}

// ── イベント登録 ────────────────────────────────────────────

function bindEvents() {
  el.joinForm.addEventListener("submit", onJoin);
  el.btnLeave.addEventListener("click", leaveRoom);
  el.btnCsv.addEventListener("click", exportCsv);
  el.btnAbort.addEventListener("click", onAbort);
  el.recordBody.addEventListener("click", onRecordClick);

  bindPressButton(el.btnStart, onStart);
  bindPressButton(el.btnEnd, onEnd);
}

/**
 * ボタンを押した「瞬間」の時刻を pointerdown で拾い、click で確定する。
 * click まで待つと指を離すまでの時間が誤差として乗るため。
 */
function bindPressButton(button, handler) {
  let pressedAt = null; // { at, localAt }

  button.addEventListener(
    "pointerdown",
    () => {
      if (button.disabled) return;
      pressedAt = { at: clock ? clock.now() : Date.now(), localAt: Date.now() };
    },
    { passive: true }
  );

  const forget = () => { pressedAt = null; };
  button.addEventListener("pointercancel", forget, { passive: true });
  button.addEventListener("pointerleave", forget, { passive: true });

  button.addEventListener("click", () => {
    const fresh = pressedAt && Date.now() - pressedAt.localAt < PRESS_FRESH_MS;
    const at = fresh ? pressedAt.at : (clock ? clock.now() : Date.now());
    pressedAt = null;
    handler(at);
  });
}

// ── 参加 / 退出 ─────────────────────────────────────────────

async function onJoin(event) {
  event.preventDefault();
  hideError(el.joinError);

  const passphrase = el.inputRoom.value.trim();
  const role = el.joinForm.querySelector('input[name="role"]:checked')?.value;

  if (!passphrase) return showError(el.joinError, "合言葉を入力してください。");
  if (!role) return showError(el.joinError, "この端末の役割を選んでください。");

  el.btnJoin.disabled = true;
  el.btnJoin.textContent = "接続中…";
  try {
    const cred = await authPromise;
    state.uid = cred.user.uid;
    const roomId = await deriveRoomId(passphrase);
    el.inputRoom.value = "";
    enterRoom(roomId, role);
  } catch (err) {
    authPromise = signInAnonymously(auth).catch(() => { throw err; });
    showError(el.joinError, describeError(err));
  } finally {
    el.btnJoin.disabled = false;
    el.btnJoin.textContent = "この端末を参加させる";
  }
}

async function enterRoom(roomId, role) {
  // 復帰経路では認証がまだ終わっていないことがある
  if (!state.uid) {
    try {
      const cred = await authPromise;
      state.uid = cred.user.uid;
    } catch (err) {
      show("join");
      showError(el.joinError, describeError(err));
      return;
    }
  }

  state.roomId = roomId;
  state.role = role;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ roomId, role }));
  } catch { /* プライベートブラウズなどでは保存できない */ }

  el.pillRole.textContent = ROLE_LABEL[role];
  el.pillRoom.textContent = "room " + roomId.slice(0, 6);
  el.panelStart.hidden = role !== "start";
  el.panelEnd.hidden = role !== "end";
  show("main");

  clock = new ClockSync(db, ["rooms", roomId, "clock", state.uid]);
  clock.onChange = renderClock;
  renderClock();
  clock.start();

  unsubscribe = subscribeSessions(db, roomId, onSessions, (err) => {
    showError(el.actionError, describeError(err));
  });
}

function leaveRoom() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  if (clock) { clock.stop(); clock = null; }
  stopTicker();
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }

  state.roomId = null;
  state.role = null;
  state.sessions = [];
  state.active = null;
  hideError(el.actionError);
  show("join");
  el.inputRoom.focus();
}

// ── データ受信 ──────────────────────────────────────────────

function onSessions(list) {
  state.sessions = list;
  state.active = list.find((s) => s.status === "running") ?? null;
  render();
}

function render() {
  renderStatus();
  renderControls();
  renderRecords();
}

function renderStatus() {
  const active = state.active;
  el.statusCard.dataset.state = active ? "running" : "idle";

  if (!active) {
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
  el.statusMeta.textContent =
    `${formatClock(active.startMs)} 開始` + (active.label ? ` — ${active.label}` : "");
  startTicker();
}

function startTicker() {
  if (ticker) return;
  const update = () => {
    if (!state.active) return;
    el.statusTime.textContent = formatDuration(clock.now() - state.active.startMs);
  };
  update();
  ticker = setInterval(update, 47);
}

function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

function renderControls() {
  const running = Boolean(state.active);
  el.btnStart.disabled = running || state.busy;
  el.btnEnd.disabled = !running || state.busy;
  el.btnAbort.hidden = !running || state.role === "view";
}

function renderClock() {
  if (!clock) {
    el.pillClock.textContent = "同期待ち";
    el.pillClock.classList.remove("pill--bad");
    return;
  }
  const quality = clock.quality;
  const acc = clock.accuracyMs;
  const text = {
    good:     () => `同期 ±${Math.round(acc)}ms`,
    rough:    () => `同期 ±${(acc / 1000).toFixed(1)}s`,
    stale:    () => "同期(古い)",
    unsynced: () => "同期中…",
  }[quality]();
  el.pillClock.textContent = text;
  el.pillClock.classList.toggle("pill--bad", quality === "unsynced");
  el.pillClock.title =
    quality === "unsynced"
      ? "サーバー時刻と同期できていません。記録は端末時計のまま保存されます。"
      : `サーバー時刻との推定誤差 ±${Math.round(acc)}ms / オフセット ${Math.round(clock.offsetMs)}ms`;
}

function renderRecords() {
  const rows = state.sessions;
  el.recordCount.textContent = String(rows.length);
  el.recordEmpty.hidden = rows.length > 0;
  el.recordBody.replaceChildren();

  for (const s of rows) {
    const tr = document.createElement("tr");
    if (s.status === "running") tr.className = "row-running";
    if (s.status === "aborted") tr.className = "row-aborted";

    tr.append(
      cell(s.label || "—", "label-cell", s.label || ""),
      cell(formatClock(s.startMs), "mono", formatFull(s.startMs)),
      cell(
        s.status === "running" ? "—" : formatClock(s.endMs),
        "mono",
        s.endMs ? formatFull(s.endMs) : ""
      ),
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
    td.style.color = "var(--end)";
    td.title = "終了時刻が開始時刻より前になっています。端末の時計を確認してください。";
  }
  return td;
}

// ── 操作 ────────────────────────────────────────────────────

async function onStart(atMs) {
  if (state.busy || !state.roomId) return;
  await withBusy(async () => {
    const result = await startSession(db, state.roomId, {
      label: el.inputLabel.value.trim().slice(0, 80),
      atMs,
      offsetMs: clock.offsetMs,
      accuracyMs: clock.ok ? clock.accuracyMs : null,
      uid: state.uid,
    });
    if (result.ok) toast("計測を開始しました");
    else showError(el.actionError, describeCode(result.code));
  });
}

async function onEnd(atMs) {
  if (state.busy || !state.roomId) return;
  await withBusy(async () => {
    const result = await endSession(db, state.roomId, {
      atMs,
      offsetMs: clock.offsetMs,
      accuracyMs: clock.ok ? clock.accuracyMs : null,
      uid: state.uid,
    });
    if (result.ok) toast(`計測終了 — ${formatSeconds(result.durationMs)} 秒`);
    else showError(el.actionError, describeCode(result.code));
  });
}

async function onAbort() {
  if (!state.active) return;
  if (!confirm("進行中の計測を中止します。よろしいですか?")) return;
  await withBusy(async () => {
    const result = await abortSession(db, state.roomId, { uid: state.uid });
    if (result.ok) toast("計測を中止しました");
    else showError(el.actionError, describeCode(result.code));
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
    renderControls();
  }
}

// ── CSV 書き出し ────────────────────────────────────────────

const CSV_HEADER = [
  "session_id", "label", "status",
  "start_local", "start_iso", "start_ms",
  "end_local", "end_iso", "end_ms",
  "duration_ms", "duration_sec",
  "start_accuracy_ms", "end_accuracy_ms",
  "start_raw_ms", "end_raw_ms",
  "started_by", "ended_by",
];

function exportCsv() {
  if (state.sessions.length === 0) return toast("書き出す記録がありません");

  const rows = [...state.sessions].reverse(); // 古い順
  const lines = [CSV_HEADER.join(",")];
  for (const s of rows) {
    lines.push([
      s.id, s.label ?? "", s.status,
      formatFull(s.startMs), toIso(s.startMs), s.startMs ?? "",
      formatFull(s.endMs), toIso(s.endMs), s.endMs ?? "",
      s.durationMs ?? "", s.durationMs != null ? (s.durationMs / 1000).toFixed(3) : "",
      s.startAccuracyMs ?? "", s.endAccuracyMs ?? "",
      s.startRawMs ?? "", s.endRawMs ?? "",
      short(s.startedBy), short(s.endedBy),
    ].map(csvCell).join(","));
  }

  // 先頭の BOM は Excel が UTF-8 と認識するために必要
  const blob = new Blob(["﻿" + lines.join("\r\n") + "\r\n"], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `okulab-time_${state.roomId.slice(0, 6)}_${stamp()}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`${rows.length} 件を書き出しました`);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const short = (uid) => (uid ? String(uid).slice(0, 8) : "");

// ── 表示ユーティリティ ──────────────────────────────────────

const pad = (n, width = 2) => String(Math.trunc(Math.abs(n))).padStart(width, "0");

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
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 時刻 → YYYY-MM-DD HH:MM:SS.mmm(ローカル) */
function formatFull(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const toIso = (ms) =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "";

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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
    ALREADY_RUNNING: "すでに計測中です。先に終了するか、中止してください。",
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
    "auth/configuration-not-found":
      "匿名ログインが無効です。Firebase コンソール → Authentication → Sign-in method で「匿名」を有効にしてください。",
    "auth/admin-restricted-operation":
      "匿名ログインが無効です。Firebase コンソール → Authentication → Sign-in method で「匿名」を有効にしてください。",
    "auth/network-request-failed":
      "認証サーバーに接続できません。ネットワーク状況を確認してください。",
    "auth/invalid-api-key":
      "API キーが正しくありません。js/firebase-config.js を確認してください。",
  };
  if (table[code]) return table[code];
  return (err?.message ?? String(err)) + (code ? `(${code})` : "");
}
