// Almacenamiento en el navegador (modo sin Firebase).
const STORAGE_KEY = 'menu-semanal-v1';

const uid = () => Math.random().toString(36).slice(2, 10);

export function createLocalStore(days, { onData }) {
  const empty = () => Object.fromEntries(days.map(d => [d, []]));

  let data = empty();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.days) data = { ...empty(), ...saved.days };
  } catch (e) { /* datos corruptos o almacenamiento no disponible */ }

  const commit = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ days: data })); } catch (e) { /* sin persistencia */ }
    onData(data);
  };
  const find = (day, id) => data[day].find(e => e.id === id);

  queueMicrotask(() => onData(data));

  return {
    addEntry(day, meal, name) {
      data[day].push({ id: uid(), meal, name, ingredients: [], createdAt: Date.now() });
      commit();
    },
    deleteEntry(day, entry) {
      data[day] = data[day].filter(e => e.id !== entry.id);
      commit();
    },
    setIngredients(day, entry, ingredients) {
      const e = find(day, entry.id);
      if (e) e.ingredients = ingredients;
      commit();
    },
    resetWeek() {
      data = empty();
      commit();
    },
  };
}

export const newIngredientId = uid;
