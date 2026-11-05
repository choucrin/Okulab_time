// 最初の接触を採時する。Pointer Eventsが届かないスクロール中だけTouch Eventsで補完。
export function bindTimedPress(button, handler, snapshot, freshness = 15000) {
  let contact = null;
  let suppressClick = false;
  const cancelledTouches = new Set();
  let pendingCancelledTouch = null;
  const inside = event => {
    const r = button.getBoundingClientRect();
    return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
  };
  const finish = (candidate, event) => {
    if (button.disabled || candidate.cancelled || Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > 10 || !inside(event) || !candidate.press || performance.now() - candidate.press.perfAt >= freshness) return;
    handler(candidate.press);
  };
  const moved = event => Math.hypot(event.clientX - contact.x, event.clientY - contact.y) > 10;
  button.addEventListener('pointerdown', event => {
    if (button.disabled || contact || (event.pointerType === 'mouse' && event.button !== 0)) return;
    pendingCancelledTouch = null;
    suppressClick = true;
    contact = { kind: 'pointer', id: event.pointerId, pointerType: event.pointerType, touchId: null, x: event.clientX, y: event.clientY, press: snapshot(), cancelled: false };
  }, { passive: true });
  button.addEventListener('pointermove', event => {
    if (contact?.kind === 'pointer' && contact.id === event.pointerId && moved(event)) contact.cancelled = true;
  }, { passive: true });
  button.addEventListener('pointercancel', event => {
    if (!contact) return;
    if (contact.kind === 'pointer' && contact.id !== event.pointerId) return;
    if (contact.kind === 'touch' && event.pointerType === 'mouse') return;
    const id = contact.kind === 'touch' ? contact.id : contact.touchId;
    if (id !== null) cancelledTouches.add(id);
    else if (contact.kind === 'pointer' && contact.pointerType === 'touch') pendingCancelledTouch = { x: contact.x, y: contact.y };
    contact = null;
  }, { passive: true });
  button.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse' && contact?.kind === 'pointer' && contact.id === event.pointerId) contact = null; }, { passive: true });
  button.addEventListener('pointerup', event => {
    if (contact?.kind !== 'pointer' || contact.id !== event.pointerId) return;
    const candidate = contact; contact = null;
    finish(candidate, event);
  }, { passive: true });
  button.addEventListener('touchstart', event => {
    const changed = Array.from(event.changedTouches);
    // pointercancelがtouchstartより先に届いても、同じ接触を復活させない。
    if (pendingCancelledTouch) {
      const touch = changed.find(t => Math.hypot(t.clientX - pendingCancelledTouch.x, t.clientY - pendingCancelledTouch.y) <= 10);
      if (touch) { cancelledTouches.add(touch.identifier); pendingCancelledTouch = null; }
    }
    const touches = changed.filter(t => !cancelledTouches.has(t.identifier));
    if (contact) {
      // 同じ接触のtouchstartでpointerdown時刻を上書きしない。
      if (contact.kind === 'pointer' && contact.pointerType === 'touch' && contact.touchId === null) {
        const touch = touches.find(t => Math.hypot(t.clientX - contact.x, t.clientY - contact.y) <= 10);
        if (touch) contact.touchId = touch.identifier;
      }
      return;
    }
    if (button.disabled) return;
    const touch = touches.find(t => !cancelledTouches.has(t.identifier) && inside(t));
    if (!touch) return;
    suppressClick = true;
    contact = { kind: 'touch', id: touch.identifier, x: touch.clientX, y: touch.clientY, press: snapshot(), cancelled: false };
  }, { passive: true });
  button.addEventListener('touchmove', event => {
    if (!contact) return;
    const id = contact.kind === 'touch' ? contact.id : contact.touchId;
    const touch = Array.from(event.changedTouches).find(t => t.identifier === id);
    if (touch && moved(touch)) contact.cancelled = true;
  }, { passive: true });
  button.addEventListener('touchcancel', event => {
    pendingCancelledTouch = null;
    for (const touch of Array.from(event.changedTouches)) {
      cancelledTouches.delete(touch.identifier);
      if (contact && (contact.kind === 'touch' ? contact.id : contact.touchId) === touch.identifier) contact = null;
    }
  }, { passive: true });
  button.addEventListener('touchend', event => {
    pendingCancelledTouch = null;
    const touches = Array.from(event.changedTouches);
    for (const touch of touches) cancelledTouches.delete(touch.identifier);
    if (!contact) return;
    const id = contact.kind === 'touch' ? contact.id : contact.touchId;
    const touch = touches.find(t => t.identifier === id);
    if (!touch) return;
    const candidate = contact; contact = null;
    finish(candidate, touch);
  }, { passive: true });
  button.addEventListener('click', event => {
    // detail=0 はキーボード/支援技術。ポインタ由来の後続clickは二重に処理しない。
    if (event.detail !== 0 && suppressClick) return;
    if (button.disabled) return;
    const press = snapshot(); if (press) handler(press);
  });
}
