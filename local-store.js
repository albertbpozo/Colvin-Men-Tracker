// Almacenamiento en el navegador (modo sin Firebase).
const STORAGE_KEY = 'menu-semanal-v2';
const LEGACY_KEY = 'menu-semanal-v1';

const uid = () => Math.random().toString(36).slice(2, 10);

// `byDate` guarda los platos por fecha 'AAAA-MM-DD'. La versión anterior los
// guardaba por nombre de día ('Lunes'…); `legacyDay` lo traduce a una fecha.
export function createLocalStore({ onData, legacyDay }) {
  let byDate = {};
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.byDate) byDate = saved.byDate;
    else {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY));
      Object.entries(legacy?.days || {}).forEach(([name, entries]) => {
        const date = legacyDay(name);
        if (date && entries.length) byDate[date] = entries;
      });
    }
  } catch (e) { /* datos corruptos o almacenamiento no disponible */ }

  let week = [];
  const emit = () => onData(Object.fromEntries(week.map(d => [d, byDate[d] || []])));
  const commit = () => {
    Object.keys(byDate).forEach(d => { if (!byDate[d].length) delete byDate[d]; });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ byDate })); } catch (e) { /* sin persistencia */ }
    emit();
  };
  const find = (date, id) => (byDate[date] || []).find(e => e.id === id);

  return {
    setWeek(dates) {
      week = dates;
      emit();
    },
    addEntry(date, meal, name) {
      (byDate[date] ||= []).push({ id: uid(), meal, name, ingredients: [], createdAt: Date.now() });
      commit();
    },
    deleteEntry(date, entry) {
      byDate[date] = (byDate[date] || []).filter(e => e.id !== entry.id);
      commit();
    },
    setIngredients(date, entry, ingredients) {
      const e = find(date, entry.id);
      if (e) e.ingredients = ingredients;
      commit();
    },
    resetWeek() {
      week.forEach(d => delete byDate[d]);
      commit();
    },
  };
}

export const newIngredientId = uid;
