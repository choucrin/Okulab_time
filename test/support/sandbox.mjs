// js/app.js から抽出した実コードを、DOM/Firebase を持たない最小スタブと
// 共に vm サンドボックスで実行するための組み立て。
//
// 複数タブを模すため、同一の localStorage ストア(同一オブジェクト参照)と
// 同一の navigator.locks(ロック名ごとに直列化する簡易実装)を複数の
// サンドボックスへ共有して渡せるようにしている。実ブラウザの Web Locks API
// は「同一オリジンの全タブで共有されるロックマネージャ」を提供するため、
// 単一プロセス内での Promise 直列化はその挙動を単純化しつつ模したものであり、
// 実ブラウザでの複数タブ・複数プロセスの検証の代替ではない。

import vm from "node:vm";
import { readSource, extractFunction, extractConst } from "./extract-app-functions.mjs";

/** 単一プロセス内で「同一オリジンの複数タブ」が共有するロックマネージャを模す。 */
export function createSharedLockManager() {
  const queues = new Map();
  return {
    request(name, callback) {
      const prev = queues.get(name) ?? Promise.resolve();
      const next = prev.then(() => callback()).catch((err) => {
        // 1件の失敗で以降のロック要求が永久に止まらないようにする(テスト用の簡易実装)。
        return Promise.reject(err);
      });
      // キューに繋ぐのは「待ち行列を進める」ためだけで、失敗を握りつぶしてはいけない。
      queues.set(name, next.catch(() => {}));
      return next;
    },
  };
}

/** 複数タブで共有する localStorage(同一オブジェクト参照によるストア)を模す。 */
export function createSharedStorageBackend() {
  return Object.create(null);
}

export function createLocalStorage(backend) {
  return {
    getItem: (key) => (Object.hasOwn(backend, key) ? backend[key] : null),
    setItem: (key, value) => { backend[key] = String(value); },
    removeItem: (key) => { delete backend[key]; },
  };
}

/**
 * カタログ関連の実関数(catalogName/catalogTag/readCatalog/editCatalog/
 * pruneSelectedTags)を、指定した localStorage・navigator.locks を使う
 * 1つの「タブ」として実行できるオブジェクトにまとめて返す。
 */
export function createCatalogTab({ localStorage, locks, catalogMessage = {} }) {
  const appSrc = readSource("js/app.js");
  const catalogKey = extractConst(appSrc, "CATALOG_KEY");
  const names = ["catalogName", "catalogTag", "readCatalog", "pruneSelectedTags", "editCatalog"];
  const bodies = names.map((name) => extractFunction(appSrc, name));

  const wrapped = `
    (function () {
      const CATALOG_KEY = ${catalogKey};
      let catalog = [];
      let catalogSnapshot = null;
      const selectedTags = new Set();
      ${bodies.join("\n\n")}
      return {
        catalogName, catalogTag, readCatalog, editCatalog, pruneSelectedTags,
        init(raw) { catalogSnapshot = raw; catalog = readCatalog(raw); },
        get catalog() { return catalog; },
        get catalogSnapshot() { return catalogSnapshot; },
        get selectedTags() { return selectedTags; },
      };
    })()
  `;

  const sandbox = {
    el: { catalogMessage, catalogAdd: {} },
    localStorage,
    navigator: { locks },
    renderCatalog: () => {},
    console,
  };
  vm.createContext(sandbox);
  return vm.runInContext(wrapped, sandbox);
}

/** catalogName/catalogTag/readCatalog/csv/csvText のみを実行する、状態を持たない検証用サンドボックス。 */
export function createPureFunctions() {
  const appSrc = readSource("js/app.js");
  const names = ["catalogName", "catalogTag", "readCatalog", "csv", "csvText"];
  const bodies = names.map((name) => extractFunction(appSrc, name));
  const wrapped = `
    (function () {
      ${bodies.join("\n\n")}
      return { catalogName, catalogTag, readCatalog, csv, csvText };
    })()
  `;
  const sandbox = { console };
  vm.createContext(sandbox);
  return vm.runInContext(wrapped, sandbox);
}
