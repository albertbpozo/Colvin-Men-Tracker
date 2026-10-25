// Menú compartido en Firestore con inicio de sesión de Google.
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const MENU_ID = 'principal';

export async function createFirebaseStore(config, days, { onData, onStatus, onError }) {
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
  const fail = err => onError(err);

  let listeners = [];
  let entryIds = [];
  const stopListening = () => { listeners.forEach(stop => stop()); listeners = []; };

  function listenEntries() {
    listeners.push(fs.onSnapshot(entriesRef, snap => {
      const data = Object.fromEntries(days.map(d => [d, []]));
      entryIds = snap.docs.map(d => d.id);
      snap.docs.forEach(d => {
        const entry = { id: d.id, ...d.data() };
        data[entry.day]?.push(entry);
      });
      onData(data);
    }, fail));
  }

  auth.onAuthStateChanged(authInstance, user => {
    stopListening();
    if (!user) return onStatus({ status: 'signed-out' });

    const email = user.email.toLowerCase();
    onStatus({ status: 'loading', email });

    let entriesStarted = false;
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
      if (!entriesStarted) { entriesStarted = true; listenEntries(); }
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
