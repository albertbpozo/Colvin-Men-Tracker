// Almacenamiento en el navegador (modo sin Firebase).
const STORAGE_KEY = 'menu-semanal-v2';
const LEGACY_KEY = 'menu-semanal-v1';
const GENERAL_KEY = 'menu-semanal-compra';
const BOUGHT_KEY = 'menu-semanal-comprado';
const PHOTOS_KEY = 'menu-semanal-fotos';
const TASKS_KEY = 'menu-semanal-tareas';

const uid = () => Math.random().toString(36).slice(2, 10);

// `byDate` guarda los platos por fecha 'AAAA-MM-DD'. La versión anterior los
// guardaba por nombre de día ('Lunes'…); `legacyDay` lo traduce a una fecha.
export function createLocalStore({ onData, onGeneral, onBought, onPhotos, onTasks, legacyDay }) {
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

  let general = [];
  try { general = JSON.parse(localStorage.getItem(GENERAL_KEY)) || []; } catch (e) { /* sin datos */ }
  queueMicrotask(() => onGeneral(general));

  let bought = [];
  try { bought = JSON.parse(localStorage.getItem(BOUGHT_KEY)) || []; } catch (e) { /* sin datos */ }
  const saveBought = list => {
    bought = list;
    try { localStorage.setItem(BOUGHT_KEY, JSON.stringify(bought)); } catch (e) { /* sin persistencia */ }
    onBought(bought);
  };
  queueMicrotask(() => onBought(bought));

  let photos = {};
  try { photos = JSON.parse(localStorage.getItem(PHOTOS_KEY)) || {}; } catch (e) { /* sin datos */ }
  queueMicrotask(() => onPhotos(photos));

  let tasks = [];
  try { tasks = JSON.parse(localStorage.getItem(TASKS_KEY)) || []; } catch (e) { /* sin datos */ }
  const saveTasks = list => {
    tasks = list;
    try { localStorage.setItem(TASKS_KEY, JSON.stringify(tasks)); } catch (e) { /* sin persistencia */ }
    onTasks(tasks);
  };
  queueMicrotask(() => onTasks(tasks));

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
    setGeneral(items) {
      general = items;
      try { localStorage.setItem(GENERAL_KEY, JSON.stringify(general)); } catch (e) { /* sin persistencia */ }
      onGeneral(general);
    },
    addBought(record) { saveBought([...bought, record]); },
    removeBought(record) { saveBought(bought.filter(r => r.id !== record.id)); },
    clearBought() { saveBought([]); },
    setPhoto(key, name, photo) {
      photos = { ...photos };
      if (photo) photos[key] = photo;
      else delete photos[key];
      try { localStorage.setItem(PHOTOS_KEY, JSON.stringify(photos)); } catch (e) { /* sin espacio: solo esta sesión */ }
      onPhotos(photos);
    },
    addTask(task) { saveTasks([...tasks, { id: uid(), ...task }]); },
    updateTask(id, changes) { saveTasks(tasks.map(t => t.id === id ? { ...t, ...changes } : t)); },
    deleteTask(id) { saveTasks(tasks.filter(t => t.id !== id)); },
    resetWeek() {
      week.forEach(d => delete byDate[d]);
      commit();
    },
  };
}

export const newIngredientId = uid;
