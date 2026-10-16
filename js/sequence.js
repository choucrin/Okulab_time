// 順序は有効試行の完了数だけで決まり、再試行で変化しない。
export function sequenceInteger(value, max, label) {
  if (typeof value === "string" && !/^[0-9]+$/.test(value)) throw new Error(`${label}は半角数字の整数で入力してください。`);
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${label}は1〜${max}で指定してください。`);
  return n;
}

export function validateSequence(steps, sets) {
  if (typeof sets !== "number") throw new Error("セット数が不正です。");
  sequenceInteger(sets, 100, "セット数");
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 30) throw new Error("条件は1〜30件必要です。");
  for (const step of steps) {
    if (!step || typeof step.count !== "number") throw new Error("実施回数が不正です。");
    sequenceInteger(step.count, 50, "実施回数");
    if (!Array.isArray(step.tags) || step.tags.length < 1 || step.tags.length > 20
        || step.tags.some((t) => typeof t !== "string" || t.length > 241 || !/^.+:.+$/.test(t))
        || new Set(step.tags.map((t) => t.slice(0, t.indexOf(":")))).size !== step.tags.length) {
      throw new Error("条件にはジャンルごとに1個、合計1〜20個のラベルが必要です。");
    }
  }
  const perSet = steps.reduce((n, step) => n + step.count, 0);
  const total = perSet * sets;
  if (perSet > 300 || total > 1000) throw new Error("1セットは300回、総試行数は1000回までです。");
  return { perSet, total };
}

export function sequencePosition(steps, sets, done) {
  const { perSet, total } = validateSequence(steps, sets);
  if (!Number.isSafeInteger(done) || done < 0 || done > total) throw new Error("完了数が不正です。");
  if (done === total) return null;
  const within = done % perSet;
  let offset = 0;
  for (let index = 0; index < steps.length; index++) {
    if (within < offset + steps[index].count) return {
      index, set: Math.floor(done / perSet) + 1, position: within + 1,
      repeat: within - offset + 1, tags: [...steps[index].tags],
    };
    offset += steps[index].count;
  }
}

export function validateSequenceRun(run) {
  const { total } = validateSequence(run.steps, run.sets);
  if (run.v !== 1 || typeof run.id !== "string" || !run.id || run.id.length > 128
      || run.total !== total || !Number.isSafeInteger(run.done) || run.done < 0 || run.done > total
      || !Number.isSafeInteger(run.attempts) || run.attempts < run.done
      || !["active", "completed", "interrupted"].includes(run.status)
      || (run.status === "completed") !== (run.done === total)
      || !["free", "sequence"].includes(run.mode)
      || (run.previous !== null && (!Array.isArray(run.previous) || run.previous.some((t) => typeof t !== "string")))) {
    throw new Error("保存済み順序反復の進行状況が不正です。");
  }
  if (run.pending) {
    const p = run.pending, pos = sequencePosition(run.steps, run.sets, run.done);
    if (run.status !== "active" || typeof p.id !== "string" || !p.id || p.trial !== run.done + 1
        || p.receiptVersion !== 1 || p.payload?.mode !== "sequence" || p.payload.sequenceRunId !== run.id
        || p.payload.sequenceTrial !== p.trial || p.payload.sequenceSet !== pos.set
        || p.payload.sequencePosition !== pos.position || JSON.stringify(p.payload.tags) !== JSON.stringify(pos.tags)
        || typeof p.payload.uid !== "string" || !Number.isFinite(p.payload.at)) {
      throw new Error("保存済み開始操作が不正です。");
    }
  }
  return run;
}

// サーバー確定通知だけを呼び出し元で渡す。入力を変更しない。
export function settleSequenceRun(source, record, missingReceipt = false) {
  validateSequenceRun(source);
  const run = structuredClone(source), pending = run.pending;
  if (!pending || pending.id !== record.id || record.sequenceRunId !== run.id) return run;
  const confirmed = record.status === "done" && record.sequenceOutcome === "confirmed";
  const settled = confirmed || (record.status === "done" && record.sequenceOutcome === "discarded")
    || record.status === "aborted" || record.deleted === true || missingReceipt;
  if (!settled) return run;
  if (confirmed) {
    if (pending.trial !== run.done + 1) throw new Error("予定位置が一致しません。");
    run.done = pending.trial;
    run.previous = [...pending.payload.tags];
  }
  if (!missingReceipt) run.attempts++;
  run.pending = null;
  if (run.done === run.total) { run.status = "completed"; run.mode = "free"; }
  return validateSequenceRun(run);
}
