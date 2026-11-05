// 単一記録のサーバー確認・停止検知・決着再試行。退出後の遅延応答は無効化する。
export function watchSequenceRecord({ subscribe, fetch, apply, reload, report, interval = 45000, timeout = 8000 }) {
  let stopped = false, unsubscribe, retryTimer, pollTimer, attempts = 0, generation = 0, exhausted = false, transportFailures = 0;
  let queue = Promise.resolve();
  const error = err => report((err?.message ?? String(err)) + ' 状態を再確認してください。');
  const receive = record => {
    const token = generation;
    queue = queue.then(async () => {
      if (stopped || exhausted || token !== generation) return;
      await apply(record);
      attempts = 0;
    }).catch(err => {
      if (stopped || exhausted || token !== generation) return;
      error(err);
      if (attempts >= 5) { exhausted = true; clearTimeout(pollTimer); unsubscribe?.(); return; }
      if (retryTimer) return;
      const delay = Math.min(1000 * 2 ** attempts++, 15000);
      retryTimer = setTimeout(async () => {
        retryTimer = null;
        if (stopped) return;
        try { await reload(); } catch (failure) { error(failure); }
        receive(record);
      }, delay);
      retryTimer.unref?.();
    });
  };
  const attach = () => {
    if (stopped || exhausted) return;
    unsubscribe?.();
    unsubscribe = subscribe(receive, err => { if (!stopped) error(err); });
  };
  const poll = async () => {
    if (stopped || exhausted) return;
    let timer;
    try {
      const record = await Promise.race([fetch(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('記録のサーバー確認が時間切れになりました。')), timeout); })]);
      if (stopped) return;
      transportFailures = 0;
      receive(record);
      attach();
    } catch (err) { if (!stopped) { error(err); if (++transportFailures >= 8) { exhausted = true; unsubscribe?.(); } } }
    finally { clearTimeout(timer); if (!stopped && !exhausted) { pollTimer = setTimeout(poll, interval); pollTimer.unref?.(); } }
  };
  attach();
  pollTimer = setTimeout(poll, interval);
  pollTimer.unref?.();
  return () => { stopped = true; generation++; unsubscribe?.(); clearTimeout(retryTimer); clearTimeout(pollTimer); };
}
