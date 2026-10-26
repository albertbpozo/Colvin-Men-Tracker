// Menú compartido en Firestore con inicio de sesión de Google.
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const MENU_ID = 'principal';
// La lista de compra general es una entrada con id fijo y day 'general', así
// queda fuera de las consultas por semana y valen las mismas reglas.
const GENERAL_ID = 'compra-general';
// Lo ya comprado en la compra en curso, con el mismo truco (day 'comprado').
const BOUGHT_ID = 'compra-hecha';
const BOUGHT_DOC = { day: 'comprado', meal: 'Compra', name: 'Ya comprado', kind: 'bought' };
// Cada foto de producto es una entrada con day 'foto' (un documento por foto,
// para no pasar del máximo de 1 MB por documento).
const PHOTO_DAY = 'foto';

// Los platos se guardan con `day` = fecha 'AAAA-MM-DD'. Las versiones antiguas
// usaban el nombre del día ('Lunes'…); `legacyDay` lo traduce a una fecha.
export async function createFirebaseStore(config, { onData, onGeneral, onBought, onPhotos, onStatus, onError, legacyDay, legacyNames }) {
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
  const menuRef = fs.doc(db, 'menus', MENU_ID);
  const entriesRef = fs.collection(menuRef, 'entries');
  const entryRef = id => fs.doc(entriesRef, id);
  const photoRef = key => entryRef(`foto-${encodeURIComponent(key).replace(/\./g, '%2E')}`);
  const fail = err => onError(err);

  let listeners = [];
  let stopEntries = null;
  let ready = false;
  let week = [];
  let entryIds = [];
  const stopListening = () => {
    listeners.forEach(stop => stop());
    listeners = [];
    stopEntries?.();
    stopEntries = null;
    ready = false;
  };

  // Escucha solo los platos de la semana visible.
  function listenWeek() {
    stopEntries?.();
    stopEntries = null;
    if (!ready || !week.length) return;
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

  async function migrateLegacyEntries() {
    const snap = await fs.getDocs(fs.query(entriesRef, fs.where('day', 'in', legacyNames)));
    snap.docs.forEach(d => {
      const date = legacyDay(d.data().day);
      if (date) fs.updateDoc(d.ref, { day: date }).catch(fail);
    });
  }

  auth.onAuthStateChanged(authInstance, user => {
    stopListening();
    if (!user) return onStatus({ status: 'signed-out' });

    const email = user.email.toLowerCase();
    onStatus({ status: 'loading', email });

    listeners.push(fs.onSnapshot(menuRef, { includeMetadataChanges: true }, async snap => {
      if (!snap.exists()) {
        // Solo creamos el menú cuando el servidor confirma que no existe;
        // las reglas solo dejan crearlo al propietario.
        if (snap.metadata.fromCache) return;
        try {
          await fs.setDoc(menuRef, { owner: email, members: [] });
        } catch (e) {
          onStatus({ status: 'denied', email });
        }
        return;
      }
      const menu = snap.data();
      onStatus({ status: 'ready', email, owner: menu.owner, members: menu.members || [] });
      if (!ready) {
        ready = true;
        listenWeek();
        listeners.push(fs.onSnapshot(entryRef(GENERAL_ID),
          snap => onGeneral(snap.exists() ? snap.data().ingredients || [] : []), fail));
        listeners.push(fs.onSnapshot(entryRef(BOUGHT_ID),
          snap => onBought(snap.exists() ? snap.data().ingredients || [] : []), fail));
        listeners.push(fs.onSnapshot(fs.query(entriesRef, fs.where('day', '==', PHOTO_DAY)),
          snap => onPhotos(Object.fromEntries(snap.docs.map(d => [d.data().key, d.data().photo]))), fail));
        migrateLegacyEntries().catch(fail);
      }
    }, () => onStatus({ status: 'denied', email })));
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
    resetWeek() {
      const batch = fs.writeBatch(db);
      entryIds.forEach(id => batch.delete(entryRef(id)));
      batch.commit().catch(fail);
    },
    setMembers(members) {
      fs.updateDoc(menuRef, { members }).catch(fail);
    },
  };
}
