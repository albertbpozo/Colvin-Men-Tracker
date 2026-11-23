// Recetas: leer el formato de texto (el que genera Claude) y escalar cantidades
// al cambiar el número de raciones.

// Instrucciones para pedirle recetas a Claude (o a cualquier asistente).
export const RECIPE_PROMPT = `Escribe las recetas que te pida en este formato exacto, para importarlas en mi app de menú semanal. Si son varias, ponlas una detrás de otra.

# Nombre de la receta
Raciones: 4
Ingredientes:
- Ingrediente: cantidad
- Otro ingrediente: cantidad
Pasos:
1. Primer paso.
2. Segundo paso.

Reglas:
- Pon siempre la línea «Raciones:» con un número.
- Un ingrediente por línea, con el formato «Nombre: cantidad». Escribe la cantidad empezando por un número y su unidad (300 g, 1,5 l, 2 dientes, 1/2 cucharadita) para que se pueda escalar; si no tiene cantidad, pon «al gusto».
- Nombres de ingredientes cortos y genéricos (Lentejas, Cebolla, Aceite de oliva), sin la cantidad ni la preparación.
- Un paso por línea, sin texto antes ni después de las recetas.`;

// ---------- Cantidades ----------

const FRACTION_CHARS = { '½': 1 / 2, '¼': 1 / 4, '¾': 3 / 4, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 1 / 8 };
const FRAC = '[½¼¾⅓⅔⅛]';
const DEC = String.raw`\d+(?:[.,]\d+)?`;
// Un número: "1 1/2", "1/2", "1,5", "1½" o "½".
const NUMBER = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|${DEC}(?:\s*${FRAC})?|${FRAC})`;
const AMOUNT_RE = new RegExp(String.raw`^\s*(${NUMBER})(?:\s*(?:-|–|a)\s*(${NUMBER}))?(?![\d/])(.*)$`, 'i');
const METRIC_RE = /^\s*(k?g|gr|gramos?|kilos?|mg|m?l|cl|dl|litros?|mililitros?)\b/i;

function toNumber(text) {
  let s = text.trim();
  let total = 0;
  const frac = s.match(new RegExp(`${FRAC}$`));
  if (frac) {
    total += FRACTION_CHARS[frac[0]];
    s = s.slice(0, -1).trim();
  }
  for (const part of s.split(/\s+/).filter(Boolean)) {
    if (part.includes('/')) {
      const [a, b] = part.split('/').map(Number);
      total += a / b;
    } else {
      total += Number(part.replace(',', '.'));
    }
  }
  return total;
}

// Separa el número del principio de una cantidad ("300 g" → 300 y " g").
export function parseAmount(qty) {
  const m = String(qty ?? '').match(AMOUNT_RE);
  if (!m) return null;
  const from = toNumber(m[1]);
  const to = m[2] ? toNumber(m[2]) : null;
  if (!Number.isFinite(from) || (to !== null && !Number.isFinite(to))) return null;
  return { from, to, rest: m[3] };
}

const NICE_FRACTIONS = [[1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [1 / 2, '½'], [2 / 3, '⅔'], [3 / 4, '¾']];
const decimal = (n, digits) => String(Math.round(n * 10 ** digits) / 10 ** digits).replace('.', ',');

// Redondea a algo que se pueda medir en la cocina.
export function formatNumber(n, metric = false) {
  if (metric) {
    if (n >= 100) return String(Math.round(n / 5) * 5);
    if (n >= 10) return String(Math.round(n));
    return decimal(n, 1);
  }
  if (n >= 10) return String(Math.round(n));
  const whole = Math.floor(n);
  const part = n - whole;
  if (part < 0.05) return String(whole || decimal(n, 2));
  if (part > 0.95) return String(whole + 1);
  for (const [value, char] of NICE_FRACTIONS) {
    if (Math.abs(part - value) < 0.04) return whole ? `${whole} ${char}` : char;
  }
  return decimal(n, 1);
}

// Multiplica la cantidad por `factor`; si no empieza por un número
// ("al gusto", "un chorrito") se queda igual.
export function scaleQty(qty, factor) {
  if (!qty || factor === 1) return qty || '';
  const amount = parseAmount(qty);
  if (!amount) return qty;
  // Por debajo de 1 kg o 1 l, mejor en gramos o mililitros.
  const big = amount.rest.match(/^(\s*)(kg|kilos?|l|litros?)\b(.*)$/i);
  if (big && amount.from * factor < 1) {
    amount.rest = `${big[1] || ' '}${/^k/i.test(big[2]) ? 'g' : 'ml'}${big[3]}`;
    factor *= 1000;
  }
  const metric = METRIC_RE.test(amount.rest);
  const from = formatNumber(amount.from * factor, metric);
  const to = amount.to === null ? '' : `-${formatNumber(amount.to * factor, metric)}`;
  return `${from}${to}${amount.rest}`;
}

// ---------- Ingredientes en texto ----------

const UNITS = String.raw`(?:kg|g|gr|gramos?|kilos?|mg|l|ml|cl|dl|litros?|mililitros?|cucharadas?|cucharaditas?|cdas?|cdtas?|tazas?|vasos?|dientes?|unidades?|uds?|latas?|botes?|sobres?|pizcas?|ramas?|ramitas?|hojas?|rebanadas?|lonchas?|filetes?|puñados?|chorritos?|chorros?|manojos?|piezas?)\.?`;
const QTY_FIRST_RE = new RegExp(String.raw`^(${NUMBER}(?:\s*(?:-|–|a)\s*${NUMBER})?(?:\s*${UNITS})?)\s+(?:de\s+)?(.+)$`, 'i');
const TO_TASTE_RE = /^(.+?)[\s,]+(al gusto|c\/s|cantidad suficiente|una pizca|un chorrito|un poco)$/i;

const capitalize = s => s ? s[0].toUpperCase() + s.slice(1) : s;

// "Lentejas: 300 g", "300 g de lentejas", "2 huevos" o "Sal al gusto".
export function parseIngredient(text) {
  const line = text.trim();
  let m = line.match(/^([^:]+):\s*(.*)$/);
  if (m) return { name: capitalize(m[1].trim()), qty: m[2].trim() };
  m = line.match(QTY_FIRST_RE);
  if (m) return { name: capitalize(m[2].trim()), qty: m[1].trim() };
  m = line.match(TO_TASTE_RE);
  if (m) return { name: capitalize(m[1].trim()), qty: m[2].trim() };
  return { name: capitalize(line), qty: '' };
}

export const ingredientLine = i => i.qty ? `${i.name}: ${i.qty}` : i.name;

// ---------- Recetas en texto ----------

export const DEFAULT_SERVINGS = 4;
const HEADING = String.raw`^(?:#+\s*)?\**\s*`;
const SERVINGS_RE = new RegExp(`${HEADING}(?:raciones|porciones|personas|comensales)\\s*\\**\\s*:?\\s*\\**\\s*(\\d+)`, 'i');
const FOR_PEOPLE_RE = /(\d+)\s*(?:raciones|porciones|personas|comensales)/i;
const INGREDIENTS_RE = new RegExp(`${HEADING}ingredientes\\b`, 'i');
const STEPS_RE = new RegExp(`${HEADING}(?:pasos|preparación|preparacion|elaboración|elaboracion|instrucciones|modo de hacerlo)\\b`, 'i');

// Lee una o varias recetas. Cada una empieza con «# Nombre»; si el texto no
// tiene ningún «#», la primera línea es el nombre.
export function parseRecipes(text) {
  const recipes = [];
  let recipe = null;
  let section = null;
  const start = name => {
    recipe = { name: name.replace(/\*+/g, '').trim(), servings: 0, ingredients: [], steps: [] };
    recipes.push(recipe);
    section = null;
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^```/.test(line)) continue;
    let m = line.match(/^#\s+(.+)$/);
    if (m) { start(m[1]); continue; }
    if (!recipe) { start(line.replace(/^#+\s*/, '')); continue; }
    if ((m = line.match(SERVINGS_RE))) { recipe.servings = Number(m[1]); continue; }
    if (INGREDIENTS_RE.test(line)) {
      section = 'ingredients';
      if ((m = line.match(FOR_PEOPLE_RE)) && !recipe.servings) recipe.servings = Number(m[1]);
      continue;
    }
    if (STEPS_RE.test(line)) { section = 'steps'; continue; }
    const isListItem = /^([-*•]|\d+[.)])\s+/.test(line);
    const item = line.replace(/^([-*•]|\d+[.)])\s+/, '').trim();
    if (!item) continue;
    if (section === 'ingredients' || (!section && /^[-*•]/.test(line))) {
      recipe.ingredients.push(parseIngredient(item));
    } else if (section === 'steps' || isListItem) {
      recipe.steps.push(item);
    } else {
      recipe.steps.push(item);
    }
  }
  return recipes
    .filter(r => r.name && (r.ingredients.length || r.steps.length))
    .map(r => ({ ...r, servings: r.servings || DEFAULT_SERVINGS }));
}
