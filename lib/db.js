// Conexión a la base de datos (Turso/libSQL en producción, archivo local en desarrollo).
const authToken = process.env.DATABASE_AUTH_TOKEN;
// En Netlify (o cualquier hosting sin disco persistente) la base tiene que venir de DATABASE_URL.
const hosted = !!(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
const url = process.env.DATABASE_URL || 'file:almuerzos.db';

// Una fila de "missionaries" es un compañerismo (ej. "Elder Smith y Elder Gomez") con su teléfono de contacto.
// companionship_id = 0 significa "sin compañerismo" (barrios que aún no cargaron ninguno).
const MEALS_DDL = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barrio_id INTEGER NOT NULL,
    companionship_id INTEGER NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    meal TEXT NOT NULL,
    mode TEXT NOT NULL,
    family TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT,
    notes TEXT,
    token TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'pendiente',
    status_note TEXT,
    UNIQUE (barrio_id, companionship_id, date, meal)
  )`;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS barrios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    leader_code TEXT NOT NULL UNIQUE,
    missionary_code TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS missionaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barrio_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    phone TEXT
  )`,
  MEALS_DDL('meals'),
  `CREATE TABLE IF NOT EXISTS blocked (
    barrio_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    reason TEXT,
    PRIMARY KEY (barrio_id, date)
  )`,
  'CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)',
];

let ready;
export function getDb() {
  ready ??= (async () => {
    if (hosted && !process.env.DATABASE_URL) throw new Error('Falta la variable DATABASE_URL en Netlify (o no está disponible para las funciones)');
    // En Netlify se usa el cliente "web" (solo JS, sin binarios nativos).
    // En local, con file:, se carga el cliente completo; el nombre se arma en
    // tiempo de ejecución para que el empaquetador no intente incluirlo.
    const client = url.startsWith('file:')
      ? (await import(['@libsql', 'client'].join('/'))).createClient({ url })
      // libsql:// usa WebSocket, que no existe en todas las versiones de Node de las funciones; https:// usa fetch y funciona siempre.
      : (await import('@libsql/client/web')).createClient({ url: url.replace(/^libsql:/, 'https:'), authToken });
    await client.batch(SCHEMA);
    // Migración: la versión anterior de "meals" no tenía companionship_id (y su UNIQUE era distinto).
    const cols = (await client.execute('PRAGMA table_info(meals)')).rows.map((r) => r.name);
    if (!cols.includes('companionship_id')) {
      await client.batch([
        'ALTER TABLE meals RENAME TO meals_old',
        MEALS_DDL('meals'),
        `INSERT INTO meals (id, barrio_id, date, meal, mode, family, phone, address, notes, token, created_at)
         SELECT id, barrio_id, date, meal, mode, family, phone, address, notes, token, created_at FROM meals_old`,
        'DROP TABLE meals_old',
      ]);
    }
    // Migración: confirmación de los misioneros (pendiente / confirmado / no_puede).
    const cols2 = (await client.execute('PRAGMA table_info(meals)')).rows.map((r) => r.name);
    if (!cols2.includes('status')) {
      await client.batch([
        "ALTER TABLE meals ADD COLUMN status TEXT NOT NULL DEFAULT 'pendiente'",
        'ALTER TABLE meals ADD COLUMN status_note TEXT',
      ]);
    }
    return client;
  })();
  ready.catch(() => { ready = undefined; });
  return ready;
}
