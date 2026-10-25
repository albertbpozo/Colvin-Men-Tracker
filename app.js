// El ?v= obliga al navegador a descargar la versión nueva tras cada cambio;
// súbelo a la vez en index.html y aquí.
import { firebaseConfig } from './firebase-config.js?v=6';
import { createLocalStore, newIngredientId } from './local-store.js?v=6';

const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const MEALS = ['Desayuno', 'Comida', 'Merienda', 'Cena'];
const SHOPPING = 'compra';
const SHARING = 'compartir';

// ---------- Fechas (siempre en hora local, como 'AAAA-MM-DD') ----------

const pad = n => String(n).padStart(2, '0');
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const weekdayIndex = d => (d.getDay() + 6) % 7; // lunes = 0
const mondayOf = d => addDays(d, -weekdayIndex(d));
const weekOf = monday => DAY_NAMES.map((_, i) => toISO(addDays(monday, i)));
const todayISO = () => toISO(new Date());

const shortDate = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });
const dayShort = iso => `${DAY_NAMES[weekdayIndex(fromISO(iso))].slice(0, 3)} ${fromISO(iso).getDate()}`;
const dayLong = iso => {
  const text = fromISO(iso).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  return text[0].toUpperCase() + text.slice(1);
};
const weekLabel = () => `${shortDate.format(fromISO(week[0]))} – ${shortDate.format(fromISO(week[6]))}`;

// Los platos antiguos se guardaban por nombre de día: se pasan a la semana actual.
const legacyDay = name => {
  const i = DAY_NAMES.indexOf(name);
  return i < 0 ? undefined : toISO(addDays(mondayOf(new Date()), i));
};

let week = weekOf(mondayOf(new Date()));
let days = {};
let general = []; // lista de compra general, la misma para todas las semanas
let current = todayISO();
let lastMeal = MEALS[0];
// En modo local no hay sesión; con Firebase guarda el estado de acceso.
let session = firebaseConfig ? { status: 'loading' } : null;
let errorMessage = '';
let focusNext = null; // campo que debe recibir el foco tras el próximo redibujado
let store;

const handlers = {
  onData(data) { days = data; render(); },
  onGeneral(items) { general = items; render(); },
  onStatus(s) { session = s; errorMessage = ''; render(); },
  onError(err) {
    console.error(err);
    errorMessage = err.during === 'sign-in' ? signInMessage(err)
      : err.code === 'permission-denied' ? 'No tienes permiso para hacer este cambio.'
      : 'No se pudo guardar el cambio. Inténtalo de nuevo.';
    render();
    if (err.during !== 'sign-in') setTimeout(() => { errorMessage = ''; render(); }, 6000);
  },
};

function signInMessage(err) {
  const reasons = {
    'auth/unauthorized-domain': 'Este dominio no está autorizado en Firebase (Authentication → Settings → Authorized domains).',
    'auth/operation-not-allowed': 'El inicio de sesión con Google no está activado en Firebase (Authentication → Sign-in method).',
    'auth/network-request-failed': 'Sin conexión con Google. Comprueba tu internet.',
    'auth/web-storage-unsupported': 'El navegador bloquea el almacenamiento. Desactiva el modo privado o ábrelo en Chrome/Safari.',
  };
  return `No se pudo iniciar sesión. ${reasons[err.code] || 'Inténtalo de nuevo.'} (código: ${err.code || err.message})`;
}

const missingCount = (entries = []) =>
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

function goToWeek(monday, selectToday = false) {
  const offset = week.indexOf(current);
  week = weekOf(monday);
  days = {};
  if (selectToday) current = todayISO();
  else if (offset >= 0) current = week[offset];
  store?.setWeek(week);
  render();
}

function renderWeekNav() {
  const nav = document.getElementById('week-nav');
  nav.innerHTML = '';
  if (session && session.status !== 'ready') return;
  const monday = fromISO(week[0]);
  const isThisWeek = week.includes(todayISO());
  nav.append(
    el('button', { className: 'icon', textContent: '‹', title: 'Semana anterior', onclick: () => goToWeek(addDays(monday, -7)) }),
    el('span', { className: 'week-label', textContent: weekLabel() + (isThisWeek ? ' · esta semana' : '') }),
    el('button', { className: 'icon', textContent: '›', title: 'Semana siguiente', onclick: () => goToWeek(addDays(monday, 7)) }),
  );
  if (!isThisWeek) {
    nav.append(el('button', { className: 'today-btn', textContent: 'Hoy', onclick: () => goToWeek(mondayOf(new Date()), true) }));
  }
}

function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  if (session && session.status !== 'ready') return;

  const make = (key, label, badge, isToday) => {
    const b = el('button', { className: isToday ? 'tab today' : 'tab', textContent: label, onclick: () => { current = key; render(); } });
    b.setAttribute('aria-selected', String(current === key));
    if (badge) b.append(el('span', { className: 'badge', textContent: badge }));
    tabs.append(b);
  };
  week.forEach(d => make(d, dayShort(d), missingCount(days[d]), d === todayISO()));
  const totalMissing = general.length + week.reduce((n, d) => n + missingCount(days[d]), 0);
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
  view.append(el('h2', { textContent: dayLong(day) + (day === todayISO() ? ' · hoy' : '') }));

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

  const entries = sortEntries(days[day] || []);
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
    addForm.qty.dataset.focusKey = `qty-${entry.id}`;
    addForm.onsubmit = ev => {
      ev.preventDefault();
      const name = addForm.ingredient.value.trim();
      if (!name) return;
      const qty = addForm.qty.value.trim();
      addForm.ingredient.value = addForm.qty.value = '';
      focusNext = `ing-${entry.id}`;
      store.setIngredients(day, entry, [...entry.ingredients, { id: newIngredientId(), name, qty, have: false }]);
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
  const qty = el('button', {
    className: ing.qty ? 'qty' : 'qty empty-qty',
    textContent: ing.qty || '+ cantidad',
    title: 'Cambiar cantidad',
    onclick: () => {
      const value = prompt(`Cantidad de ${ing.name}:`, ing.qty || '');
      if (value === null) return;
      store.setIngredients(day, entry,
        entry.ingredients.map(i => i.id === ing.id ? { ...i, qty: value.trim() } : i));
    },
  });
  return el('li', {}, status, el('span', { className: 'name', textContent: ing.name }), qty, del);
}

const withQty = (text, qty) => qty ? `${text} (${qty})` : text;

function renderShopping(view) {
  // ---- Lista general: productos sueltos, igual para todas las semanas ----
  view.append(el('h2', { textContent: 'Lista de compra general' }));
  const form = el('form', { className: 'add-extra' });
  form.innerHTML = `
    <input name="item" data-focus-key="extra" placeholder="Añadir (p. ej. Leche)" autocomplete="off" required>
    <input name="qty" data-focus-key="extra-qty" class="qty-input" placeholder="Cantidad" autocomplete="off">
    <button type="submit">Añadir</button>`;
  form.onsubmit = ev => {
    ev.preventDefault();
    const name = form.item.value.trim();
    if (!name) return;
    const item = { id: newIngredientId(), name, qty: form.qty.value.trim() };
    form.item.value = form.qty.value = '';
    focusNext = 'extra';
    store.setGeneral([...general, item]);
  };
  view.append(form);

  if (!general.length) {
    view.append(el('p', { className: 'empty', textContent: 'La lista general está vacía.' }));
  } else {
    const ul = el('ul', { className: 'ingredients shopping entry' });
    general.forEach(item => {
      const qty = el('button', {
        className: item.qty ? 'qty' : 'qty empty-qty',
        textContent: item.qty || '+ cantidad',
        title: 'Cambiar cantidad',
        onclick: () => {
          const value = prompt(`Cantidad de ${item.name}:`, item.qty || '');
          if (value !== null) store.setGeneral(general.map(i => i.id === item.id ? { ...i, qty: value.trim() } : i));
        },
      });
      const bought = el('button', {
        className: 'status missing', textContent: 'Comprado', title: 'Quitar de la lista',
        onclick: () => store.setGeneral(general.filter(i => i.id !== item.id)),
      });
      ul.append(el('li', {}, el('span', { className: 'name', textContent: item.name }), qty, bought));
    });
    view.append(ul);
  }

  // ---- Lo que falta para el menú de la semana visible ----
  view.append(
    el('h2', { className: 'section', textContent: 'Para el menú de la semana' }),
    el('p', { className: 'hint', textContent: `Ingredientes que faltan para la semana del ${weekLabel()}.` }),
  );

  // Agrupa por nombre de ingrediente (sin distinguir mayúsculas)
  const groups = new Map();
  week.forEach(day => (days[day] || []).forEach(entry => entry.ingredients.forEach(ing => {
    if (ing.have) return;
    const key = ing.name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: ing.name, items: [] });
    groups.get(key).items.push({ day, entry, qty: ing.qty, where: withQty(`${dayShort(day)} · ${entry.name}`, ing.qty) });
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
        const qtys = g.items.map(i => i.qty).filter(Boolean);
        const text = el('div', { className: 'name' },
          el('div', {}, g.name, qtys.length ? el('span', { className: 'qty-tag', textContent: qtys.join(' + ') }) : ''),
          el('div', { className: 'where', textContent: g.items.map(i => i.where).join(', ') }));
        ul.append(el('li', {}, text, bought));
      });
    view.append(ul);
  }

  const reset = el('button', {
    textContent: 'Vaciar el menú de esta semana',
    onclick: () => { if (confirm(`¿Borrar todos los platos de la semana del ${weekLabel()}?`)) store.resetWeek(); },
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
  renderWeekNav();
  renderTabs();
  const view = document.getElementById('view');
  view.innerHTML = '';
  if (errorMessage) view.append(el('p', { className: 'error', textContent: errorMessage }));

  if (session && session.status !== 'ready') renderGate(view);
  else if (current === SHOPPING) renderShopping(view);
  else if (current === SHARING && isOwner()) renderSharing(view);
  else renderDay(view, week.includes(current) ? current : (current = week[0]));

  const key = focusNext || focusKey;
  if (key) {
    const target = view.querySelector(`[data-focus-key="${key}"]`);
    if (target) { target.value = focusNext ? '' : typed ?? ''; target.focus(); }
  }
  focusNext = null;
}

if (firebaseConfig) {
  render();
  try {
    const { createFirebaseStore } = await import('./firebase-store.js?v=6');
    store = await createFirebaseStore(firebaseConfig, { ...handlers, legacyDay, legacyNames: DAY_NAMES });
    store.setWeek(week);
  } catch (err) {
    console.error(err);
    document.getElementById('view').textContent = 'No se pudo conectar. Comprueba tu conexión a internet y recarga la página.';
  }
} else {
  store = createLocalStore({ ...handlers, legacyDay });
  store.setWeek(week);
}
