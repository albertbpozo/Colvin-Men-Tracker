# Menú semanal

App web sencilla para planificar el menú de la semana.

- Calendario por semanas: cambia de semana con ‹ › para planificar la siguiente (o repasar las anteriores); **Hoy** vuelve a la semana actual.
- Una pestaña por cada día de la semana, con su fecha.
- En cada día puedes añadir platos (desayuno, comida, merienda o cena).
- Cada plato tiene su lista de ingredientes, con cantidad opcional; pulsa la etiqueta **Falta / Tengo** para marcar si ya lo tienes y la cantidad para cambiarla.
- La pestaña **🛒 Lista de compra** tiene una **lista general** (productos sueltos, la misma para todas las semanas) y, debajo, los ingredientes que faltan para el menú de la semana que estás viendo, agrupados. Todo se puede marcar como comprado.
- Lo que marcas como comprado aparece en **Ya comprado**, compartido con todos, y se puede **Deshacer** si te equivocas. **Terminar compra** vacía esa lista (pide doble confirmación); también se vacía sola tras 12 horas sin comprar nada.
- Cada producto de la lista de compra puede llevar una **foto** (📷): pulsa la miniatura para verla en grande, cambiarla o quitarla. Va por nombre, así que la foto de «Leche» sale en todas las listas y semanas. Las fotos que llevan **un mes sin usarse** (su producto no ha aparecido en la lista general, en «Ya comprado» ni en los platos de la semana que alguien ha abierto) se borran solas: lo comprueba la app al abrirse, una vez al día.
- La pestaña **✅ Tareas** es una lista de tareas pendientes aparte del menú: añade una tarea, asígnala a una persona (con Firebase, a cualquiera con acceso al menú; en modo local, a cualquier nombre) y márcala como **Hecha**. Se puede cambiar a quién está asignada, filtrar por **Mis tareas** y editar el texto con doble clic. El número de la pestaña son tus tareas pendientes.
- **Tareas que se repiten:** al crear una tarea (o con 🔁 en una ya creada) eliges si se repite cada día, cada semana, cada 2 semanas, cada mes u otra frecuencia (cada N días, semanas o meses) y desde qué día. Aparece en Pendientes el día que le toca; al marcarla como hecha pasa a **Programadas** hasta la siguiente fecha (se puede deshacer). Si se pasa el día sin hacerla, sigue pendiente marcada como atrasada, sin acumular copias.
- La pestaña **📖 Recetas** guarda las recetas del menú (ingredientes con cantidad y pasos), compartidas con las personas del menú. Con **− / +** cambias las raciones y las cantidades de los ingredientes se recalculan solas (300 g para 4 → 450 g para 6; por debajo de 1 kg o 1 l pasa a gramos o mililitros). **Añadir al menú** crea el plato en el día y la comida que elijas, con los ingredientes ya ajustados a esas raciones.
- **Importar recetas desde Claude:** en Recetas → **Importar**, pulsa «Copiar instrucciones para Claude», pégaselas a Claude junto con lo que quieras («dame 3 cenas ligeras») y pega su respuesta en el cuadro. Se pueden importar varias recetas a la vez. El formato es:

  ```
  # Lentejas con chorizo
  Raciones: 4
  Ingredientes:
  - Lentejas: 300 g
  - Chorizo: 1
  Pasos:
  1. Sofreír la cebolla.
  2. Cocer 40 minutos.
  ```
- Con Firebase configurado, el menú se comparte entre personas y dispositivos: cada uno entra con su cuenta de Google y los cambios se ven al momento.
- **Varios menús:** el administrador (el email puesto en `firestore.rules`) y las personas que él autorice pueden crear sus propios menús y compartirlos con quien quieran; el resto solo entra en los menús a los que le invitan. Cada persona solo ve los menús en los que está. Si estás en varios, cambias de uno a otro con el selector de arriba. Desde **👥 Personas** se crea otro menú.
- **👥 Personas:** el propietario de cada menú le pone nombre, da o quita acceso por email y puede poner un **alias** a cada persona («Mamá», «Bob»…), que se ve en lugar del correo en toda la app. Cada persona puede cambiar también su propio alias. Los alias van por menú.
- **Quién puede crear menús:** el administrador lo gestiona en **👥 Personas** → «Quién puede crear menús». Quitar el permiso no borra los menús que esa persona ya tenga.

## Modos

- **Local** (si `firebase-config.js` exporta `null`): los datos se guardan solo en el navegador.
- **Compartido** (con la configuración de Firebase): los datos viven en Firestore. Funciona también sin cobertura y sincroniza al recuperarla.

## Configurar Firebase (una sola vez)

1. Entra en <https://console.firebase.google.com> → **Crear un proyecto** (puedes desactivar Google Analytics).
2. **Authentication** → Comenzar → **Sign-in method** → activa **Google**.
   En **Settings → Authorized domains** añade `albertbpozo.github.io`.
3. **Firestore Database** → Crear base de datos → modo **producción** → ubicación en Europa (p. ej. `eur3`).
4. En Firestore → **Reglas**, pega el contenido de [`firestore.rules`](firestore.rules), comprueba que el email de `adminEmail()` es el de la cuenta de Google administradora (en minúsculas) y pulsa **Publicar**. (Si actualizas desde una versión anterior, vuelve a pegarlas.)
5. **Configuración del proyecto** (⚙️) → **Tus apps** → icono web `</>` → registra la app (sin Hosting) y copia el objeto `firebaseConfig` en [`firebase-config.js`](firebase-config.js).

La primera vez que el administrador (o alguien autorizado) entra sin tener menú, la app le ofrece **Crear mi menú**. Después, en **👥 Personas** puede añadir los emails de Google de las demás personas. Los menús creados con versiones anteriores siguen siendo de su propietario.

## Uso

La app usa módulos de JavaScript, así que hay que abrirla desde un servidor web (no con doble clic en `index.html`):

- Publicada con GitHub Pages: <https://albertbpozo.github.io/Colvin-Men-Tracker/>
- En local: `python3 -m http.server` y abrir <http://localhost:8000>.
