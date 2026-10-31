// El ?v= obliga al navegador a descargar la versión nueva tras cada cambio;
// súbelo a la vez en index.html y aquí.
import { firebaseConfig } from './firebase-config.js?v=13';
import { createLocalStore, newIngredientId } from './local-store.js?v=13';

const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const MEALS = ['Desayuno', 'Comida', 'Merienda', 'Cena'];
const SHOPPING = 'compra';
const SHARING = 'compartir';
const TASKS = 'tareas';

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
let tasks = []; // lista de tareas pendientes, independiente del menú
let taskFilter = 'all'; // 'all' | 'mine'

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

function showToast(record) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const box = el('div', { className: 'toast', role: 'status' },
    el('span', { textContent: `${record.name} comprado` }),
    el('button', { textContent: 'Deshacer', onclick: () => { box.remove(); undoBought(record); } }));
  document.body.append(box);
  toastTimer = setTimeout(() => box.remove(), 6000);
}

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
  },
  onGeneral(items) { general = items; render(); },
  onBought(records) {
    bought = [...records].sort((a, b) => b.at - a.at);
    if (boughtExpired()) store.clearBought();
    render();
  },
  onPhotos(map) { photos = map; render(); },
  onTasks(list) { tasks = list; render(); },
  onStatus(s) {
    if (s.menuId !== session?.menuId) {
      // Otro menú (o ninguno): fuera los datos del anterior hasta que lleguen los nuevos.
      days = {}; general = []; bought = []; photos = {}; tasks = []; pendingUndo = null;
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
    gate.append(
      el('p', { textContent: `Aún no tienes ningún menú con la cuenta ${session.email}.` }),
      el('p', { textContent: 'Crea el tuyo, o pide a alguien que te invite con este email desde su pestaña «👥 Personas».' }),
      form,
      el('button', { textContent: 'Entrar con otra cuenta', onclick: () => store.signOut() }),
    );
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
const myPendingTasks = () => tasks.filter(t => !t.done && (!session?.email || t.assignee === session.email));

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
  const status = el('button', {
    className: `status ${task.done ? 'have' : 'missing'}`,
    textContent: task.done ? 'Hecha' : 'Pendiente',
    title: 'Pulsa para cambiar',
    onclick: () => store.updateTask(task.id, { done: !task.done, doneAt: task.done ? null : Date.now() }),
  });
  const del = el('button', {
    className: 'icon', textContent: '✕', title: 'Eliminar tarea',
    onclick: () => { if (confirm(`¿Eliminar la tarea «${task.name}»?`)) store.deleteTask(task.id); },
  });
  const by = task.by && task.by !== task.assignee ? `Creada por ${display(task.by)}` : '';
  const text = el('div', { className: 'name' },
    el('div', { textContent: task.name, ondblclick: () => {
      const value = prompt('Tarea:', task.name);
      if (value && value.trim()) store.updateTask(task.id, { name: value.trim() });
    } }),
    by ? el('div', { className: 'where', textContent: by }) : '');
  const picker = assigneePicker(task.assignee, assignee => store.updateTask(task.id, { assignee }));
  return el('li', { className: task.done ? 'done' : '' }, status, text, picker, del);
}

function renderTasks(view) {
  view.append(el('h2', { textContent: 'Tareas pendientes' }));
  if (!session) {
    view.append(el('datalist', { id: 'task-people' }, ...taskPeople().map(p => el('option', { value: p }))));
  }

  const form = el('form', { className: 'add-task' });
  form.append(
    el('input', { name: 'task', placeholder: 'Nueva tarea (p. ej. Sacar la basura)', autocomplete: 'off', required: true }),
    assigneePicker(lastAssignee, a => { lastAssignee = a; }, 'task-assignee'),
    el('button', { type: 'submit', textContent: 'Añadir' }));
  form.task.dataset.focusKey = 'task';
  form.onsubmit = ev => {
    ev.preventDefault();
    const name = form.task.value.trim();
    if (!name) return;
    const assignee = (form.querySelector('.assignee').value || '').trim();
    lastAssignee = assignee;
    form.task.value = '';
    focusNext = 'task';
    store.addTask({ name, assignee, done: false, createdAt: Date.now(), by: session?.email || '' });
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
  const pending = visible.filter(t => !t.done).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const done = visible.filter(t => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

  if (!pending.length) {
    view.append(el('p', { className: 'empty', textContent: taskFilter === 'mine' ? 'No tienes tareas pendientes.' : 'No hay tareas pendientes.' }));
  } else {
    view.append(el('ul', { className: 'ingredients tasks entry' }, ...pending.map(taskRow)));
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
      el('ul', { className: 'ingredients tasks entry' }, ...done.map(taskRow)));
  }
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

  // Cada persona puede tener sus propios menús y compartirlos con quien quiera.
  view.append(el('div', { className: 'toolbar' }, el('button', {
    textContent: '+ Crear otro menú',
    onclick: () => {
      const name = prompt('Nombre del nuevo menú (p. ej. Casa de la playa):');
      if (name && name.trim()) store.createMenu(name.trim(), session.aliases[session.email]);
    },
  })));
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
    const { createFirebaseStore } = await import('./firebase-store.js?v=13');
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
