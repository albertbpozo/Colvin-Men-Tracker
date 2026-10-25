const STORAGE_KEY = 'menu-semanal-v1';
const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const MEALS = ['Desayuno', 'Comida', 'Merienda', 'Cena'];
const SHOPPING = 'compra';

const uid = () => Math.random().toString(36).slice(2, 10);

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (data && data.days) return data;
  } catch (e) { /* datos corruptos o almacenamiento no disponible */ }
  return { days: Object.fromEntries(DAYS.map(d => [d, []])) };
}

let state = load();
let current = DAYS[(new Date().getDay() + 6) % 7]; // lunes = 0

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* sin persistencia */ }
  render();
}

const missingCount = entries =>
  entries.reduce((n, e) => n + e.ingredients.filter(i => !i.have).length, 0);

function findEntry(day, id) {
  return state.days[day].find(e => e.id === id);
}

// ---------- Render ----------

function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  const make = (key, label, badge) => {
    const b = document.createElement('button');
    b.className = 'tab';
    b.setAttribute('aria-selected', String(current === key));
    b.textContent = label;
    if (badge) {
      const s = document.createElement('span');
      s.className = 'badge';
      s.textContent = badge;
      b.append(s);
    }
    b.onclick = () => { current = key; render(); };
    tabs.append(b);
  };
  DAYS.forEach(d => make(d, d.slice(0, 3), missingCount(state.days[d])));
  const totalMissing = DAYS.reduce((n, d) => n + missingCount(state.days[d]), 0);
  make(SHOPPING, '🛒 Lista de compra', totalMissing);
}

function renderDay(day) {
  const view = document.getElementById('view');
  view.innerHTML = '';

  const h = document.createElement('h2');
  h.textContent = day;
  view.append(h);

  const form = document.createElement('form');
  form.className = 'add-entry';
  form.innerHTML = `
    <select name="meal">${MEALS.map(m => `<option>${m}</option>`).join('')}</select>
    <input name="dish" placeholder="Nombre del plato (p. ej. Lentejas)" autocomplete="off" required>
    <button type="submit">Añadir plato</button>`;
  form.onsubmit = ev => {
    ev.preventDefault();
    const dish = form.dish.value.trim();
    if (!dish) return;
    state.days[day].push({ id: uid(), meal: form.meal.value, name: dish, ingredients: [] });
    state.days[day].sort((a, b) => MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal));
    save();
    view.querySelector('.add-entry input[name="dish"]')?.focus();
  };
  view.append(form);

  const entries = state.days[day];
  if (!entries.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Aún no hay platos para este día.';
    view.append(p);
    return;
  }

  const tpl = document.getElementById('entry-template');
  entries.forEach(entry => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.querySelector('.meal').textContent = entry.meal;
    node.querySelector('.dish').textContent = entry.name;

    const missing = entry.ingredients.filter(i => !i.have).length;
    const counter = node.querySelector('.counter');
    if (entry.ingredients.length) {
      counter.textContent = missing ? `Faltan ${missing}` : 'Todo listo ✓';
      counter.classList.toggle('has-missing', missing > 0);
    }

    node.querySelector('.delete-entry').onclick = () => {
      if (!confirm(`¿Eliminar "${entry.name}"?`)) return;
      state.days[day] = state.days[day].filter(e => e.id !== entry.id);
      save();
    };

    const list = node.querySelector('.ingredients');
    entry.ingredients.forEach(ing => list.append(ingredientRow(day, entry.id, ing)));

    const addForm = node.querySelector('.add-ingredient');
    addForm.onsubmit = ev => {
      ev.preventDefault();
      const name = addForm.ingredient.value.trim();
      if (!name) return;
      findEntry(day, entry.id).ingredients.push({ id: uid(), name, have: false });
      save();
      document.querySelector(`[data-entry="${entry.id}"] .add-ingredient input`)?.focus();
    };
    node.dataset.entry = entry.id;
    view.append(node);
  });
}

function ingredientRow(day, entryId, ing) {
  const li = document.createElement('li');

  const status = document.createElement('button');
  status.className = `status ${ing.have ? 'have' : 'missing'}`;
  status.textContent = ing.have ? 'Tengo' : 'Falta';
  status.title = 'Pulsa para cambiar';
  status.onclick = () => { ing.have = !ing.have; save(); };

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = ing.name;

  const del = document.createElement('button');
  del.className = 'icon';
  del.textContent = '✕';
  del.title = 'Quitar ingrediente';
  del.onclick = () => {
    const entry = findEntry(day, entryId);
    entry.ingredients = entry.ingredients.filter(i => i.id !== ing.id);
    save();
  };

  li.append(status, name, del);
  return li;
}

function renderShopping() {
  const view = document.getElementById('view');
  view.innerHTML = '';

  const h = document.createElement('h2');
  h.textContent = 'Lista de compra (ingredientes que faltan)';
  view.append(h);

  // Agrupa por nombre de ingrediente (sin distinguir mayúsculas)
  const groups = new Map();
  DAYS.forEach(day => state.days[day].forEach(entry => entry.ingredients.forEach(ing => {
    if (ing.have) return;
    const key = ing.name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: ing.name, items: [] });
    groups.get(key).items.push({ ing, where: `${day.slice(0, 3)} · ${entry.name}` });
  })));

  if (!groups.size) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '¡No falta nada! Tienes todos los ingredientes.';
    view.append(p);
  } else {
    const ul = document.createElement('ul');
    ul.className = 'ingredients shopping entry';
    [...groups.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
      .forEach(g => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.className = 'status missing';
        btn.textContent = 'Comprado';
        btn.title = 'Marcar como que ya lo tienes';
        btn.onclick = () => { g.items.forEach(i => { i.ing.have = true; }); save(); };

        const text = document.createElement('div');
        text.className = 'name';
        const n = document.createElement('div');
        n.textContent = g.name;
        const w = document.createElement('div');
        w.className = 'where';
        w.textContent = g.items.map(i => i.where).join(', ');
        text.append(n, w);

        li.append(text, btn);
        ul.append(li);
      });
    view.append(ul);
  }

  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  const reset = document.createElement('button');
  reset.textContent = 'Vaciar menú de la semana';
  reset.onclick = () => {
    if (!confirm('¿Borrar todos los platos de la semana?')) return;
    state = { days: Object.fromEntries(DAYS.map(d => [d, []])) };
    save();
  };
  toolbar.append(reset);
  view.append(toolbar);
}

function render() {
  renderTabs();
  if (current === SHOPPING) renderShopping();
  else renderDay(current);
}

render();
