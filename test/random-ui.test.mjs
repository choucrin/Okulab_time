// Developmentの回帰確認。独立したTest工程の受け入れ検証とは別に実施する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readSource, extractFunction } from './support/extract-app-functions.mjs';
import { createSharedLockManager, createLocalStorage, createSharedStorageBackend } from './support/sandbox.mjs';
const source = readSource('js/app.js');
test('試行中止は進行中フラグが別IDまたはnullでも指定した試行IDを送る', async () => {
  assert.match(extractFunction(source, 'initSequence'), /onAbort\(pending.id\)/);
  for (const activeId of ['B', null]) {
    const sent = [];
    const context = vm.createContext({
      state: { roomId: 'room', uid: 'user', busy: false, activeId },
      roomEpoch: 1, db: {}, confirm: () => true,
      withBusy: async fn => fn(), send: async fn => fn(),
      abortSession: async (_db, _room, payload) => {
        sent.push(payload.expectedId);
        return { ok: false, code: 'SESSION_CHANGED' };
      },
      notice() {}, describeCode: code => code,
      applyCurrent() { assert.fail('拒否時に進行中状態を解除しない'); },
    });
    vm.runInContext(extractFunction(source, 'onAbort'), context);
    await vm.runInContext('onAbort("A")', context);
    assert.deepEqual(sent, ['A']);
  }
});
