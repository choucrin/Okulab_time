const KEY = 'okulab-time/free-label';
export function bindFreeLabel(input, hint, storage, window, document) {
  const read = raw => {
    const data = JSON.parse(raw ?? 'null');
    return data?.v === 1 && typeof data.value === 'string' && data.value.length <= 80 ? data.value : '';
  };
  const unavailable = () => { hint.textContent = 'この端末に保存できません(再読み込み後は復元されません)'; };
  let raw;
  try { raw = storage.getItem(KEY); } catch { unavailable(); }
  try { input.value = read(raw); } catch { input.value = ''; }
  input.addEventListener('input', () => {
    try { storage.setItem(KEY, JSON.stringify({ v: 1, value: input.value })); hint.textContent = ''; }
    catch { unavailable(); }
  });
  window.addEventListener('storage', event => {
    if (event.key !== KEY || document.activeElement === input) return;
    try { input.value = read(event.newValue); } catch { /* 破損した他タブの値で入力を上書きしない */ }
  });
}
