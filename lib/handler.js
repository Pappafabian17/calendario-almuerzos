// API compartida: la usan tanto server.js (local) como la función de Netlify.
//
// Roles (según el código que se envía en la cabecera X-Code):
//   admin     -> contraseña ADMIN_PASSWORD: todo.
//   leader    -> código de líder de un barrio: gestiona ese barrio y ve datos privados.
//   missionary-> código de misioneros de un barrio: ve teléfono, dirección y mapa de ese barrio y confirma las comidas.
//   public    -> sin código: solo puede anotarse (no edita ni elimina).
import crypto from 'node:crypto';
import { getDb } from './db.js';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'misioneros';
const TIMEZONE = process.env.TIMEZONE || 'America/Argentina/Buenos_Aires';
const MEALS = ['almuerzo', 'cena'];
const MODES = ['casa', 'vianda'];
const STATUSES = ['pendiente', 'confirmado', 'no_puede'];
const PREP_DAY = 1; // lunes: día de preparación de los élderes, no se puede reservar

const DEFAULTS = {
  title: 'Comidas para los misioneros',
  info: 'Anótate en un día libre para darles de comer a los misioneros. ¡Gracias por tu servicio!',
  time_almuerzo: '13:00',
  time_cena: '20:00',
  // Hora a partir de la cual esa comida ya pasó y no se puede reservar (el mismo día).
  end_almuerzo: '16:00',
  end_cena: '23:00',
};

const json = (code, body) => Response.json(body, { status: code });
const fail = (code, error) => json(code, { error });
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const isPrepDay = (date) => new Date(date + 'T00:00:00Z').getUTCDay() === PREP_DAY;
const nowHM = () => new Date().toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false });
// ¿Ya pasó esa comida? Antes de hoy, o hoy pero pasada su hora límite.
const isOver = (date, meal, cfg) => date < today() || (date === today() && nowHM() >= cfg[`end_${meal}`]);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
const readBody = async (req) => { try { return await req.json(); } catch { return {}; } };

function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function authenticate(req, db) {
  const code = (req.headers.get('x-code') || '').trim();
  if (!code) return { role: 'public' };
  if (safeEqual(code, ADMIN_PASSWORD)) return { role: 'admin' };
  const row = (await db.execute({
    sql: 'SELECT id, leader_code, missionary_code FROM barrios WHERE leader_code = ? OR missionary_code = ?',
    args: [code, code],
  })).rows[0];
  if (!row) return { role: 'public', badCode: true };
  return { role: row.leader_code === code ? 'leader' : 'missionary', barrioId: Number(row.id) };
}

// Puede ver teléfono, dirección y mapa del barrio.
const canSeePrivate = (a, barrioId) => a.role === 'admin' || (a.barrioId === barrioId && (a.role === 'leader' || a.role === 'missionary'));
// Puede cancelar registros, bloquear días y editar misioneros del barrio.
const canManage = (a, barrioId) => a.role === 'admin' || (a.role === 'leader' && a.barrioId === barrioId);

async function getConfig(db) {
  const cfg = { ...DEFAULTS };
  for (const r of (await db.execute('SELECT key, value FROM config')).rows) cfg[r.key] = r.value;
  return cfg;
}

const barrioExists = async (db, id) => (await db.execute({ sql: 'SELECT 1 FROM barrios WHERE id = ?', args: [id] })).rows.length > 0;

async function codeTaken(db, code, exceptId = 0) {
  if (safeEqual(code, ADMIN_PASSWORD)) return true;
  return (await db.execute({
    sql: 'SELECT 1 FROM barrios WHERE (leader_code = ? OR missionary_code = ?) AND id != ?',
    args: [code, code, exceptId],
  })).rows.length > 0;
}

async function saveBarrio(db, req, id) {
  const b = await readBody(req);
  const name = clip(b.name, 60), leader = clip(b.leader_code, 40), missionary = clip(b.missionary_code, 40);
  if (!name) return fail(400, 'El barrio necesita un nombre');
  if (leader.length < 4 || missionary.length < 4) return fail(400, 'Los códigos deben tener al menos 4 caracteres');
  if (leader === missionary) return fail(400, 'El código de líder y el de misioneros deben ser distintos');
  if ((await codeTaken(db, leader, id)) || (await codeTaken(db, missionary, id))) return fail(409, 'Alguno de los códigos ya está en uso');
  try {
    if (id) {
      await db.execute({ sql: 'UPDATE barrios SET name = ?, leader_code = ?, missionary_code = ? WHERE id = ?', args: [name, leader, missionary, id] });
      return json(200, { id });
    }
    const r = await db.execute({ sql: 'INSERT INTO barrios (name, leader_code, missionary_code) VALUES (?, ?, ?)', args: [name, leader, missionary] });
    return json(201, { id: Number(r.lastInsertRowid) });
  } catch {
    return fail(409, 'Ya existe un barrio con ese nombre');
  }
}

export async function handle(req) {
  const url = new URL(req.url);
  const db = await getDb();
  const auth = await authenticate(req, db);
  const tokens = (req.headers.get('x-tokens') || '').split(',').filter(Boolean);
  const { pathname: p, searchParams: q } = url;
  const route = `${req.method} ${p}`;
  let m;

  // ---- Sesión y configuración
  if (route === 'GET /api/me') {
    if (auth.badCode) return fail(401, 'Código incorrecto');
    return json(200, { role: auth.role, barrioId: auth.barrioId ?? null });
  }
  if (route === 'GET /api/config') return json(200, await getConfig(db));
  if (route === 'PUT /api/config') {
    if (auth.role !== 'admin') return fail(401, 'Solo el administrador');
    const b = await readBody(req);
    const stmts = Object.keys(DEFAULTS).filter((k) => k in b).map((k) => ({
      sql: 'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      args: [k, clip(b[k], 1000)],
    }));
    if (stmts.length) await db.batch(stmts);
    return json(200, await getConfig(db));
  }

  // ---- Barrios (solo el admin los crea y edita)
  if (route === 'GET /api/barrios') {
    const rows = (await db.execute('SELECT * FROM barrios ORDER BY name')).rows;
    return json(200, rows.map((r) => ({
      id: Number(r.id), name: r.name,
      ...(auth.role === 'admin' ? { leader_code: r.leader_code, missionary_code: r.missionary_code } : {}),
    })));
  }
  if (route === 'POST /api/barrios') {
    if (auth.role !== 'admin') return fail(401, 'Solo el administrador');
    return saveBarrio(db, req, 0);
  }
  if ((m = p.match(/^\/api\/barrios\/(\d+)$/))) {
    const id = Number(m[1]);
    if (auth.role !== 'admin') return fail(401, 'Solo el administrador');
    if (req.method === 'PUT') return saveBarrio(db, req, id);
    if (req.method === 'DELETE') {
      await db.batch(['meals', 'missionaries', 'blocked'].map((t) => ({ sql: `DELETE FROM ${t} WHERE barrio_id = ?`, args: [id] }))
        .concat({ sql: 'DELETE FROM barrios WHERE id = ?', args: [id] }));
      return json(200, { ok: true });
    }
  }

  // ---- Misioneros de un barrio
  if ((m = p.match(/^\/api\/barrios\/(\d+)\/missionaries$/))) {
    const barrioId = Number(m[1]);
    if (req.method === 'GET') {
      const rows = (await db.execute({ sql: 'SELECT * FROM missionaries WHERE barrio_id = ? ORDER BY name', args: [barrioId] })).rows;
      const priv = canSeePrivate(auth, barrioId);
      return json(200, rows.map((r) => ({ id: Number(r.id), name: r.name, phone: priv ? r.phone : undefined })));
    }
    if (req.method === 'POST') {
      if (!canManage(auth, barrioId)) return fail(401, 'No autorizado');
      const b = await readBody(req);
      const name = clip(b.name, 80);
      if (!name) return fail(400, 'Falta el nombre');
      if (!(await barrioExists(db, barrioId))) return fail(404, 'Barrio inexistente');
      await db.execute({ sql: 'INSERT INTO missionaries (barrio_id, name, phone) VALUES (?, ?, ?)', args: [barrioId, name, clip(b.phone, 30)] });
      return json(201, { ok: true });
    }
  }
  if ((m = p.match(/^\/api\/missionaries\/(\d+)$/)) && req.method === 'DELETE') {
    const row = (await db.execute({ sql: 'SELECT barrio_id FROM missionaries WHERE id = ?', args: [Number(m[1])] })).rows[0];
    if (!row) return fail(404, 'No encontrado');
    if (!canManage(auth, Number(row.barrio_id))) return fail(401, 'No autorizado');
    await db.batch([
      { sql: 'DELETE FROM meals WHERE companionship_id = ?', args: [Number(m[1])] },
      { sql: 'DELETE FROM missionaries WHERE id = ?', args: [Number(m[1])] },
    ]);
    return json(200, { ok: true });
  }

  // ---- Comidas anotadas
  if (route === 'GET /api/meals') {
    const barrioId = Number(q.get('barrio'));
    const month = q.get('month') || '';
    if (!barrioId || !/^\d{4}-\d{2}$/.test(month)) return fail(400, 'Barrio o mes inválido');
    const like = `${month}-%`;
    const priv = canSeePrivate(auth, barrioId);
    const manage = canManage(auth, barrioId);
    const comp = Number(q.get('comp')) || 0;
    const rows = (await db.execute({
      sql: `SELECT * FROM meals WHERE barrio_id = ? AND date LIKE ?${comp ? ' AND companionship_id = ?' : ''} ORDER BY date`,
      args: comp ? [barrioId, like, comp] : [barrioId, like],
    })).rows;
    const compPhones = new Map((await db.execute({ sql: 'SELECT id, phone FROM missionaries WHERE barrio_id = ?', args: [barrioId] })).rows.map((r) => [Number(r.id), r.phone]));
    const meals = rows.map((r) => {
      const mine = tokens.includes(r.token);
      return {
        id: Number(r.id), date: r.date, meal: r.meal, mode: r.mode, family: r.family, notes: r.notes, mine, companionship_id: Number(r.companionship_id), status: r.status || 'pendiente', status_note: r.status_note || '',
        phone: priv || mine ? r.phone : undefined, address: priv ? r.address : undefined,
        // Teléfono del compañerismo: solo para quienes gestionan el barrio (líderes y admin).
        comp_phone: manage ? compPhones.get(Number(r.companionship_id)) || '' : undefined,
      };
    });
    const blocked = (await db.execute({ sql: 'SELECT date, reason FROM blocked WHERE barrio_id = ? AND date LIKE ?', args: [barrioId, like] })).rows
      .map((r) => ({ date: r.date, reason: r.reason }));
    return json(200, { meals, blocked });
  }
  if (route === 'POST /api/meals') {
    const b = await readBody(req);
    const barrioId = Number(b.barrio), date = String(b.date || '');
    const meal = String(b.meal), mode = String(b.mode);
    const family = clip(b.family, 80), phone = clip(b.phone, 30), address = clip(b.address, 200);
    if (!(await barrioExists(db, barrioId))) return fail(400, 'Barrio inválido');
    if (!isDate(date)) return fail(400, 'Fecha inválida');
    if (!MEALS.includes(meal) || !MODES.includes(mode)) return fail(400, 'Comida o modalidad inválida');
    if (!family || !phone) return fail(400, 'El nombre de la familia y el teléfono son obligatorios');
    if (!address) return fail(400, 'Indica la dirección (donde comen los misioneros o donde retiran la vianda)');
    if (isPrepDay(date)) return fail(400, 'Los lunes son el día de preparación de los misioneros');
    if (isOver(date, meal, await getConfig(db)) && !canManage(auth, barrioId)) return fail(400, 'Ese almuerzo o cena ya pasó');
    const comps = (await db.execute({ sql: 'SELECT id FROM missionaries WHERE barrio_id = ?', args: [barrioId] })).rows.map((r) => Number(r.id));
    const comp = comps.length ? Number(b.companionship) : 0;
    if (comps.length && !comps.includes(comp)) return fail(400, 'Elige a qué compañerismo invitas');
    const isBlocked = (await db.execute({ sql: 'SELECT 1 FROM blocked WHERE barrio_id = ? AND date = ?', args: [barrioId, date] })).rows.length > 0;
    if (isBlocked) return fail(409, 'Ese día no está disponible');
    const token = crypto.randomBytes(16).toString('hex');
    try {
      const r = await db.execute({
        sql: 'INSERT INTO meals (barrio_id, companionship_id, date, meal, mode, family, phone, address, notes, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [barrioId, comp, date, meal, mode, family, phone, address, clip(b.notes, 300), token],
      });
      return json(201, { id: Number(r.lastInsertRowid), token });
    } catch {
      return fail(409, 'Ese horario ya fue tomado por otra familia');
    }
  }
  // Confirmación: misioneros del barrio, líderes del barrio o admin marcan si pueden asistir.
  if ((m = p.match(/^\/api\/meals\/(\d+)\/status$/)) && req.method === 'PUT') {
    const row = (await db.execute({ sql: 'SELECT barrio_id FROM meals WHERE id = ?', args: [Number(m[1])] })).rows[0];
    if (!row) return fail(404, 'No encontrado');
    if (!canSeePrivate(auth, Number(row.barrio_id))) return fail(403, 'Solo los misioneros, líderes o el administrador pueden confirmar');
    const b = await readBody(req);
    const status = String(b.status);
    if (!STATUSES.includes(status)) return fail(400, 'Estado inválido');
    await db.execute({
      sql: 'UPDATE meals SET status = ?, status_note = ? WHERE id = ?',
      args: [status, status === 'no_puede' ? clip(b.note, 200) : '', Number(m[1])],
    });
    return json(200, { ok: true });
  }

  // Editar: solo líder del barrio o admin. No se puede cambiar el día ni la comida.
  if ((m = p.match(/^\/api\/meals\/(\d+)$/)) && req.method === 'PUT') {
    const row = (await db.execute({ sql: 'SELECT barrio_id, companionship_id, mode, address FROM meals WHERE id = ?', args: [Number(m[1])] })).rows[0];
    if (!row) return fail(404, 'No encontrado');
    const barrioId = Number(row.barrio_id);
    if (!canManage(auth, barrioId)) return fail(403, 'Solo el administrador o los líderes pueden editar registros');
    const b = await readBody(req);
    const mode = String(b.mode);
    const family = clip(b.family, 80), phone = clip(b.phone, 30), address = clip(b.address, 200);
    if (!MODES.includes(mode)) return fail(400, 'Modalidad inválida');
    if (!family || !phone) return fail(400, 'El nombre de la familia y el teléfono son obligatorios');
    if (!address) return fail(400, 'Indica la dirección (donde comen los misioneros o donde retiran la vianda)');
    const comps = (await db.execute({ sql: 'SELECT id FROM missionaries WHERE barrio_id = ?', args: [barrioId] })).rows.map((r) => Number(r.id));
    const comp = comps.length ? Number(b.companionship) : 0;
    if (comps.length && !comps.includes(comp)) return fail(400, 'Elige a qué compañerismo invitas');
    const changedPlan = comp !== Number(row.companionship_id) || mode !== row.mode || address !== (row.address || '');
    try {
      await db.execute({
        // Si cambia el compañerismo, la modalidad o la dirección, la confirmación anterior deja de valer.
        sql: `UPDATE meals SET companionship_id = ?, mode = ?, family = ?, phone = ?, address = ?, notes = ?${changedPlan ? ", status = 'pendiente', status_note = ''" : ''} WHERE id = ?`,
        args: [comp, mode, family, phone, address, clip(b.notes, 300), Number(m[1])],
      });
      return json(200, { ok: true });
    } catch {
      return fail(409, 'Ese horario ya está tomado para ese compañerismo');
    }
  }
  if ((m = p.match(/^\/api\/meals\/(\d+)$/)) && req.method === 'DELETE') {
    const row = (await db.execute({ sql: 'SELECT barrio_id FROM meals WHERE id = ?', args: [Number(m[1])] })).rows[0];
    if (!row) return fail(404, 'No encontrado');
    if (!canManage(auth, Number(row.barrio_id))) return fail(403, 'Solo el administrador o los líderes pueden eliminar registros');
    await db.execute({ sql: 'DELETE FROM meals WHERE id = ?', args: [Number(m[1])] });
    return json(200, { ok: true });
  }

  // ---- Días bloqueados
  if ((m = p.match(/^\/api\/blocked\/(\d+)\/(\d{4}-\d{2}-\d{2})$/)) && (req.method === 'PUT' || req.method === 'DELETE')) {
    const barrioId = Number(m[1]), date = m[2];
    if (!canManage(auth, barrioId)) return fail(401, 'No autorizado');
    if (req.method === 'PUT') {
      const b = await readBody(req);
      await db.batch([
        { sql: 'DELETE FROM meals WHERE barrio_id = ? AND date = ?', args: [barrioId, date] },
        { sql: 'INSERT OR REPLACE INTO blocked (barrio_id, date, reason) VALUES (?, ?, ?)', args: [barrioId, date, clip(b.reason, 120)] },
      ]);
    } else {
      await db.execute({ sql: 'DELETE FROM blocked WHERE barrio_id = ? AND date = ?', args: [barrioId, date] });
    }
    return json(200, { ok: true });
  }

  return fail(404, 'No encontrado');
}

export async function safeHandle(req) {
  try { return await handle(req); } catch (e) {
    console.error(e);
    return fail(500, 'Error del servidor');
  }
}
