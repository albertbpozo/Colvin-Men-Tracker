# Menú semanal

App web sencilla para planificar el menú de la semana.

- Calendario por semanas: cambia de semana con ‹ › para planificar la siguiente (o repasar las anteriores); **Hoy** vuelve a la semana actual.
- Una pestaña por cada día de la semana, con su fecha.
- En cada día puedes añadir platos (desayuno, comida, merienda o cena).
- Cada plato tiene su lista de ingredientes, con cantidad opcional; pulsa la etiqueta **Falta / Tengo** para marcar si ya lo tienes y la cantidad para cambiarla.
- La pestaña **🛒 Lista de compra** tiene una **lista general** (productos sueltos, la misma para todas las semanas) y, debajo, los ingredientes que faltan para el menú de la semana que estás viendo, agrupados. Todo se puede marcar como comprado.
- Lo que marcas como comprado aparece en **Ya comprado**, compartido con todos, y se puede **Deshacer** si te equivocas. **Terminar compra** vacía esa lista (pide doble confirmación); también se vacía sola tras 12 horas sin comprar nada.
- Cada producto de la lista de compra puede llevar una **foto** (📷): pulsa la miniatura para verla en grande, cambiarla o quitarla. Va por nombre, así que la foto de «Leche» sale en todas las listas y semanas.
- La pestaña **✅ Tareas** es una lista de tareas pendientes aparte del menú: añade una tarea, asígnala a una persona (con Firebase, a cualquiera con acceso al menú; en modo local, a cualquier nombre) y márcala como **Hecha**. Se puede cambiar a quién está asignada, filtrar por **Mis tareas** y editar el texto con doble clic. El número de la pestaña son tus tareas pendientes.
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
