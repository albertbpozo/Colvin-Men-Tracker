// El ?v= obliga al navegador a descargar la versión nueva tras cada cambio;
// súbelo a la vez en index.html y aquí.
import { firebaseConfig } from './firebase-config.js?v=17';
import { createLocalStore, newIngredientId } from './local-store.js?v=17';
import { PRESETS, presetOf, repeatFromDraft, repeatLabel, nextAfter, onOrAfter } from './repeat.js?v=17';
import { RECIPE_PROMPT, DEFAULT_SERVINGS, scaleQty, parseIngredient, parseRecipes, ingredientLine } from './recipes.js?v=17';

const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const MEALS = ['Desayuno', 'Comida', 'Merienda', 'Cena'];
const SHOPPING = 'compra';
const SHARING = 'compartir';
const TASKS = 'tareas';
const RECIPES = 'recetas';

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

// Al recargar la página se vuelve a la pestaña (y semana) en la que estabas.
// Va en sessionStorage: al abrir la app de nuevo se empieza en hoy.
const TAB_KEY = 'menu-semanal-pestana';
let current = todayISO();
try { current = sessionStorage.getItem(TAB_KEY) || current; } catch (e) { /* sin almacenamiento */ }
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
let week = weekOf(mondayOf(isDate(current) ? fromISO(current) : new Date()));
let days = {};
let general = []; // lista de compra general, la misma para todas las semanas
let lastMeal = MEALS[0];
let lastAssignee = ''; // a quién se asignó la última tarea añadida
// En modo local no hay sesión; con Firebase guarda el estado de acceso.
let session = firebaseConfig ? { status: 'loading' } : null;
let errorMessage = '';
let focusNext = null; // campo que debe recibir el foco tras el próximo redibujado
let store;

// ---------- Compra en curso: lo marcado como comprado, compartido entre todos ----------
// Permite ver lo ya comprado y deshacerlo; caduca tras 12 h sin marcar nada.
const BOUGHT_TTL = 12 * 60 * 60 * 1000;
let bought = []; // lo más reciente primero
let pendingUndo = null; // deshacer de platos de otra semana, a la espera de sus datos
let toastTimer;
let photos = {}; // foto de cada producto (data URL), por nombre en minúsculas
let photosUsed = {}; // última vez que apareció cada producto con foto (ms)
let tasks = []; // lista de tareas pendientes, independiente del menú
// Quién puede crear menús: lo decide el administrador (ver firestore.rules).
let creators = { admin: false, canCreate: false, list: [] };
let taskFilter = 'all'; // 'all' | 'mine'
// Borradores de tareas (la vista se redibuja cuando otra persona cambia algo).
const newTaskDraft = () => ({ name: '', preset: 'none', n: 2, unit: 'week', start: todayISO() });
let taskDraft = null; // formulario de nueva tarea (se crea al abrir la pestaña)
let repeatEdit = null; // { id, preset, n, unit, start } al cambiar la repetición de una tarea
// Recetas del menú y estado de la pestaña (lo que se está escribiendo se guarda
// en borradores, porque la vista se redibuja cuando otra persona cambia algo).
let recipes = [];
let openRecipe = null; // id de la receta desplegada
let recipeDraft = null; // { id | null, name, servings, ingredients, steps } mientras se edita
let importDraft = null; // texto pegado para importar, o null si el panel está cerrado
let recipeSearch = '';
let recipeNotice = '';

const boughtExpired = () => bought.length > 0 && Date.now() - Math.max(...bought.map(r => r.at)) >= BOUGHT_TTL;

function markBought(record) {
  if (boughtExpired()) store.clearBought();
  record = { id: newIngredientId(), at: Date.now(), by: session?.email || '', ...record };
  store.addBought(record);
  showToast(record);
}

// Vuelve a poner como «falta» solo los ingredientes que cambió ese «Comprado».
function restoreMenu(changes) {
  const byEntry = new Map();
  changes.forEach(({ day, entryId, ingId }) => {
    if (!byEntry.has(entryId)) byEntry.set(entryId, { day, ids: new Set() });
    byEntry.get(entryId).ids.add(ingId);
  });
  byEntry.forEach(({ day, ids }, entryId) => {
    const entry = (days[day] || []).find(e => e.id === entryId);
    if (entry) store.setIngredients(day, entry, entry.ingredients.map(i => ids.has(i.id) ? { ...i, have: false } : i));
  });
}

function undoBought(record) {
  record = bought.find(r => r.id === record.id);
  if (!record) return; // ya lo deshizo alguien
  if (record.source === 'general') {
    if (!general.some(i => i.id === record.item.id)) store.setGeneral([...general, record.item]);
  } else if (record.changes.some(c => !week.includes(c.day))) {
    // Los platos son de otra semana: se va a esa semana y se deshace al recibir sus datos.
    pendingUndo = record;
    goToWeek(mondayOf(fromISO(record.changes[0].day)));
    return;
  } else {
    restoreMenu(record.changes);
  }
  store.removeBought(record);
}

// Aviso abajo con «Deshacer» durante unos segundos.
function showUndo(text, undo) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const box = el('div', { className: 'toast', role: 'status' },
    el('span', { textContent: text }),
    el('button', { textContent: 'Deshacer', onclick: () => { box.remove(); undo(); } }));
  document.body.append(box);
  toastTimer = setTimeout(() => box.remove(), 6000);
}

const showToast = record => showUndo(`${record.name} comprado`, () => undoBought(record));

const handlers = {
  onData(data) {
    days = data;
    if (pendingUndo && pendingUndo.changes.every(c => week.includes(c.day))) {
      const record = pendingUndo;
      pendingUndo = null; // antes de restaurar: el cambio vuelve a llamar a onData
      restoreMenu(record.changes);
      store.removeBought(record);
    }
    render();
    touchPhotos();
  },
  onGeneral(items) { general = items; render(); touchPhotos(); },
  onBought(records) {
    bought = [...records].sort((a, b) => b.at - a.at);
    if (boughtExpired()) store.clearBought();
    render();
    touchPhotos();
  },
  onPhotos(map, used, fromCache) {
    photos = map;
    photosUsed = used;
    render();
    touchPhotos();
    if (!fromCache) cleanPhotos();
  },
  onTasks(list) { tasks = list; render(); },
  onRecipes(list) { recipes = list; render(); },
  onCreators(c) { creators = c; render(); },
  onStatus(s) {
    if (s.menuId !== session?.menuId) {
      // Otro menú (o ninguno): fuera los datos del anterior hasta que lleguen los nuevos.
      days = {}; general = []; bought = []; photos = {}; photosUsed = {}; tasks = []; pendingUndo = null;
      recipes = []; openRecipe = recipeDraft = importDraft = null; repeatEdit = null;
      clearTimeout(cleanTimer);
    }
    if (s.status !== session?.status) errorMessage = '';
    session = s;
    render();
  },
  onError(err) {
    console.error(err);
    errorMessage = err.during === 'sign-in' ? signInMessage(err)
      : err.during === 'menus' ? 'No se pudieron cargar tus menús. Si acabas de actualizar la app, publica las reglas nuevas de firestore.rules en Firebase.'
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
const ready = () => session?.status === 'ready';

// Alias de una persona en el menú abierto (o su email si no tiene).
const display = person => session?.aliases?.[person] || person;
const menuLabel = m => m.name
  || (m.owner === session?.email ? 'Mi menú' : `Menú de ${m.aliases?.[m.owner] || m.owner}`);

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
    el('span', { className: 'email', textContent: display(session.email), title: session.email }),
    el('button', { textContent: 'Salir', onclick: () => store.signOut() }),
  );
}

function renderMenuPicker() {
  const box = document.getElementById('menu-picker');
  box.innerHTML = '';
  if (!ready() || session.menus.length < 2) return;
  const select = el('select', { title: 'Cambiar de menú' },
    ...session.menus.map(m => el('option', { value: m.id, textContent: menuLabel(m), selected: m.id === session.menuId })));
  select.onchange = () => store.selectMenu(select.value);
  box.append(select);
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
  make(TASKS, '✅ Tareas', myPendingTasks().length);
  make(RECIPES, '📖 Recetas');
  if (ready()) make(SHARING, '👥 Personas');
}

function renderGate(view) {
  const gate = el('div', { className: 'gate' });
  if (session.status === 'signed-out') {
    gate.append(
      el('p', { textContent: 'Entra con tu cuenta de Google para ver el menú compartido.' }),
      el('button', { className: 'primary', textContent: 'Entrar con Google', onclick: () => store.signIn() }),
    );
  } else if (session.status === 'no-menu') {
    const form = el('form', { className: 'create-menu' },
      el('input', { name: 'name', placeholder: 'Nombre del menú (p. ej. Casa)', autocomplete: 'off', required: true }),
      el('button', { type: 'submit', textContent: 'Crear mi menú' }));
    form.onsubmit = ev => {
      ev.preventDefault();
      const name = form.name.value.trim();
      if (name) store.createMenu(name);
    };
    gate.append(el('p', { textContent: `Aún no tienes ningún menú con la cuenta ${session.email}.` }));
    if (creators.canCreate) {
      gate.append(
        el('p', { textContent: 'Crea el tuyo, o pide a alguien que te invite con este email desde su pestaña «👥 Personas».' }),
        form);
    } else {
      gate.append(el('p', { textContent: 'Pide a alguien que te invite con este email desde su pestaña «👥 Personas», o a quien gestiona la app que te deje crear tu propio menú.' }));
    }
    gate.append(el('button', { textContent: 'Entrar con otra cuenta', onclick: () => store.signOut() }));
  } else if (session.status === 'denied') {
    gate.append(
      el('p', { textContent: `La cuenta ${session.email} no tiene acceso a este menú.` }),
      el('p', { textContent: 'Pide a quien lo creó que añada tu email en «👥 Personas».' }),
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

// ---------- Fotos de los productos de la compra ----------
// Se guardan por nombre, así la foto de «Leche» sale en todas las listas y semanas.
const photoKey = name => name.trim().toLowerCase();

// Reduce la foto en el móvil para que quepa en un documento de Firestore (< 1 MB).
async function shrinkPhoto(file) {
  const img = await createImageBitmap(file);
  for (const [max, quality] of [[800, 0.7], [600, 0.6], [400, 0.5]]) {
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = el('canvas', { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length < 700000) return url;
  }
  throw new Error('Foto demasiado grande');
}

// ---------- Limpieza: fotos que llevan un mes sin usarse ----------
// Un producto «se usa» si aparece en la lista general, en «Ya comprado» o en
// algún plato de la semana que se está viendo. No hay servidor: la limpieza la
// hace la app al abrirse, como mucho una vez al día en cada dispositivo.
const DAY_MS = 24 * 60 * 60 * 1000;
const PHOTO_MAX_IDLE = 30 * DAY_MS;
const CLEAN_KEY = 'menu-semanal-limpieza-fotos';

const photosInUse = () => new Set([
  ...general.map(i => i.name),
  ...bought.map(r => r.name),
  ...week.flatMap(d => (days[d] || []).flatMap(e => e.ingredients.map(i => i.name))),
].map(photoKey));

function touchPhotos() {
  if (!Object.keys(photos).length) return;
  // Se apunta como mucho una vez al día por foto, para no gastar escrituras.
  const stale = [...photosInUse()].filter(k => photos[k] && Date.now() - (photosUsed[k] || 0) > DAY_MS);
  if (stale.length) store.touchPhotos(stale);
}

let cleanTimer;
// Espera a que lleguen también las listas y el menú antes de decidir nada.
function cleanPhotos() {
  clearTimeout(cleanTimer);
  cleanTimer = setTimeout(cleanNow, 15000);
}

function cleanNow() {
  const scope = session?.menuId || 'local';
  if (session && session.status !== 'ready') return;
  let last = {};
  try { last = JSON.parse(localStorage.getItem(CLEAN_KEY)) || {}; } catch (e) { /* sin datos */ }
  if (Date.now() - (last[scope] || 0) < DAY_MS) return;
  last[scope] = Date.now();
  try { localStorage.setItem(CLEAN_KEY, JSON.stringify(last)); } catch (e) { /* sin persistencia */ }

  const keys = Object.keys(photos);
  // Fotos de antes de esta función, sin fecha: empiezan a contar desde hoy.
  const undated = keys.filter(k => !photosUsed[k]);
  if (undated.length) store.touchPhotos(undated);
  const inUse = photosInUse();
  keys.filter(k => photosUsed[k] && !inUse.has(k) && Date.now() - photosUsed[k] > PHOTO_MAX_IDLE)
    .forEach(k => store.setPhoto(k, k, null));
}

function pickPhoto(name) {
  const input = el('input', { type: 'file', accept: 'image/*', hidden: true });
  input.onchange = async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    try {
      store.setPhoto(photoKey(name), name, await shrinkPhoto(file));
    } catch (err) {
      handlers.onError(err);
    }
  };
  document.body.append(input);
  input.click();
}

function showPhoto(name) {
  const close = () => box.remove();
  const box = el('div', { className: 'photo-viewer', onclick: ev => { if (ev.target === box) close(); } },
    el('div', { className: 'photo-card' },
      el('img', { src: photos[photoKey(name)], alt: name }),
      el('div', { className: 'photo-actions' },
        el('strong', { textContent: name }),
        el('button', { textContent: 'Cambiar', onclick: () => { close(); pickPhoto(name); } }),
        el('button', {
          textContent: 'Quitar', onclick: () => {
            if (!confirm(`¿Quitar la foto de ${name}?`)) return;
            close();
            store.setPhoto(photoKey(name), name, null);
          },
        }),
        el('button', { className: 'primary', textContent: 'Cerrar', onclick: close }))));
  document.body.append(box);
}

function photoButton(name) {
  const url = photos[photoKey(name)];
  return url
    ? el('button', { className: 'thumb', title: 'Ver foto', onclick: () => showPhoto(name) },
      el('img', { src: url, alt: '' }))
    : el('button', { className: 'thumb empty-thumb', textContent: '📷', title: 'Añadir foto', onclick: () => pickPhoto(name) });
}

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
        onclick: () => {
          store.setGeneral(general.filter(i => i.id !== item.id));
          markBought({ source: 'general', name: item.name, qty: item.qty || '', where: 'Lista general', item });
        },
      });
      ul.append(el('li', {}, photoButton(item.name), el('span', { className: 'name', textContent: item.name }), qty, bought));
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
        const qtys = g.items.map(i => i.qty).filter(Boolean);
        const bought = el('button', {
          className: 'status missing',
          textContent: 'Comprado',
          title: 'Marcar como que ya lo tienes',
          onclick: () => {
            const seen = new Set();
            const changes = [];
            g.items.forEach(({ day, entry }) => {
              if (seen.has(entry.id)) return;
              seen.add(entry.id);
              entry.ingredients.forEach(i => {
                if (i.name.toLowerCase() === key && !i.have) changes.push({ day, entryId: entry.id, ingId: i.id });
              });
              store.setIngredients(day, entry, entry.ingredients.map(i =>
                i.name.toLowerCase() === key ? { ...i, have: true } : i));
            });
            const where = [...new Set(g.items.map(i => `${dayShort(i.day)} · ${i.entry.name}`))].join(', ');
            markBought({ source: 'menu', name: g.name, qty: qtys.join(' + '), where, changes });
          },
        });
        const text = el('div', { className: 'name' },
          el('div', {}, g.name, qtys.length ? el('span', { className: 'qty-tag', textContent: qtys.join(' + ') }) : ''),
          el('div', { className: 'where', textContent: g.items.map(i => i.where).join(', ') }));
        ul.append(el('li', {}, photoButton(g.name), text, bought));
      });
    view.append(ul);
  }

  // ---- Lo comprado en esta compra (lo ven todos), con deshacer ----
  if (bought.length && !boughtExpired()) {
    const finish = el('button', {
      textContent: 'Terminar compra',
      onclick: () => {
        // Doble confirmación: después ya no se puede deshacer lo comprado.
        if (!confirm(`¿Terminar la compra y vaciar «Ya comprado» (${bought.length})?`)) return;
        if (!confirm('¿Seguro? Ya no podrás deshacer lo que has marcado como comprado.')) return;
        store.clearBought();
      },
    });
    view.append(el('div', { className: 'section-head' },
      el('h2', { textContent: `Ya comprado (${bought.length})` }), finish));
    const ul = el('ul', { className: 'ingredients shopping entry bought' });
    bought.forEach(r => ul.append(el('li', {},
      photoButton(r.name),
      el('div', { className: 'name' },
        el('div', {}, r.name, r.qty ? el('span', { className: 'qty-tag', textContent: r.qty }) : ''),
        el('div', { className: 'where', textContent: r.by && r.by !== session?.email ? `${r.where} · ${display(r.by)}` : r.where })),
      el('button', {
        className: 'status have', textContent: 'Deshacer', title: 'Volver a ponerlo en la lista',
        onclick: () => undoBought(r),
      }))));
    view.append(ul);
  }

  const reset = el('button', {
    textContent: 'Vaciar el menú de esta semana',
    onclick: () => {
      // Doble confirmación: vaciar la semana no se puede deshacer.
      if (!confirm(`¿Borrar todos los platos de la semana del ${weekLabel()}?`)) return;
      if (!confirm('¿Seguro? Se borrarán todos los platos de la semana y no se podrán recuperar.')) return;
      store.resetWeek();
    },
  });
  view.append(el('div', { className: 'toolbar' }, reset));
}

// ---------- Tareas pendientes: lista aparte, cada tarea asignable a una persona ----------

// Con Firebase se asigna a las personas con acceso; en modo local, a cualquier nombre.
const taskPeople = () => session?.status === 'ready'
  ? [session.owner, ...session.members]
  : [...new Set(tasks.map(t => t.assignee).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
const personLabel = p => !p ? 'Sin asignar' : p === session?.email ? `${display(p)} (yo)` : display(p);
// En el contador de la pestaña: las mías si hay sesión; si no, todas las pendientes.
// Las tareas que se repiten solo están pendientes desde el día que les toca.
const isDue = t => !t.done && (!t.repeat || t.due <= todayISO());
const myPendingTasks = () => tasks.filter(t => isDue(t) && (!session?.email || t.assignee === session.email));
const fullDate = iso => fromISO(iso).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });

// Hecha una tarea que se repite: pasa a la siguiente fecha (sin acumular las
// que se hayan saltado) y se puede deshacer.
function completeRepeating(task) {
  const today = todayISO();
  const due = nextAfter(task.start, task.repeat, task.due > today ? task.due : today);
  store.updateTask(task.id, { due, lastDoneAt: Date.now(), lastDoneBy: session?.email || '' });
  showUndo(`«${task.name}» hecha · vuelve el ${fullDate(due)}`, () => store.updateTask(task.id, {
    due: task.due, lastDoneAt: task.lastDoneAt ?? null, lastDoneBy: task.lastDoneBy ?? null,
  }));
}

// Desplegable de repetición; con «Otra…» se elige número y unidad. Siempre
// pregunta desde qué día empieza.
function repeatControls(draft) {
  const box = el('div', { className: 'repeat-controls' });
  const preset = el('select', { title: 'Repetir' }, ...PRESETS.map(([value, label]) => el('option', { value, textContent: label, selected: value === draft.preset })));
  preset.onchange = () => { draft.preset = preset.value; render(); };
  box.append(preset);
  if (draft.preset === 'custom') {
    const n = el('input', { type: 'number', min: 1, max: 365, value: draft.n, className: 'repeat-n', title: 'Cada cuántos' });
    n.oninput = () => { draft.n = n.value; };
    const unit = el('select', { title: 'Unidad' }, ...[['day', 'días'], ['week', 'semanas'], ['month', 'meses']]
      .map(([value, label]) => el('option', { value, textContent: label, selected: value === draft.unit })));
    unit.onchange = () => { draft.unit = unit.value; };
    box.append(el('span', { textContent: 'cada' }), n, unit);
  }
  if (draft.preset !== 'none') {
    const start = el('input', { type: 'date', value: draft.start, title: 'Primer día' });
    start.oninput = () => { draft.start = start.value || todayISO(); };
    box.append(el('span', { textContent: 'desde' }), start);
  }
  return box;
}

// Campos de una tarea que se repite según el borrador.
function repeatFields(draft) {
  const repeat = repeatFromDraft(draft);
  if (!repeat) return { repeat: null, start: null, due: null };
  const start = draft.start || todayISO();
  return { repeat, start, due: onOrAfter(start, repeat, todayISO()) };
}

function assigneePicker(value, onPick, focusKey) {
  if (session) {
    const people = taskPeople();
    if (value && !people.includes(value)) people.push(value); // alguien que ya no tiene acceso
    const select = el('select', { className: 'assignee', title: 'Asignar a' },
      el('option', { value: '', textContent: 'Sin asignar' }),
      ...people.map(p => el('option', { value: p, textContent: personLabel(p), selected: p === value })));
    select.onchange = () => onPick(select.value);
    return select;
  }
  const input = el('input', { className: 'assignee', value: value || '', placeholder: 'Asignar a…', autocomplete: 'off' });
  input.setAttribute('list', 'task-people');
  if (focusKey) input.dataset.focusKey = focusKey;
  input.onchange = () => onPick(input.value.trim());
  return input;
}

function taskRow(task) {
  const today = todayISO();
  const status = task.repeat
    ? el('button', {
      className: `status ${isDue(task) ? 'missing' : 'have'}`,
      textContent: isDue(task) ? 'Pendiente' : 'Programada',
      title: isDue(task) ? 'Marcar como hecha (volverá a aparecer)' : 'Aún no toca',
      disabled: !isDue(task),
      onclick: () => completeRepeating(task),
    })
    : el('button', {
      className: `status ${task.done ? 'have' : 'missing'}`,
      textContent: task.done ? 'Hecha' : 'Pendiente',
      title: 'Pulsa para cambiar',
      onclick: () => store.updateTask(task.id, { done: !task.done, doneAt: task.done ? null : Date.now() }),
    });
  const del = el('button', {
    className: 'icon', textContent: '✕', title: 'Eliminar tarea',
    onclick: () => {
      const extra = task.repeat ? ' Dejará de repetirse.' : '';
      if (confirm(`¿Eliminar la tarea «${task.name}»?${extra}`)) store.deleteTask(task.id);
    },
  });
  const repeatBtn = el('button', {
    className: task.repeat ? 'icon repeat-btn active' : 'icon repeat-btn', textContent: '🔁',
    title: task.repeat ? 'Cambiar la repetición' : 'Hacer que se repita',
    onclick: () => {
      repeatEdit = repeatEdit?.id === task.id ? null : {
        id: task.id, preset: task.repeat ? presetOf(task.repeat) : '1-week',
        n: task.repeat?.n || 2, unit: task.repeat?.unit || 'week', start: task.start || today,
      };
      render();
    },
  });

  const details = [];
  if (task.repeat) {
    const when = task.due > today ? `próxima: ${fullDate(task.due)}`
      : task.due < today ? `atrasada desde el ${fullDate(task.due)}` : 'hoy';
    details.push(el('div', { className: task.due < today ? 'where late' : 'where', textContent: `${repeatLabel(task.repeat, task.start)} · ${when}` }));
  }
  if (task.by && task.by !== task.assignee) details.push(el('div', { className: 'where', textContent: `Creada por ${display(task.by)}` }));
  const text = el('div', { className: 'name' },
    el('div', { textContent: task.name, ondblclick: () => {
      const value = prompt('Tarea:', task.name);
      if (value && value.trim()) store.updateTask(task.id, { name: value.trim() });
    } }),
    ...details);
  const picker = assigneePicker(task.assignee, assignee => store.updateTask(task.id, { assignee }));
  const rows = [el('li', { className: task.done ? 'done' : '' }, status, text, picker, task.done ? '' : repeatBtn, del)];

  if (repeatEdit?.id === task.id) {
    const save = el('button', {
      className: 'primary', textContent: 'Guardar',
      onclick: () => {
        store.updateTask(task.id, { ...repeatFields(repeatEdit), done: false, doneAt: null });
        repeatEdit = null;
        render();
      },
    });
    rows.push(el('li', { className: 'repeat-edit' }, repeatControls(repeatEdit),
      el('div', { className: 'form-actions' },
        el('button', { textContent: 'Cancelar', onclick: () => { repeatEdit = null; render(); } }), save)));
  }
  return rows;
}

function renderTasks(view) {
  view.append(el('h2', { textContent: 'Tareas pendientes' }));
  if (!session) {
    view.append(el('datalist', { id: 'task-people' }, ...taskPeople().map(p => el('option', { value: p }))));
  }

  taskDraft ||= newTaskDraft();
  const nameInput = el('input', { name: 'task', value: taskDraft.name, placeholder: 'Nueva tarea (p. ej. Sacar la basura)', autocomplete: 'off', required: true });
  nameInput.dataset.focusKey = 'task';
  nameInput.oninput = () => { taskDraft.name = nameInput.value; };
  const form = el('form', { className: 'add-task' },
    nameInput,
    assigneePicker(lastAssignee, a => { lastAssignee = a; }, 'task-assignee'),
    el('button', { type: 'submit', textContent: 'Añadir' }),
    repeatControls(taskDraft));
  form.onsubmit = ev => {
    ev.preventDefault();
    const name = taskDraft.name.trim();
    if (!name) return;
    const assignee = (form.querySelector('.assignee').value || '').trim();
    lastAssignee = assignee;
    const fields = repeatFields(taskDraft);
    taskDraft = newTaskDraft();
    focusNext = 'task';
    store.addTask({ name, assignee, done: false, createdAt: Date.now(), by: session?.email || '', ...(fields.repeat ? fields : {}) });
    render();
  };
  view.append(form);

  if (session?.email) {
    const filters = el('div', { className: 'filters' });
    [['all', 'Todas'], ['mine', 'Mis tareas']].forEach(([key, label]) => {
      const b = el('button', { textContent: label, onclick: () => { taskFilter = key; render(); } });
      b.setAttribute('aria-pressed', String(taskFilter === key));
      filters.append(b);
    });
    view.append(filters);
  }

  const visible = tasks.filter(t => taskFilter !== 'mine' || !session?.email || t.assignee === session.email);
  // Primero las atrasadas, luego las de hoy y después las sueltas, por antigüedad.
  const pending = visible.filter(isDue).sort((a, b) =>
    (a.due || '9').localeCompare(b.due || '9') || (a.createdAt || 0) - (b.createdAt || 0));
  const scheduled = visible.filter(t => t.repeat && !isDue(t)).sort((a, b) => a.due.localeCompare(b.due));
  const done = visible.filter(t => t.done && !t.repeat).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

  if (!pending.length) {
    view.append(el('p', { className: 'empty', textContent: taskFilter === 'mine' ? 'No tienes tareas pendientes.' : 'No hay tareas pendientes.' }));
  } else {
    view.append(el('ul', { className: 'ingredients tasks entry' }, ...pending.flatMap(taskRow)));
  }

  if (scheduled.length) {
    view.append(
      el('div', { className: 'section-head' }, el('h2', { textContent: `Programadas (${scheduled.length})` })),
      el('ul', { className: 'ingredients tasks entry scheduled' }, ...scheduled.flatMap(taskRow)));
  }

  if (done.length) {
    const clear = el('button', {
      textContent: 'Borrar hechas',
      onclick: () => {
        if (confirm(`¿Borrar las ${done.length} tareas hechas?`)) done.forEach(t => store.deleteTask(t.id));
      },
    });
    view.append(
      el('div', { className: 'section-head' }, el('h2', { textContent: `Hechas (${done.length})` }), clear),
      el('ul', { className: 'ingredients tasks entry' }, ...done.flatMap(taskRow)));
  }
}

// ---------- Recetas ----------
// Cada receta guarda sus cantidades para `baseServings` raciones; al cambiar
// `servings` se recalculan (sin ir redondeando sobre lo ya redondeado).

const servingsOf = r => r.servings || r.baseServings || DEFAULT_SERVINGS;
const scaledIngredients = r => {
  const factor = servingsOf(r) / (r.baseServings || servingsOf(r));
  return (r.ingredients || []).map(i => ({ ...i, qty: scaleQty(i.qty, factor) }));
};
const raciones = n => `${n} ${n === 1 ? 'ración' : 'raciones'}`;

function setServings(recipe, n) {
  if (n >= 1 && n <= 99) store.updateRecipe(recipe.id, { servings: n });
}

function saveRecipeDraft() {
  const d = recipeDraft;
  const name = d.name.trim();
  if (!name) { alert('Ponle un nombre a la receta.'); return; }
  const servings = Math.max(1, Math.min(99, parseInt(d.servings, 10) || DEFAULT_SERVINGS));
  const data = {
    name,
    // Lo escrito vale para estas raciones: pasan a ser la nueva base.
    servings, baseServings: servings,
    ingredients: d.ingredients.split('\n').map(l => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean)
      .map(l => ({ id: newIngredientId(), ...parseIngredient(l) })),
    steps: d.steps.split('\n').map(l => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean),
  };
  if (d.id) store.updateRecipe(d.id, data);
  else store.addRecipe({ ...data, createdAt: Date.now(), by: session?.email || '' });
  openRecipe = d.id || null;
  recipeDraft = null;
  render();
}

function recipeForm() {
  const d = recipeDraft;
  const field = (tag, key, props) => {
    const node = el(tag, { ...props, value: d[key] });
    node.dataset.focusKey = `recipe-${key}`;
    node.oninput = () => { d[key] = node.value; };
    return node;
  };
  const form = el('form', { className: 'recipe-form' },
    el('label', {}, 'Nombre', field('input', 'name', { placeholder: 'Lentejas con chorizo', autocomplete: 'off' })),
    el('label', { className: 'servings-field' }, 'Raciones', field('input', 'servings', { type: 'number', min: 1, max: 99 })),
    el('label', {}, 'Ingredientes (uno por línea: «Nombre: cantidad»)',
      field('textarea', 'ingredients', { rows: 6, placeholder: 'Lentejas: 300 g\nChorizo: 1\nSal: al gusto' })),
    el('label', {}, 'Pasos (uno por línea)',
      field('textarea', 'steps', { rows: 5, placeholder: 'Remojar las lentejas la noche anterior.\nCocer 40 minutos.' })),
    el('div', { className: 'form-actions' },
      el('button', { type: 'button', textContent: 'Cancelar', onclick: () => { recipeDraft = null; render(); } }),
      el('button', { type: 'submit', textContent: d.id ? 'Guardar' : 'Crear receta' })));
  form.onsubmit = ev => { ev.preventDefault(); saveRecipeDraft(); };
  return form;
}

function editRecipe(r) {
  recipeDraft = {
    id: r?.id || null,
    name: r?.name || '',
    servings: String(r ? servingsOf(r) : DEFAULT_SERVINGS),
    ingredients: r ? scaledIngredients(r).map(ingredientLine).join('\n') : '',
    steps: (r?.steps || []).join('\n'),
  };
  focusNext = 'recipe-name';
  render();
}

function addRecipeToMenu(r, day, meal) {
  lastMeal = meal;
  store.addEntry(day, meal, r.name, scaledIngredients(r).map(i => ({ id: newIngredientId(), name: i.name, qty: i.qty || '', have: false })));
  current = day; // se ve el plato recién añadido
  render();
}

function recipeDetail(r) {
  const n = servingsOf(r);
  const box = el('div', { className: 'recipe-detail' });

  box.append(el('div', { className: 'servings' },
    el('button', { type: 'button', className: 'step', textContent: '−', title: 'Menos raciones', disabled: n <= 1, onclick: () => setServings(r, n - 1) }),
    el('button', {
      type: 'button', className: 'servings-count', textContent: raciones(n), title: 'Cambiar raciones',
      onclick: () => {
        const value = prompt('¿Para cuántas raciones?', String(n));
        if (value !== null) setServings(r, parseInt(value, 10));
      },
    }),
    el('button', { type: 'button', className: 'step', textContent: '+', title: 'Más raciones', disabled: n >= 99, onclick: () => setServings(r, n + 1) }),
    r.baseServings && r.baseServings !== n
      ? el('button', { type: 'button', className: 'link', textContent: `Volver a ${raciones(r.baseServings)}`, onclick: () => setServings(r, r.baseServings) })
      : ''));

  const ingredients = scaledIngredients(r);
  if (ingredients.length) {
    box.append(el('h4', { textContent: 'Ingredientes' }),
      el('ul', { className: 'ingredients recipe-ingredients' }, ...ingredients.map(i => el('li', {},
        el('span', { className: 'name', textContent: i.name }),
        i.qty ? el('span', { className: 'qty-tag', textContent: i.qty }) : ''))));
  }
  if (r.steps?.length) {
    box.append(el('h4', { textContent: 'Pasos' }), el('ol', { className: 'steps' }, ...r.steps.map(s => el('li', { textContent: s }))));
  }

  // Añadir al menú: día de la semana que se está viendo y comida.
  const fallbackDay = week.includes(current) ? current : week.includes(todayISO()) ? todayISO() : week[0];
  const daySelect = el('select', { title: 'Día' }, ...week.map(d => el('option', {
    value: d, textContent: dayShort(d) + (d === todayISO() ? ' (hoy)' : ''), selected: d === fallbackDay,
  })));
  const mealSelect = el('select', { title: 'Comida' }, ...MEALS.map(m => el('option', { value: m, textContent: m, selected: m === lastMeal })));
  box.append(el('div', { className: 'add-to-menu' },
    daySelect, mealSelect,
    el('button', { className: 'primary', textContent: 'Añadir al menú', onclick: () => addRecipeToMenu(r, daySelect.value, mealSelect.value) })));

  box.append(el('div', { className: 'form-actions' },
    el('button', { textContent: 'Editar', onclick: () => editRecipe(r) }),
    el('button', {
      textContent: 'Eliminar',
      onclick: () => { if (confirm(`¿Eliminar la receta «${r.name}»?`)) { openRecipe = null; store.deleteRecipe(r.id); } },
    })));
  return box;
}

function renderImport(view) {
  const textarea = el('textarea', { rows: 10, value: importDraft, placeholder: '# Lentejas con chorizo\nRaciones: 4\nIngredientes:\n- Lentejas: 300 g\nPasos:\n1. …' });
  textarea.dataset.focusKey = 'recipe-import';
  textarea.oninput = () => { importDraft = textarea.value; };
  const copy = el('button', {
    type: 'button', textContent: 'Copiar instrucciones para Claude',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(RECIPE_PROMPT);
        copy.textContent = 'Copiadas ✓';
      } catch (e) {
        prompt('Copia este texto y pégaselo a Claude:', RECIPE_PROMPT);
      }
    },
  });
  const panel = el('div', { className: 'entry import-panel' },
    el('p', { className: 'hint', textContent: 'Pásale a Claude las instrucciones y pídele las recetas (p. ej. «dame 3 recetas de cenas ligeras»). Luego pega aquí su respuesta: puedes pegar varias recetas a la vez.' }),
    copy, textarea,
    el('div', { className: 'form-actions' },
      el('button', { textContent: 'Cancelar', onclick: () => { importDraft = null; render(); } }),
      el('button', {
        className: 'primary', textContent: 'Importar',
        onclick: () => {
          const found = parseRecipes(importDraft || '');
          if (!found.length) {
            alert('No he encontrado ninguna receta. Cada una debe empezar con «# Nombre» y tener ingredientes o pasos.');
            return;
          }
          found.forEach(r => store.addRecipe({
            name: r.name, servings: r.servings, baseServings: r.servings, steps: r.steps,
            ingredients: r.ingredients.map(i => ({ id: newIngredientId(), ...i })),
            createdAt: Date.now(), by: session?.email || '',
          }));
          importDraft = null;
          recipeNotice = found.length === 1 ? `Receta importada: ${found[0].name}` : `${found.length} recetas importadas: ${found.map(r => r.name).join(', ')}`;
          setTimeout(() => { recipeNotice = ''; render(); }, 6000);
          render();
        },
      })));
  view.append(panel);
}

function renderRecipes(view) {
  view.append(el('div', { className: 'section-head first' },
    el('h2', { textContent: 'Recetas' }),
    el('div', { className: 'head-actions' },
      el('button', { textContent: 'Importar', onclick: () => { importDraft = importDraft ?? ''; recipeDraft = null; focusNext = 'recipe-import'; render(); } }),
      el('button', { className: 'primary', textContent: '+ Nueva', onclick: () => { importDraft = null; editRecipe(null); } }))));

  if (recipeNotice) view.append(el('p', { className: 'notice', textContent: recipeNotice }));
  if (importDraft !== null) renderImport(view);
  if (recipeDraft && !recipeDraft.id) view.append(el('div', { className: 'entry' }, el('h3', { textContent: 'Nueva receta' }), recipeForm()));

  if (!recipes.length) {
    if (importDraft === null && !recipeDraft) {
      view.append(el('p', { className: 'empty', textContent: 'Aún no hay recetas. Crea una con «+ Nueva» o importa las que te pase Claude.' }));
    }
    return;
  }

  if (recipes.length > 4) {
    const search = el('input', { type: 'search', className: 'recipe-search', placeholder: 'Buscar receta o ingrediente…', value: recipeSearch, autocomplete: 'off' });
    search.dataset.focusKey = 'recipe-search';
    search.oninput = () => { recipeSearch = search.value; render(); };
    view.append(search);
  }
  const term = recipeSearch.trim().toLowerCase();
  const list = recipes
    .filter(r => !term || r.name.toLowerCase().includes(term) || (r.ingredients || []).some(i => i.name.toLowerCase().includes(term)))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  if (!list.length) view.append(el('p', { className: 'empty', textContent: 'Ninguna receta coincide con la búsqueda.' }));

  list.forEach(r => {
    const isOpen = openRecipe === r.id;
    const card = el('article', { className: isOpen ? 'entry recipe open' : 'entry recipe' });
    const toggle = () => { openRecipe = isOpen ? null : r.id; if (recipeDraft?.id === r.id) recipeDraft = null; render(); };
    const head = el('button', { className: 'recipe-head', onclick: toggle },
      el('h3', { className: 'dish', textContent: r.name }),
      el('span', { className: 'counter', textContent: `${raciones(servingsOf(r))} · ${(r.ingredients || []).length} ingr.` }),
      el('span', { className: 'chevron', textContent: isOpen ? '▴' : '▾' }));
    head.setAttribute('aria-expanded', String(isOpen));
    card.append(head);
    if (isOpen) card.append(recipeDraft?.id === r.id ? recipeForm() : recipeDetail(r));
    view.append(card);
  });
}

function renderPeople(view) {
  const owner = isOwner();
  view.append(el('h2', { textContent: menuLabel(session) }));

  if (owner) {
    const rename = el('form', { className: 'rename-menu' },
      el('input', { name: 'name', value: session.name, placeholder: 'Nombre del menú (p. ej. Casa)', autocomplete: 'off' }),
      el('button', { type: 'submit', textContent: 'Cambiar nombre' }));
    rename.name.dataset.focusKey = 'menu-name';
    rename.onsubmit = ev => {
      ev.preventDefault();
      const name = rename.name.value.trim();
      if (name !== session.name) store.renameMenu(name);
    };
    view.append(rename,
      el('p', { className: 'hint', textContent: 'Estas personas pueden ver y editar el menú entrando con su cuenta de Google. Envíales el enlace: ' },
        el('code', { textContent: location.origin + location.pathname })));
  } else {
    view.append(el('p', { className: 'hint', textContent: 'Personas con acceso a este menú. Ponte un alias para que los demás vean tu nombre en lugar de tu correo.' }));
  }

  const ul = el('ul', { className: 'ingredients members entry' });
  [session.owner, ...session.members].forEach(person => {
    const alias = session.aliases[person];
    const role = [person === session.owner ? 'Propietario' : '', person === session.email ? 'tú' : ''].filter(Boolean).join(' · ');
    const row = el('li', {},
      el('div', { className: 'name' },
        el('div', { textContent: alias || person }),
        alias ? el('div', { className: 'where', textContent: person }) : ''),
      role ? el('span', { className: 'role', textContent: role }) : '');
    // El propietario pone alias a todos; cada persona, el suyo.
    if (owner || person === session.email) {
      row.append(el('button', {
        className: alias ? 'qty' : 'qty empty-qty',
        textContent: alias ? 'Cambiar alias' : '+ alias',
        title: 'Nombre que se verá en lugar del correo',
        onclick: () => {
          const value = prompt(`Alias de ${person} (déjalo vacío para quitarlo):`, alias || '');
          if (value !== null && value.trim() !== (alias || '')) store.setAlias(person, value.trim().slice(0, 30));
        },
      }));
    }
    if (owner && person !== session.owner) {
      row.append(el('button', {
        className: 'icon', textContent: '✕', title: 'Quitar acceso',
        onclick: () => {
          if (confirm(`¿Quitar el acceso a ${display(person)}?`)) store.setMembers(session.members.filter(m => m !== person));
        },
      }));
    }
    ul.append(row);
  });
  view.append(ul);

  if (owner) {
    const form = el('form');
    form.innerHTML = `
      <input name="email" type="email" data-focus-key="member" placeholder="Email de Google (p. ej. ana@gmail.com)" autocomplete="off" required>
      <input name="alias" data-focus-key="member-alias" class="alias-input" placeholder="Alias (opcional)" autocomplete="off" maxlength="30">
      <button type="submit">Dar acceso</button>`;
    form.onsubmit = ev => {
      ev.preventDefault();
      const email = form.email.value.trim().toLowerCase();
      const alias = form.alias.value.trim();
      if (!email || email === session.owner || session.members.includes(email)) return;
      form.email.value = form.alias.value = '';
      store.setMembers([...session.members, email]);
      if (alias) store.setAlias(email, alias);
    };
    view.append(form);
  }

  if (creators.admin) renderCreators(view);

  // Quien está autorizado puede tener varios menús y compartirlos con quien quiera.
  if (creators.canCreate) view.append(el('div', { className: 'toolbar' }, el('button', {
    textContent: '+ Crear otro menú',
    onclick: () => {
      const name = prompt('Nombre del nuevo menú (p. ej. Casa de la playa):');
      if (name && name.trim()) store.createMenu(name.trim(), session.aliases[session.email]);
    },
  })));
}

// Solo el administrador: emails que pueden crear sus propios menús.
function renderCreators(view) {
  view.append(
    el('h2', { className: 'section', textContent: 'Quién puede crear menús' }),
    el('p', { className: 'hint', textContent: 'Además de ti, solo estas personas pueden crear sus propios menús. Las demás solo entran en los menús a los que las invitan.' }));
  if (creators.list.length) {
    view.append(el('ul', { className: 'ingredients members entry' }, ...creators.list.map(person => el('li', {},
      el('span', { className: 'name', textContent: display(person) === person ? person : `${display(person)} · ${person}` }),
      el('button', {
        className: 'icon', textContent: '✕', title: 'Quitar permiso',
        onclick: () => {
          if (confirm(`¿Quitar a ${person} el permiso para crear menús? Los menús que ya tenga no se borran.`)) store.setCreator(person, false);
        },
      })))));
  } else {
    view.append(el('p', { className: 'empty', textContent: 'De momento, solo tú.' }));
  }
  const form = el('form');
  form.innerHTML = `
    <input name="email" type="email" data-focus-key="creator" placeholder="Email de Google" autocomplete="off" required>
    <button type="submit">Permitir crear menús</button>`;
  form.onsubmit = ev => {
    ev.preventDefault();
    const email = form.email.value.trim().toLowerCase();
    if (!email || email === session.email || creators.list.includes(email)) return;
    form.email.value = '';
    focusNext = 'creator';
    store.setCreator(email, true);
  };
  view.append(form);
}

function render() {
  // Conserva el foco y lo escrito: la vista se redibuja también cuando otra persona cambia algo.
  const active = document.activeElement;
  const focusKey = active?.dataset?.focusKey;
  const typed = active?.value;

  renderAccount();
  renderMenuPicker();
  renderWeekNav();
  renderTabs();
  const view = document.getElementById('view');
  view.innerHTML = '';
  if (errorMessage) view.append(el('p', { className: 'error', textContent: errorMessage }));

  if (session && session.status !== 'ready') renderGate(view);
  else if (current === SHOPPING) renderShopping(view);
  else if (current === SHARING && ready()) renderPeople(view);
  else if (current === TASKS) renderTasks(view);
  else if (current === RECIPES) renderRecipes(view);
  else renderDay(view, week.includes(current) ? current : (current = week[0]));
  try { sessionStorage.setItem(TAB_KEY, current); } catch (e) { /* sin almacenamiento */ }

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
    const { createFirebaseStore } = await import('./firebase-store.js?v=17');
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
