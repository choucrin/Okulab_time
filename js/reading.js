import { READING_SET } from './reading-config.js';
import { PASSAGES } from './passages.js';
import { LONG_PASSAGES } from './passages-long.js';

export function readingDataset(value = READING_SET) {
  return value === 'short'
    ? { key: 'okulab-time/passages', passages: PASSAGES.map((text, id) => ({ id, paragraphs: [text] })) }
    : { key: 'okulab-time/passages/long', passages: LONG_PASSAGES };
}

export function validShown(values, passages) {
  const allowed = new Set(passages.map((p) => p.id));
  return Array.isArray(values) ? [...new Set(values.filter((id) => allowed.has(id)))] : [];
}

export function selectReading(passages, history, random = Math.random) {
  let shown = validShown(history, passages);
  let available = passages.filter((p) => !shown.includes(p.id));
  if (!available.length) {
    shown = shown.length ? [shown.at(-1)] : [];
    available = passages.filter((p) => !shown.includes(p.id));
  }
  const passage = (available.length ? available : passages)[Math.floor(random() * (available.length || passages.length))];
  return { passage, shown: [...shown, passage.id] };
}
