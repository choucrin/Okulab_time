// E2E 専用の Firestore スタブ(本番 Firebase には接続しない)。
//
// https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js への要求を
// Playwright の route でこのファイルに差し替える。js/store.js・js/clock.js が使う
// API だけを最小限に実装する。データは同じブラウザコンテキストの localStorage に
// 置き、開始端末・終了端末役の 2 ページで共有する(他ページの変更は定期確認で通知)。
// セキュリティルールは評価しない(ルール・送信フィールドは F-11 で変更なし、RSD 7-3)。

const KEY = "__okulab_e2e_firestore__";
const listeners = new Set();
let lastRaw = localStorage.getItem(KEY);

const load = () => JSON.parse(localStorage.getItem(KEY) ?? "{}");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function notify() {
  lastRaw = localStorage.getItem(KEY);
  for (const listener of [...listeners]) listener();
}
setInterval(() => { if (localStorage.getItem(KEY) !== lastRaw) notify(); }, 50);

function commit(writes) {
  const store = load();
  for (const [kind, ref, data, options] of writes) {
    if (kind === "delete") { delete store[ref.path]; continue; }
    if (kind === "update" && !store[ref.path]) {
      throw Object.assign(new Error(`No document to update: ${ref.path}`), { code: "not-found" });
    }
    const resolved = {};
    for (const [field, value] of Object.entries(data)) {
      resolved[field] = value && value.__serverTimestamp ? { __ts: Date.now() } : value;
    }
    store[ref.path] = kind === "set" && !options?.merge ? resolved : { ...store[ref.path], ...resolved };
  }
  localStorage.setItem(KEY, JSON.stringify(store));
  notify();
}

function timestamp(ms) {
  return {
    toMillis: () => ms, toDate: () => new Date(ms),
    seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6,
  };
}

function revive(data) {
  if (!data) return undefined;
  const out = {};
  for (const [field, value] of Object.entries(data)) {
    out[field] = value && typeof value === "object" && "__ts" in value ? timestamp(value.__ts) : value;
  }
  return out;
}

const autoId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(16).padStart(2, "0")).join("");

function docSnapshot(path, raw) {
  const id = path.split("/").at(-1);
  return {
    id,
    ref: { type: "doc", path, id },
    metadata: { fromCache: false, hasPendingWrites: false },
    exists: () => raw !== undefined,
    data: () => revive(raw),
    get: (field) => revive(raw)?.[field],
  };
}

function runQuery(target, store = load()) {
  const base = target.type === "query" ? target.collection : target;
  const prefix = base.path + "/";
  let docs = Object.keys(store)
    .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
    .map((path) => [path, store[path]]);
  for (const c of target.constraints ?? []) {
    if (c.kind === "orderBy") {
      docs = docs.filter(([, data]) => data[c.field] !== undefined)
        .sort(([, a], [, b]) => (a[c.field] < b[c.field] ? -1 : a[c.field] > b[c.field] ? 1 : 0)
          * (c.direction === "desc" ? -1 : 1));
    }
  }
  for (const c of target.constraints ?? []) if (c.kind === "limit") docs = docs.slice(0, c.count);
  const snaps = docs.map(([path, data]) => docSnapshot(path, data));
  return { docs: snaps, size: snaps.length, empty: snaps.length === 0, metadata: { fromCache: false, hasPendingWrites: false } };
}

export function getFirestore() { return { type: "firestore" }; }

export function collection(_db, ...segments) {
  return { type: "collection", path: segments.join("/") };
}

export function doc(parent, ...segments) {
  if (parent?.type === "collection") {
    const id = segments.length ? segments.join("/") : autoId();
    return { type: "doc", path: `${parent.path}/${id}`, id };
  }
  return { type: "doc", path: segments.join("/"), id: segments.at(-1) };
}

export const orderBy = (field, direction = "asc") => ({ kind: "orderBy", field, direction });
export const limit = (count) => ({ kind: "limit", count });
export const query = (collectionRef, ...constraints) => ({ type: "query", collection: collectionRef, constraints });
export const serverTimestamp = () => ({ __serverTimestamp: true });

export async function getDoc(ref) { await sleep(5); return docSnapshot(ref.path, load()[ref.path]); }
export const getDocFromServer = getDoc;
export async function getDocsFromServer(target) { await sleep(5); return runQuery(target); }
export async function setDoc(ref, data, options) { await sleep(5); commit([["set", ref, data, options]]); }
export async function deleteDoc(ref) { await sleep(5); commit([["delete", ref]]); }

export function writeBatch() {
  const writes = [];
  const batch = {
    set(ref, data, options) { writes.push(["set", ref, data, options]); return batch; },
    update(ref, data) { writes.push(["update", ref, data]); return batch; },
    delete(ref) { writes.push(["delete", ref]); return batch; },
    async commit() { await sleep(5); commit(writes); },
  };
  return batch;
}

export async function runTransaction(_db, updateFunction) {
  await sleep(10);
  const store = load();
  const writes = [];
  const tx = {
    async get(ref) { return docSnapshot(ref.path, store[ref.path]); },
    set(ref, data, options) { writes.push(["set", ref, data, options]); return tx; },
    update(ref, data) { writes.push(["update", ref, data]); return tx; },
    delete(ref) { writes.push(["delete", ref]); return tx; },
  };
  const result = await updateFunction(tx);
  commit(writes);
  return result;
}

export function onSnapshot(target, ...args) {
  const [next, error] = typeof args[0] === "function" ? args : args.slice(1);
  let last;
  let active = true;
  const emit = () => {
    if (!active) return;
    try {
      const store = load();
      const snap = target.type === "doc" ? docSnapshot(target.path, store[target.path]) : runQuery(target, store);
      const key = JSON.stringify(target.type === "doc" ? store[target.path] ?? null
        : snap.docs.map((d) => [d.id, store[d.ref.path]]));
      if (key === last) return;
      last = key;
      next(snap);
    } catch (err) {
      error?.(err);
    }
  };
  const listener = () => setTimeout(emit, 0);
  listeners.add(listener);
  listener();
  return () => { active = false; listeners.delete(listener); };
}
