// Menús compartidos en Firestore con inicio de sesión de Google. Cada menú
// (menus/{id}) tiene su propietario, las personas con acceso y sus alias.
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
// Último menú abierto en este dispositivo, para volver a él al entrar.
const MENU_KEY = 'menu-semanal-menu';
// La lista de compra general es una entrada con id fijo y day 'general', así
// queda fuera de las consultas por semana y valen las mismas reglas.
const GENERAL_ID = 'compra-general';
// Lo ya comprado en la compra en curso, con el mismo truco (day 'comprado').
const BOUGHT_ID = 'compra-hecha';
const BOUGHT_DOC = { day: 'comprado', meal: 'Compra', name: 'Ya comprado', kind: 'bought' };
// Cada foto de producto es una entrada con day 'foto' (un documento por foto,
// para no pasar del máximo de 1 MB por documento).
const PHOTO_DAY = 'foto';
// Cada tarea pendiente es una entrada con day 'tarea' (un documento por tarea,
// así dos personas pueden cambiar tareas distintas a la vez sin pisarse).
const TASK_DAY = 'tarea';

// Los platos se guardan con `day` = fecha 'AAAA-MM-DD'. Las versiones antiguas
// usaban el nombre del día ('Lunes'…); `legacyDay` lo traduce a una fecha.
export async function createFirebaseStore(config, { onData, onGeneral, onBought, onPhotos, onTasks, onStatus, onCreators, onError, legacyDay, legacyNames }) {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);

  const app = initializeApp(config);
  const authInstance = auth.getAuth(app);
  const db = fs.initializeFirestore(app, {
    // Caché local: la app sigue funcionando sin cobertura y sincroniza al volver.
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
  });
  const menusRef = fs.collection(db, 'menus');
  // Emails autorizados a crear menús (id del documento = email).
  const creatorsRef = fs.collection(db, 'creadores');
  const fail = err => onError(err);

  // Menú abierto: todo lo demás (platos, compra, fotos, tareas) cuelga de él.
  let menuId = null;
  let menuRef = null;
  let entriesRef = null;
  const entryRef = id => fs.doc(entriesRef, id);
  const photoRef = key => entryRef(`foto-${encodeURIComponent(key).replace(/\./g, '%2E')}`);

  let email = null;
  let wanted = null; // menú que se quiere abrir (el último usado o el recién creado)
  try { wanted = localStorage.getItem(MENU_KEY); } catch (e) { /* sin almacenamiento */ }
  // Menús en los que soy propietario y en los que soy miembro (dos consultas).
  let found = { owned: new Map(), shared: new Map() };
  // Menús recién creados que el servidor aún no ha confirmado: hasta entonces
  // las reglas no los ven y leer sus datos daría «sin permiso».
  let unconfirmed = new Set();
  let synced = { owned: false, shared: false };
  let menuListeners = [];
  let authListeners = [];
  let stopEntries = null;
  let week = [];
  let entryIds = [];

  const stopMenu = () => {
    menuListeners.forEach(stop => stop());
    menuListeners = [];
    stopEntries?.();
    stopEntries = null;
    menuId = menuRef = entriesRef = null;
    entryIds = [];
  };
  const stopAll = () => {
    authListeners.forEach(stop => stop());
    authListeners = [];
    stopMenu();
    found = { owned: new Map(), shared: new Map() };
    synced = { owned: false, shared: false };
  };

  // Escucha solo los platos de la semana visible.
  function listenWeek() {
    stopEntries?.();
    stopEntries = null;
    if (!entriesRef || !week.length) return;
    const dates = week;
    const q = fs.query(entriesRef, fs.where('day', '>=', dates[0]), fs.where('day', '<=', dates[dates.length - 1]));
    stopEntries = fs.onSnapshot(q, snap => {
      const data = Object.fromEntries(dates.map(d => [d, []]));
      entryIds = snap.docs.map(d => d.id);
      snap.docs.forEach(d => {
        const entry = { id: d.id, ...d.data() };
        data[entry.day]?.push(entry);
      });
      onData(data);
    }, fail);
  }

  async function migrateLegacyEntries(ref) {
    const snap = await fs.getDocs(fs.query(ref, fs.where('day', 'in', legacyNames)));
    snap.docs.forEach(d => {
      const date = legacyDay(d.data().day);
      if (date) fs.updateDoc(d.ref, { day: date }).catch(fail);
    });
  }

  function openMenu(id) {
    if (id === menuId) return;
    stopMenu();
    menuId = wanted = id;
    try { localStorage.setItem(MENU_KEY, id); } catch (e) { /* sin almacenamiento */ }
    menuRef = fs.doc(menusRef, id);
    entriesRef = fs.collection(menuRef, 'entries');
    listenWeek();
    menuListeners.push(fs.onSnapshot(entryRef(GENERAL_ID),
      snap => onGeneral(snap.exists() ? snap.data().ingredients || [] : []), fail));
    menuListeners.push(fs.onSnapshot(entryRef(BOUGHT_ID),
      snap => onBought(snap.exists() ? snap.data().ingredients || [] : []), fail));
    menuListeners.push(fs.onSnapshot(fs.query(entriesRef, fs.where('day', '==', PHOTO_DAY)),
      snap => onPhotos(Object.fromEntries(snap.docs.map(d => [d.data().key, d.data().photo]))), fail));
    menuListeners.push(fs.onSnapshot(fs.query(entriesRef, fs.where('day', '==', TASK_DAY)),
      snap => onTasks(snap.docs.map(d => ({ id: d.id, ...d.data() }))), fail));
    migrateLegacyEntries(entriesRef).catch(fail);
  }

  // Decide qué menú abrir con lo que devuelven las consultas y avisa a la app.
  function update() {
    const all = new Map([...found.shared, ...found.owned]);
    if (!all.size) {
      // Sin menús: solo lo damos por bueno cuando lo confirma el servidor.
      if (!synced.owned || !synced.shared) return onStatus({ status: 'loading', email });
      stopMenu();
      return onStatus({ status: 'no-menu', email });
    }
    const menus = [...all].map(([id, m]) => ({ id, name: m.name || '', owner: m.owner, aliases: m.aliases || {} }))
      .sort((a, b) => (b.owner === email) - (a.owner === email) || a.id.localeCompare(b.id));
    const id = all.has(wanted) ? wanted : all.has(menuId) ? menuId : menus[0].id;
    // Antes de abrir el menú: la app vacía los datos del anterior al ver otro menuId.
    const menu = all.get(id);
    onStatus({
      status: 'ready', email, menuId: id, menus,
      name: menu.name || '', owner: menu.owner, members: menu.members || [], aliases: menu.aliases || {},
    });
    if (id === menuId || !unconfirmed.has(id)) openMenu(id);
    else stopMenu(); // se abre al confirmarse (llega otra instantánea)
  }

  function watchMenus(key, q) {
    authListeners.push(fs.onSnapshot(q, { includeMetadataChanges: true }, snap => {
      found[key] = new Map(snap.docs.map(d => [d.id, d.data()]));
      if (key === 'owned') unconfirmed = new Set(snap.docs.filter(d => d.metadata.hasPendingWrites).map(d => d.id));
      if (!snap.metadata.fromCache) synced[key] = true;
      update();
    }, err => {
      found[key] = new Map();
      synced[key] = true;
      onError(Object.assign(err, { during: 'menus' }));
      update();
    }));
  }

  // ¿Puedo crear menús? ¿Soy el administrador? Solo las reglas lo saben: si
  // me dejan leer la lista entera soy el administrador; si no, miro si estoy.
  function watchCreators() {
    let admin = false;
    let listed = [];
    let allowed = false;
    const emit = () => onCreators({ admin, canCreate: admin || allowed, list: listed });
    onCreators({ admin: false, canCreate: false, list: [] });
    authListeners.push(fs.onSnapshot(creatorsRef, { includeMetadataChanges: true }, snap => {
      if (snap.metadata.fromCache && !admin) return; // hasta que confirme el servidor
      admin = true;
      listed = snap.docs.map(d => d.id).sort();
      emit();
    }, () => { admin = false; emit(); }));
    authListeners.push(fs.onSnapshot(fs.doc(creatorsRef, email),
      snap => { allowed = snap.exists(); emit(); },
      () => { allowed = false; emit(); }));
  }

  auth.onAuthStateChanged(authInstance, user => {
    stopAll();
    if (!user) {
      email = null;
      return onStatus({ status: 'signed-out' });
    }
    email = user.email.toLowerCase();
    onStatus({ status: 'loading', email });
    watchMenus('owned', fs.query(menusRef, fs.where('owner', '==', email)));
    watchMenus('shared', fs.query(menusRef, fs.where('members', 'array-contains', email)));
    watchCreators();
  });

  return {
    signIn() {
      const provider = new auth.GoogleAuthProvider();
      const signInFailed = err => onError(Object.assign(err, { during: 'sign-in' }));
      auth.signInWithPopup(authInstance, provider).catch(err => {
        if (err.code === 'auth/popup-blocked') auth.signInWithRedirect(authInstance, provider).catch(signInFailed);
        else if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') signInFailed(err);
      });
    },
    setWeek(dates) {
      week = dates;
      listenWeek();
    },
    signOut() {
      auth.signOut(authInstance).catch(fail);
    },
    addEntry(day, meal, name) {
      fs.addDoc(entriesRef, { day, meal, name, ingredients: [], createdAt: Date.now() }).catch(fail);
    },
    deleteEntry(day, entry) {
      fs.deleteDoc(entryRef(entry.id)).catch(fail);
    },
    setIngredients(day, entry, ingredients) {
      fs.updateDoc(entryRef(entry.id), { ingredients }).catch(fail);
    },
    setGeneral(items) {
      fs.setDoc(entryRef(GENERAL_ID), {
        day: 'general', meal: 'Compra', name: 'Lista de compra general', kind: 'general', ingredients: items,
      }).catch(fail);
    },
    // Se añade y quita cada producto por separado para que dos personas
    // comprando a la vez no se pisen.
    addBought(record) {
      fs.setDoc(entryRef(BOUGHT_ID), { ...BOUGHT_DOC, ingredients: fs.arrayUnion(record) }, { merge: true }).catch(fail);
    },
    removeBought(record) {
      fs.updateDoc(entryRef(BOUGHT_ID), { ingredients: fs.arrayRemove(record) }).catch(fail);
    },
    clearBought() {
      fs.setDoc(entryRef(BOUGHT_ID), { ...BOUGHT_DOC, ingredients: [] }).catch(fail);
    },
    setPhoto(key, name, photo) {
      if (photo) fs.setDoc(photoRef(key), { day: PHOTO_DAY, meal: 'Foto', name, kind: 'photo', key, photo, ingredients: [] }).catch(fail);
      else fs.deleteDoc(photoRef(key)).catch(fail);
    },
    addTask(task) {
      fs.addDoc(entriesRef, { day: TASK_DAY, meal: 'Tarea', kind: 'task', ingredients: [], ...task }).catch(fail);
    },
    updateTask(id, changes) {
      fs.updateDoc(entryRef(id), changes).catch(fail);
    },
    deleteTask(id) {
      fs.deleteDoc(entryRef(id)).catch(fail);
    },
    resetWeek() {
      const batch = fs.writeBatch(db);
      entryIds.forEach(id => batch.delete(entryRef(id)));
      batch.commit().catch(fail);
    },
    setMembers(members) {
      fs.updateDoc(menuRef, { members }).catch(fail);
    },
    renameMenu(name) {
      fs.updateDoc(menuRef, { name }).catch(fail);
    },
    // Alias de una persona en el menú abierto; vacío lo quita. Va por campo
    // (aliases.<email>) para que cada miembro pueda cambiar solo el suyo.
    setAlias(person, alias) {
      fs.updateDoc(menuRef, new fs.FieldPath('aliases', person), alias || fs.deleteField()).catch(fail);
    },
    selectMenu(id) {
      wanted = id;
      update();
    },
    setCreator(person, allowed) {
      const ref = fs.doc(creatorsRef, person);
      (allowed ? fs.setDoc(ref, { email: person, by: email, at: Date.now() }) : fs.deleteDoc(ref)).catch(fail);
    },
    createMenu(name, alias) {
      const ref = fs.doc(menusRef);
      wanted = ref.id;
      unconfirmed.add(ref.id);
      fs.setDoc(ref, { owner: email, members: [], name, aliases: alias ? { [email]: alias } : {} }).catch(fail);
    },
  };
}
