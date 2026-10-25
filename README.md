# Menú semanal

App web sencilla para planificar el menú de la semana.

- Una pestaña por cada día (lunes a domingo).
- En cada día puedes añadir platos (desayuno, comida, merienda o cena).
- Cada plato tiene su lista de ingredientes; pulsa la etiqueta **Falta / Tengo** para marcar si ya lo tienes.
- La pestaña **🛒 Lista de compra** reúne todos los ingredientes que faltan de la semana, agrupados, y permite marcarlos como comprados.
- Con Firebase configurado, el menú se comparte entre personas y dispositivos: cada uno entra con su cuenta de Google y los cambios se ven al momento. El propietario decide quién tiene acceso en **👥 Compartir**.

## Modos

- **Local** (si `firebase-config.js` exporta `null`): los datos se guardan solo en el navegador.
- **Compartido** (con la configuración de Firebase): los datos viven en Firestore. Funciona también sin cobertura y sincroniza al recuperarla.

## Configurar Firebase (una sola vez)

1. Entra en <https://console.firebase.google.com> → **Crear un proyecto** (puedes desactivar Google Analytics).
2. **Authentication** → Comenzar → **Sign-in method** → activa **Google**.
   En **Settings → Authorized domains** añade `albertbpozo.github.io`.
3. **Firestore Database** → Crear base de datos → modo **producción** → ubicación en Europa (p. ej. `eur3`).
4. En Firestore → **Reglas**, pega el contenido de [`firestore.rules`](firestore.rules), cambia `TU_EMAIL@gmail.com` por el email de tu cuenta de Google (en minúsculas) y pulsa **Publicar**.
5. **Configuración del proyecto** (⚙️) → **Tus apps** → icono web `</>` → registra la app (sin Hosting) y copia el objeto `firebaseConfig` en [`firebase-config.js`](firebase-config.js).

La primera vez que el propietario entra, se crea el menú. Después, en **👥 Compartir** puede añadir los emails de Google de las demás personas.

## Uso

La app usa módulos de JavaScript, así que hay que abrirla desde un servidor web (no con doble clic en `index.html`):

- Publicada con GitHub Pages: <https://albertbpozo.github.io/Colvin-Men-Tracker/>
- En local: `python3 -m http.server` y abrir <http://localhost:8000>.
