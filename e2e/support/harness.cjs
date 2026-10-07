// ブラウザ E2E の共通処理。
//
// - アプリはリポジトリ直下を 127.0.0.1 のローカル静的サーバで配信する(ワーカー単位で起動・停止)。
// - Firebase(gstatic の SDK)は e2e/stubs/ のスタブモジュールへ差し替え、
//   127.0.0.1 以外への通信はすべて遮断して記録する(本番 Firebase へは書き込まない)。
const { test: base, expect } = require(process.env.DEVFLOW_PLAYWRIGHT_TEST);
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const STUBS = path.join(__dirname, '..', 'stubs');
const SDK = 'https://www.gstatic.com/firebasejs/12.17.0/';
const STORE_KEY = '__okulab_e2e_firestore__';
const CATALOG_KEY = 'okulab-time/catalog';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

/** js/store.js の deriveRoomId と同じ変換 */
function roomIdFor(passphrase) {
  const normalized = passphrase.normalize('NFKC').trim().toLowerCase();
  return crypto.createHash('sha256').update(`okulab-time:v1:${normalized}`).digest('hex').slice(0, 40);
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/__blank') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>blank</title>');
    }
    const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    const relative = path.relative(ROOT, file);
    if (relative.startsWith('..') || relative.split(path.sep)[0] === '.git' || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const test = base.extend({
  appServer: [async ({}, use) => {
    const server = await startServer();
    await use(`http://127.0.0.1:${server.address().port}`);
    await new Promise((resolve) => server.close(resolve));
  }, { scope: 'worker' }],

  // 外部通信の遮断と Firebase SDK の差し替え。遮断した URL は blocked に積む。
  // 参照しないテストでも必ず適用する(auto)。適用漏れは本番 Firebase への接続になる。
  blocked: [async ({ context, appServer }, use) => {
    const blocked = [];
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith(SDK)) {
        const name = url.slice(SDK.length).replace(/\.js$/, '.mjs');
        const file = path.join(STUBS, name);
        if (!fs.existsSync(file)) { blocked.push(url); return route.abort(); }
        return route.fulfill({
          status: 200, body: fs.readFileSync(file, 'utf8'),
          headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
        });
      }
      if (url.startsWith(appServer + '/') || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
      blocked.push(url);
      return route.abort();
    });
    await use(blocked);
  }, { auto: true }],
});

/**
 * コンテキストの localStorage にカタログとスタブの記録を投入する。
 * @param {object} opts
 * @param {Array|null} opts.catalog 端末カタログ(null なら置かない = カタログを持たない端末)
 * @param {string} opts.passphrase  記録を置くルームの合言葉
 * @param {Array} opts.sessions     記録(id と各フィールド)
 */
async function seed(page, appServer, { catalog = null, passphrase, sessions = [] }) {
  const roomId = roomIdFor(passphrase);
  const store = {};
  for (const s of sessions) {
    const { id, ...data } = s;
    store[`rooms/${roomId}/sessions/${id}`] = data;
  }
  await page.goto(`${appServer}/__blank`);
  await page.evaluate(({ storeKey, store, catalogKey, catalog }) => {
    localStorage.clear();
    localStorage.setItem(storeKey, JSON.stringify(store));
    if (catalog) localStorage.setItem(catalogKey, JSON.stringify(catalog));
  }, { storeKey: STORE_KEY, store, catalogKey: CATALOG_KEY, catalog });
  return roomId;
}

/** 参加画面から入室し、時刻同期(スタブ上のサーバー時刻)の完了まで待つ */
async function join(page, appServer, { passphrase, role }) {
  // 同じコンテキストの別ページが保存した参加状態で自動入室させない
  await page.goto(`${appServer}/__blank`);
  await page.evaluate(() => localStorage.removeItem('okulab-time/session'));
  await page.goto(`${appServer}/index.html`);
  await expect(page.locator('#screen-join')).toBeVisible();
  await page.fill('#input-room', passphrase);
  await page.locator(`input[name="role"][value="${role}"]`).check();
  await page.click('#btn-join');
  await expect(page.locator('#screen-main')).toBeVisible();
  await expect(page.locator('#pill-clock')).toHaveText(/同期 ±/);
  if (role === 'start') await expect(page.locator('#btn-start')).toBeEnabled();
  if (role === 'end') await expect(page.locator('#btn-end')).toBeEnabled();
}

/** ページ全体の横幅(F-11-1 の判定値) */
async function pageWidth(page) {
  return page.evaluate(() => ({
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    inner: window.innerWidth,
    client: document.documentElement.clientWidth,
  }));
}

/** 記録一覧の各行について、選択式ラベルのジャンル・内容の並びを返す */
async function recordTags(page) {
  return page.locator('#record-body tr').evaluateAll((rows) => rows.map((tr) => ({
    label: tr.cells[0].textContent,
    chips: [...tr.querySelectorAll('.tags-cell .tag-chip')].map((chip) =>
      [chip.querySelector('small').textContent, chip.querySelector('strong').textContent]),
    tagsText: tr.querySelector('.tags-cell').textContent,
  })));
}

/** 簡易 CSV パーサ(ダブルクォート・CRLF 対応) */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') continue;
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

/** スタブ上の記録を読み出す */
async function storedSessions(page, roomId) {
  return page.evaluate(({ key, prefix }) => {
    const store = JSON.parse(localStorage.getItem(key) ?? '{}');
    return Object.entries(store).filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([p, data]) => ({ id: p.slice(prefix.length), ...data }));
  }, { key: STORE_KEY, prefix: `rooms/${roomId}/sessions/` });
}

module.exports = { test, expect, seed, join, pageWidth, recordTags, parseCsv, storedSessions, roomIdFor };
