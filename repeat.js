// Tareas que se repiten. Una repetición es { n, unit } con unit 'day', 'week'
// o 'month' (p. ej. { n: 2, unit: 'week' } = cada 2 semanas), contada desde
// `start` ('AAAA-MM-DD'). Las fechas de la serie se calculan siempre desde
// `start`, así una tarea mensual del día 31 cae el 30 o el 28 en los meses
// cortos y vuelve al 31 después.

const pad = n => String(n).padStart(2, '0');
export const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const dayNumber = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
export const addDaysISO = (s, n) => { const d = fromISO(s); return toISO(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)); };

// Fecha número `k` de la serie (k = 0 es `start`).
export function occurrence(start, repeat, k) {
  const d = fromISO(start);
  if (repeat.unit === 'month') {
    const month = d.getMonth() + k * repeat.n;
    const lastDay = new Date(d.getFullYear(), month + 1, 0).getDate();
    return toISO(new Date(d.getFullYear(), month, Math.min(d.getDate(), lastDay)));
  }
  const step = repeat.n * (repeat.unit === 'week' ? 7 : 1);
  return toISO(new Date(d.getFullYear(), d.getMonth(), d.getDate() + k * step));
}

// Primera fecha de la serie posterior a `after`.
export function nextAfter(start, repeat, after) {
  if (start > after) return start;
  let k;
  if (repeat.unit === 'month') {
    const [y1, m1] = start.split('-').map(Number);
    const [y2, m2] = after.split('-').map(Number);
    k = Math.max(0, Math.floor(((y2 - y1) * 12 + (m2 - m1)) / repeat.n) - 1);
  } else {
    const step = repeat.n * (repeat.unit === 'week' ? 7 : 1);
    k = Math.floor((dayNumber(after) - dayNumber(start)) / step);
  }
  while (occurrence(start, repeat, k) <= after) k++;
  return occurrence(start, repeat, k);
}

// Primera fecha de la serie que sea `date` o posterior.
export const onOrAfter = (start, repeat, date) => nextAfter(start, repeat, addDaysISO(date, -1));

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const UNIT_NAMES = { day: ['día', 'días'], week: ['semana', 'semanas'], month: ['mes', 'meses'] };

export function repeatLabel(repeat, start) {
  const [one, many] = UNIT_NAMES[repeat.unit];
  const every = repeat.n === 1 ? `Cada ${one}` : `Cada ${repeat.n} ${many}`;
  if (!start || repeat.unit === 'day') return every;
  const d = fromISO(start);
  return repeat.unit === 'week' ? `${every} (${WEEKDAYS[d.getDay()]})` : `${every} (día ${d.getDate()})`;
}

// Opciones del desplegable; 'custom' deja elegir número y unidad.
export const PRESETS = [
  ['none', 'No se repite'],
  ['1-day', 'Cada día'],
  ['1-week', 'Cada semana'],
  ['2-week', 'Cada 2 semanas'],
  ['1-month', 'Cada mes'],
  ['custom', 'Otra…'],
];

export function presetOf(repeat) {
  if (!repeat) return 'none';
  const key = `${repeat.n}-${repeat.unit}`;
  return PRESETS.some(([k]) => k === key) ? key : 'custom';
}

// Del borrador del formulario ({ preset, n, unit }) a la repetición, o null.
export function repeatFromDraft(draft) {
  if (draft.preset === 'none') return null;
  if (draft.preset === 'custom') {
    const n = Math.max(1, Math.min(365, parseInt(draft.n, 10) || 1));
    return { n, unit: ['day', 'week', 'month'].includes(draft.unit) ? draft.unit : 'week' };
  }
  const [n, unit] = draft.preset.split('-');
  return { n: Number(n), unit };
}
