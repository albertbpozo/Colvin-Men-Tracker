import { firebaseConfig } from './firebase-config.js';
import { createLocalStore, newIngredientId } from './local-store.js';

const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const MEALS = ['Desayuno', 'Comida', 'Merienda', 'Cena'];
const SHOPPING = 'compra';
const SHARING = 'compartir';

let days = Object.fromEntries(DAYS.map(d => [d, []]));
let current = DAYS[(new Date().getDay() + 6) % 7]; // lunes = 0
let lastMeal = MEALS[0];
// En modo local no hay sesión; con Firebase guarda el estado de acceso.
let session = firebaseConfig ? { status: 'loading' } : null;
let errorMessage = '';
let store;

const handlers = {
  onData(data) { days = data; render(); },
  onStatus(s) { session = s; errorMessage = ''; render(); },
  onError(err) {
    console.error(err);
    errorMessage = err.during === 'sign-in' ? 'No se pudo iniciar sesión. Inténtalo de nuevo.'
      : err.code === 'permission-denied' ? 'No tienes permiso para hacer este cambio.'
      : 'No se pudo guardar el cambio. Inténtalo de nuevo.';
    render();
    setTimeout(() => { errorMessage = ''; render(); }, 6000);
  },
};

const missingCount = entries =>
  entries.reduce((n, e) => n + e.ingredients.filter(i => !i.have).length, 0);

const sortEntries = entries => [...entries].sort((a, b) =>
  MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal) || (a.createdAt || 0) - (b.createdAt || 0));

const isOwner = () => session?.status === 'ready' && session.email === session.owner;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// ---------- Render ----------

function renderAccount() {
  const box = document.getElementById('account');
  box.innerHTML = '';
  if (!session || !session.email) return;
  box.append(
    el('span', { className: 'email', textContent: session.email }),
    el('button', { textContent: 'Salir', onclick: () => store.signOut() }),
  );
}

function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  if (session && session.status !== 'ready') return;

  const make = (key, label, badge) => {
    const b = el('button', { className: 'tab', textContent: label, onclick: () => { current = key; render(); } });
    b.setAttribute('aria-selected', String(current === key));
    if (badge) b.append(el('span', { className: 'badge', textContent: badge }));
    tabs.append(b);
  };
  DAYS.forEach(d => make(d, d.slice(0, 3), missingCount(days[d])));
  const totalMissing = DAYS.reduce((n, d) => n + missingCount(days[d]), 0);
  make(SHOPPING, '🛒 Lista de compra', totalMissing);
  if (isOwner()) make(SHARING, '👥 Compartir');
}

function renderGate(view) {
  const gate = el('div', { className: 'gate' });
  if (session.status === 'signed-out') {
    gate.append(
      el('p', { textContent: 'Entra con tu cuenta de Google para ver el menú compartido.' }),
      el('button', { className: 'primary', textContent: 'Entrar con Google', onclick: () => store.signIn() }),
    );
  } else if (session.status === 'denied') {
    gate.append(
      el('p', { textContent: `La cuenta ${session.email} no tiene acceso a este menú.` }),
      el('p', { textContent: 'Pide a quien lo creó que añada tu email en «Compartir».' }),
      el('button', { textContent: 'Entrar con otra cuenta', onclick: () => store.signOut() }),
    );
  } else {
    gate.append(el('p', { textContent: 'Cargando…' }));
  }
  view.append(gate);
}

function renderDay(view, day) {
  view.append(el('h2', { textContent: day }));

  const form = el('form', { className: 'add-entry' });
  form.innerHTML = `
    <select name="meal">${MEALS.map(m => `<option${m === lastMeal ? ' selected' : ''}>${m}</option>`).join('')}</select>
    <input name="dish" data-focus-key="dish" placeholder="Nombre del plato (p. ej. Lentejas)" autocomplete="off" required>
    <button type="submit">Añadir plato</button>`;
  form.meal.onchange = () => { lastMeal = form.meal.value; };
  form.onsubmit = ev => {
    ev.preventDefault();
    const dish = form.dish.value.trim();
    if (!dish) return;
    form.dish.value = '';
    store.addEntry(day, form.meal.value, dish);
  };
  view.append(form);

  const entries = sortEntries(days[day]);
  if (!entries.length) {
    view.append(el('p', { className: 'empty', textContent: 'Aún no hay platos para este día.' }));
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
      if (confirm(`¿Eliminar "${entry.name}"?`)) store.deleteEntry(day, entry);
    };

    const list = node.querySelector('.ingredients');
    entry.ingredients.forEach(ing => list.append(ingredientRow(day, entry, ing)));

    const addForm = node.querySelector('.add-ingredient');
    addForm.ingredient.dataset.focusKey = `ing-${entry.id}`;
    addForm.onsubmit = ev => {
      ev.preventDefault();
      const name = addForm.ingredient.value.trim();
      if (!name) return;
      addForm.ingredient.value = '';
      store.setIngredients(day, entry, [...entry.ingredients, { id: newIngredientId(), name, have: false }]);
    };
    view.append(node);
  });
}

function ingredientRow(day, entry, ing) {
  const status = el('button', {
    className: `status ${ing.have ? 'have' : 'missing'}`,
    textContent: ing.have ? 'Tengo' : 'Falta',
    title: 'Pulsa para cambiar',
    onclick: () => store.setIngredients(day, entry,
      entry.ingredients.map(i => i.id === ing.id ? { ...i, have: !i.have } : i)),
  });
  const del = el('button', {
    className: 'icon',
    textContent: '✕',
    title: 'Quitar ingrediente',
    onclick: () => store.setIngredients(day, entry, entry.ingredients.filter(i => i.id !== ing.id)),
  });
  return el('li', {}, status, el('span', { className: 'name', textContent: ing.name }), del);
}

function renderShopping(view) {
  view.append(el('h2', { textContent: 'Lista de compra (ingredientes que faltan)' }));

  // Agrupa por nombre de ingrediente (sin distinguir mayúsculas)
  const groups = new Map();
  DAYS.forEach(day => days[day].forEach(entry => entry.ingredients.forEach(ing => {
    if (ing.have) return;
    const key = ing.name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: ing.name, items: [] });
    groups.get(key).items.push({ day, entry, where: `${day.slice(0, 3)} · ${entry.name}` });
  })));

  if (!groups.size) {
    view.append(el('p', { className: 'empty', textContent: '¡No falta nada! Tienes todos los ingredientes.' }));
  } else {
    const ul = el('ul', { className: 'ingredients shopping entry' });
    [...groups.entries()]
      .sort(([, a], [, b]) => a.name.localeCompare(b.name, 'es'))
      .forEach(([key, g]) => {
        const bought = el('button', {
          className: 'status missing',
          textContent: 'Comprado',
          title: 'Marcar como que ya lo tienes',
          onclick: () => {
            const seen = new Set();
            g.items.forEach(({ day, entry }) => {
              if (seen.has(entry.id)) return;
              seen.add(entry.id);
              store.setIngredients(day, entry, entry.ingredients.map(i =>
                i.name.toLowerCase() === key ? { ...i, have: true } : i));
            });
          },
        });
        const text = el('div', { className: 'name' },
          el('div', { textContent: g.name }),
          el('div', { className: 'where', textContent: g.items.map(i => i.where).join(', ') }));
        ul.append(el('li', {}, text, bought));
      });
    view.append(ul);
  }

  const reset = el('button', {
    textContent: 'Vaciar menú de la semana',
    onclick: () => { if (confirm('¿Borrar todos los platos de la semana?')) store.resetWeek(); },
  });
  view.append(el('div', { className: 'toolbar' }, reset));
}

function renderSharing(view) {
  view.append(
    el('h2', { textContent: 'Compartir' }),
    el('p', { className: 'hint', textContent: 'Estas personas pueden ver y editar el menú entrando con su cuenta de Google. Envíales el enlace: ' },
      el('code', { textContent: location.origin + location.pathname })),
  );

  const ul = el('ul', { className: 'ingredients members entry' });
  ul.append(el('li', {}, el('span', { className: 'name', textContent: session.owner }),
    el('span', { className: 'role', textContent: 'Propietario' })));
  session.members.forEach(email => ul.append(el('li', {},
    el('span', { className: 'name', textContent: email }),
    el('button', {
      className: 'icon', textContent: '✕', title: 'Quitar acceso',
      onclick: () => {
        if (confirm(`¿Quitar el acceso a ${email}?`)) store.setMembers(session.members.filter(m => m !== email));
      },
    }))));
  view.append(ul);

  const form = el('form');
  form.innerHTML = `
    <input name="email" type="email" data-focus-key="member" placeholder="Email de Google (p. ej. ana@gmail.com)" autocomplete="off" required>
    <button type="submit">Dar acceso</button>`;
  form.onsubmit = ev => {
    ev.preventDefault();
    const email = form.email.value.trim().toLowerCase();
    if (!email || email === session.owner || session.members.includes(email)) return;
    form.email.value = '';
    store.setMembers([...session.members, email]);
  };
  view.append(form);
}

function render() {
  // Conserva el foco y lo escrito: la vista se redibuja también cuando otra persona cambia algo.
  const active = document.activeElement;
  const focusKey = active?.dataset?.focusKey;
  const typed = active?.value;

  renderAccount();
  renderTabs();
  const view = document.getElementById('view');
  view.innerHTML = '';
  if (errorMessage) view.append(el('p', { className: 'error', textContent: errorMessage }));

  if (session && session.status !== 'ready') renderGate(view);
  else if (current === SHOPPING) renderShopping(view);
  else if (current === SHARING && isOwner()) renderSharing(view);
  else renderDay(view, DAYS.includes(current) ? current : (current = DAYS[0]));

  if (focusKey) {
    const target = view.querySelector(`[data-focus-key="${focusKey}"]`);
    if (target) { target.value = typed ?? ''; target.focus(); }
  }
}

if (firebaseConfig) {
  render();
  try {
    const { createFirebaseStore } = await import('./firebase-store.js');
    store = await createFirebaseStore(firebaseConfig, DAYS, handlers);
  } catch (err) {
    console.error(err);
    document.getElementById('view').textContent = 'No se pudo conectar. Comprueba tu conexión a internet y recarga la página.';
  }
} else {
  store = createLocalStore(DAYS, handlers);
}
