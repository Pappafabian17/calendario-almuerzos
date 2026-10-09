const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const longDate = (s) => new Date(s + 'T00:00').toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
const MEAL_LABEL = { almuerzo: 'Almuerzo', cena: 'Cena' };
const MEAL_ICON = { almuerzo: '☀️', cena: '🌙' };
const STATUS_ICON = { pendiente: '⏳', confirmado: '✅', no_puede: '❌' };
const STATUS_LABEL = { pendiente: 'Pendiente de confirmar', confirmado: 'Confirmado por los misioneros', no_puede: 'Los misioneros no pueden asistir' };
const MODE_LABEL = { casa: 'En casa', vianda: 'Vianda' };
const ROLE_LABEL = { admin: 'Administrador', leader: 'Líder', missionary: 'Misioneros' };

const store = {
  get(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

let cursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let config = {};
let barrios = [];
let barrioId = null;
let me = { role: 'public', barrioId: null };
let code = store.get('code', '');
let data = { meals: [], blocked: [] };
let missionaries = []; // cada elemento es un compañerismo: { id, name, phone }
let compId = null;
let firstRender = true;
let view = store.get('view', 'detalle'); // 'detalle' | 'mes'
let lastMonth = '';
let upcomingPending = []; // comidas anotadas de los próximos 14 días sin confirmar (solo las usa quien puede confirmar)
let upcoming = []; // próximas comidas (14 días) sin familia: { date, meal }

// ¿Ya pasó esa comida? (antes de hoy, o hoy pero pasada la hora límite configurada)
function isOver(date, meal) {
  const now = new Date();
  const todayStr = iso(now);
  return date < todayStr || (date === todayStr && now.toTimeString().slice(0, 5) >= (config[`end_${meal}`] || '23:59'));
}
const compName = (id) => missionaries.find((c) => c.id === id)?.name || '';
const barrioName = (id) => barrios.find((b) => b.id === id)?.name || '';
// Quien puede gestionar el barrio seleccionado (cancelar, bloquear días, cargar misioneros).
const canManage = () => me.role === 'admin' || (me.role === 'leader' && (me.all || me.barrioId === barrioId));
const canSeePrivate = () => canManage() || (me.role === 'missionary' && (me.all || me.barrioId === barrioId));

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Tokens': store.get('tokens', []).join(','), ...(code ? { 'X-Code': code } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Error inesperado');
  return json;
}

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

// ---------- Diálogo genérico ----------
function show(title, body, actions) {
  $('dlgTitle').textContent = title;
  $('dlgBody').replaceChildren(...body);
  $('err').hidden = true;
  $('dlgActions').replaceChildren(...actions);
  if (!$('dlg').open) $('dlg').showModal();
}
const showError = (msg) => { $('err').textContent = msg; $('err').hidden = false; };
const close = () => $('dlg').close();
const btn = (text, onclick, cls = '') => el('button', { type: 'button', textContent: text, className: cls, onclick });
const closeBtn = () => btn('Cerrar', close);
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3500);
}
// Ejecuta una acción; si sale bien cierra el diálogo, refresca el calendario y avisa.
async function act(fn, okMsg) {
  try { await fn(); close(); await refresh(); if (okMsg) toast(okMsg); } catch (e) { showError(e.message); }
}

function field(label, name, { options, multiline, ...props } = {}) {
  const input = el(multiline ? 'textarea' : (options ? 'select' : 'input'), { name, rows: 2, ...props });
  if (options) {
    input.append(...options.map(([v, t]) => el('option', { value: v, textContent: t })));
    if (props.value !== undefined) input.value = props.value;
  }
  return el('label', {}, label, input);
}
const valueOf = (label) => label.querySelector('input,textarea,select').value.trim();

// ---------- Carga de datos ----------
async function loadConfig() {
  config = await api('GET', '/api/config');
  document.title = config.title;
  $('title').textContent = config.title;
  $('info').textContent = config.info;
}

async function loadBarrios() {
  barrios = await api('GET', '/api/barrios');
  const wanted = barrioId ?? store.get('barrio', null);
  barrioId = barrios.some((b) => b.id === wanted) ? wanted : (barrios[0]?.id ?? null);
  $('barrio').replaceChildren(...barrios.map((b) => el('option', { value: b.id, textContent: b.name, selected: b.id === barrioId })));
  $('empty').hidden = barrios.length > 0;
  $('calendar').hidden = barrios.length === 0;
}

async function loadMissionaries() {
  missionaries = barrioId ? await api('GET', `/api/barrios/${barrioId}/missionaries`) : [];
  if (!missionaries.some((c) => c.id === compId)) compId = missionaries[0]?.id ?? null;
  const has = missionaries.length > 0;
  $('compWrap').hidden = !has;
  $('comp').replaceChildren(...missionaries.map((c) => el('option', { value: c.id, textContent: c.name, selected: c.id === compId })));
  const priv = canSeePrivate();
  $('missionaries').textContent = has && priv
    ? 'Contacto: ' + missionaries.map((c) => (c.phone ? `${c.name} (${c.phone})` : c.name)).join(' · ')
    : '';
}

function renderSession() {
  $('loginBtn').textContent = me.role === 'public' ? 'Acceso' : `${ROLE_LABEL[me.role]}${me.barrioId ? ' · ' + barrioName(me.barrioId) : ''} ✓`;
  $('manageBtn').hidden = !(me.role === 'admin' || me.role === 'leader');
}

async function refresh() {
  if (!barrioId) return;
  const month = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}`;
  $('monthLabel').textContent = cursor.toLocaleDateString('es', { month: 'long', year: 'numeric' });
  await loadMissionaries();
  [data] = await Promise.all([api('GET', `/api/meals?barrio=${barrioId}&month=${month}${compId ? `&comp=${compId}` : ''}`), loadUpcoming()]);
  $('printHead').textContent = `${barrioName(barrioId)}${compId ? ' · ' + compName(compId) : ''} · ${$('monthLabel').textContent}`;
  draw(month);
  renderBanner();
  if (firstRender && view === 'detalle') {
    firstRender = false;
    if (matchMedia('(max-width: 640px)').matches) document.querySelector('.day.today')?.scrollIntoView({ block: 'start' });
  }
}

// ---------- Calendario ----------
function slotButton(date, meal, m, past) {
  const over = isOver(date, meal);
  const cls = ['slot'];
  if (m) cls.push('taken');
  if (m?.mine) cls.push('mine');
  if (over && !m) cls.push('over');
  const urgent = !m && !over && daysFromToday(date) <= 2;
  if (urgent) cls.push('urgent');
  const text = m
    ? el('span', { className: 'who' }, m.family, el('span', { className: 'badge' }, MODE_LABEL[m.mode]), el('span', { className: 'st', title: STATUS_LABEL[m.status] }, STATUS_ICON[m.status]))
    : el('span', { className: 'who' }, over ? 'Finalizado' : urgent ? 'Sin familia aún' : 'Libre', ...(over ? [] : [el('span', { className: 'cta' }, urgent ? '¡Anótate! +' : 'Anotarme +')]));
  const b = el('button', {
    type: 'button', className: cls.join(' '), ariaLabel: `${MEAL_LABEL[meal]} ${longDate(date)}`,
    disabled: over && !m && !canManage(), // horario vencido: solo líderes y admin pueden cargarlo
  }, el('span', { className: 'sl' }, `${MEAL_ICON[meal]} ${MEAL_LABEL[meal]}`), text);
  if (m?.address) b.append(el('span', { className: 'addr' }, m.address));
  b.onclick = () => openSlot(date, meal, m);
  return b;
}

const daysFromToday = (date) => Math.round((new Date(date + 'T00:00') - new Date(iso(new Date()) + 'T00:00')) / 864e5);
const dayWord = (date) => ({ 0: 'Hoy', 1: 'Mañana' })[daysFromToday(date)]
  || new Date(date + 'T00:00').toLocaleDateString('es', { weekday: 'short', day: 'numeric' }).replace(/^./, (c) => c.toUpperCase());

// Busca las comidas de los próximos 14 días que todavía no tienen familia (sin contar lunes ni días bloqueados).
async function loadUpcoming() {
  upcoming = [];
  upcomingPending = [];
  if (!barrioId) return;
  const now = new Date();
  const months = [0, 1].map((o) => { const d = new Date(now.getFullYear(), now.getMonth() + o, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; });
  const q = compId ? `&comp=${compId}` : '';
  const res = await Promise.all(months.map((m) => api('GET', `/api/meals?barrio=${barrioId}&month=${m}${q}`)));
  const meals = res.flatMap((r) => r.meals), blocked = res.flatMap((r) => r.blocked);
  for (let i = 0; i < 14; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const date = iso(d);
    if (d.getDay() === 1 || blocked.some((b) => b.date === date)) continue;
    for (const meal of ['almuerzo', 'cena']) {
      if (isOver(date, meal)) continue;
      const taken = meals.find((x) => x.date === date && x.meal === meal);
      if (!taken) upcoming.push({ date, meal });
      else if (taken.status === 'pendiente') upcomingPending.push(taken);
    }
  }
}

// Aviso de arriba: qué días necesitan familia, con acceso directo para anotarse y para invitar a otros.
function renderBanner() {
  const box = $('banner');
  box.replaceChildren();
  if (!barrioId) return;
  box.className = 'banner' + (upcoming.length ? '' : ' ok');
  const who = compId ? compName(compId) : 'los misioneros';

  if (!upcoming.length) {
    box.append(el('h3', {}, '🎉 ¡Todo cubierto!'), el('p', {}, `${who} ya tienen quién los invite los próximos 14 días. ¡Gracias por tu servicio!`));
  } else {
    const noLunch = upcoming.filter((u) => u.meal === 'almuerzo').length;
    box.append(
      el('h3', {}, '🙏 ¡Los élderes te necesitan!'),
      el('p', {}, `${who} todavía no tienen quién los invite en ${upcoming.length} ${upcoming.length === 1 ? 'comida' : 'comidas'} de los próximos 14 días${noLunch ? ` (${noLunch} ${noLunch === 1 ? 'almuerzo' : 'almuerzos'})` : ''}. Elige un día y anótate:`));
    const chips = el('div', { className: 'chips' });
    for (const u of upcoming.slice(0, 5)) {
      chips.append(el('button', {
        type: 'button', className: 'chip' + (daysFromToday(u.date) <= 1 ? ' hot' : ''),
        onclick: () => openSlot(u.date, u.meal, undefined),
      }, `${dayWord(u.date)} · ${MEAL_ICON[u.meal]} ${MEAL_LABEL[u.meal]}`));
    }
    if (upcoming.length > 5) chips.append(el('button', { type: 'button', className: 'chip more', onclick: () => { setView('mes'); $('calendar').scrollIntoView(); } }, `+${upcoming.length - 5} más · ver mes`));
    box.append(chips);
  }

  // Para misioneros, líderes y admin: comidas ya anotadas que esperan confirmación.
  if (canSeePrivate() && upcomingPending.length) {
    const wrap = el('div', { className: 'pending' }, el('p', {}, `⏳ Por confirmar (${upcomingPending.length}):`));
    const chips = el('div', { className: 'chips' });
    for (const m of upcomingPending.slice(0, 6)) {
      chips.append(el('button', { type: 'button', className: 'chip', onclick: () => openSlot(m.date, m.meal, m) },
        `${dayWord(m.date)} · ${MEAL_ICON[m.meal]} ${m.family}`));
    }
    wrap.append(chips);
    box.append(wrap);
  }

  // Avance del mes que se está mirando: comidas ya cubiertas sobre las que se pueden cubrir.
  let total = 0, covered = 0;
  for (let d = 1; d <= new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate(); d++) {
    const date = `${lastMonth}-${pad(d)}`;
    if (data.blocked.some((b) => b.date === date)) continue;
    const mon = new Date(date + 'T00:00').getDay() === 1;
    for (const meal of ['almuerzo', 'cena']) {
      if (data.meals.some((x) => x.date === date && x.meal === meal)) { total++; covered++; }
      else if (!mon && !isOver(date, meal)) total++;
    }
  }
  if (total) {
    box.append(el('div', { className: 'bar' }, el('i', { style: `width:${Math.round((covered / total) * 100)}%` })),
      el('small', {}, `${$('monthLabel').textContent}: ${covered} de ${total} comidas cubiertas`));
  }

  if (upcoming.length) {
    const text = `Los misioneros de ${barrioName(barrioId)}${compId ? ' (' + compName(compId) + ')' : ''} necesitan que los inviten a comer. Anótate acá: ${location.origin}`;
    // En el celular abre el menú de compartir del sistema (WhatsApp, grupos, etc.); si no existe, abre WhatsApp para elegir el chat.
    const share = async () => {
      if (navigator.share) {
        try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; }
      }
      window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    };
    box.append(el('button', { type: 'button', className: 'share', textContent: '📲 Compartir con otros', onclick: share }));
  }
}

// Dibuja la vista elegida (detalle o mes completo).
function draw(month) {
  lastMonth = month;
  $('calendar').dataset.view = view;
  $('vDetail').setAttribute('aria-pressed', String(view === 'detalle'));
  $('vMonth').setAttribute('aria-pressed', String(view === 'mes'));
  (view === 'mes' ? renderMonth : renderCalendar)(month);
}

// Vista "Mes completo": cuadrícula compacta; cada día muestra el estado del almuerzo y la cena.
function renderMonth(month) {
  const grid = $('grid');
  grid.replaceChildren();
  const offset = (cursor.getDay() + 6) % 7;
  for (let i = 0; i < offset; i++) grid.append(el('div', { className: 'mday empty' }));
  const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const todayStr = iso(new Date());

  for (let d = 1; d <= days; d++) {
    const date = `${month}-${pad(d)}`;
    const dayMeals = data.meals.filter((x) => x.date === date);
    const blocked = data.blocked.find((x) => x.date === date);
    const prep = new Date(date + 'T00:00').getDay() === 1 && !dayMeals.length;
    const cls = ['mday'];
    if (date < todayStr) cls.push('past');
    if (date === todayStr) cls.push('today');

    const marks = ['almuerzo', 'cena'].map((meal) => {
      const m = dayMeals.find((x) => x.meal === meal);
      const state = blocked || prep ? 'off' : m ? 'taken' : isOver(date, meal) ? 'over' : 'free';
      return el('i', { className: `mk ${state}${state === 'free' && daysFromToday(date) <= 2 ? ' urgent' : ''}`, title: `${MEAL_LABEL[meal]}: ${m ? m.family : state === 'free' ? 'libre' : 'no disponible'}` },
        MEAL_ICON[meal], ...(m ? [el('span', { className: 'stg' }, STATUS_ICON[m.status]), el('span', { className: 'mt' }, ' ' + m.family)] : []));
    });
    const b = el('button', { type: 'button', className: cls.join(' '), ariaLabel: longDate(date), disabled: prep }, el('span', { className: 'num' }, String(d)), ...marks);
    b.onclick = () => (blocked ? openBlocked(date, blocked) : openDay(date, dayMeals));
    grid.append(b);
  }
}

// Detalle de un día desde la vista de mes: muestra sus dos comidas para elegir una.
function openDay(date, dayMeals) {
  const past = date < iso(new Date());
  const slots = el('div', { className: 'dlg-slots' }, ...['almuerzo', 'cena'].map((meal) => slotButton(date, meal, dayMeals.find((x) => x.meal === meal), past)));
  show(longDate(date), [el('p', { className: 'meta' }, barrioName(barrioId) + (compId ? ' · ' + compName(compId) : '')), slots], [closeBtn()]);
}

function renderCalendar(month) {
  const grid = $('grid');
  grid.replaceChildren();
  const offset = (cursor.getDay() + 6) % 7; // la semana empieza el lunes
  for (let i = 0; i < offset; i++) grid.append(el('div', { className: 'day empty' }));
  const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const todayStr = iso(new Date());

  for (let d = 1; d <= days; d++) {
    const date = `${month}-${pad(d)}`;
    const dayMeals = data.meals.filter((x) => x.date === date);
    const blocked = data.blocked.find((x) => x.date === date);
    const past = date < todayStr;
    const cls = ['day'];
    if (past) cls.push('past');
    if (date === todayStr) cls.push('today');
    if (blocked) cls.push('blocked');
    if (dayMeals.length) cls.push('has-taken');

    const wd = new Date(date + 'T00:00').toLocaleDateString('es', { weekday: 'short' });
    const slots = el('div', { className: 'slots' });
    if (new Date(date + 'T00:00').getDay() === 1 && !dayMeals.length) {
      slots.append(el('button', { type: 'button', className: 'slot off', disabled: true }, el('span', { className: 'who' }, 'Día de preparación')));
    } else if (blocked) {
      const b = el('button', { type: 'button', className: 'slot off' }, el('span', { className: 'who' }, blocked.reason || 'No disponible'));
      b.onclick = () => openBlocked(date, blocked);
      slots.append(b);
    } else {
      for (const meal of ['almuerzo', 'cena']) slots.append(slotButton(date, meal, dayMeals.find((x) => x.meal === meal), past));
    }
    grid.append(el('div', { className: cls.join(' ') },
      el('div', { className: 'head' }, el('span', { className: 'num' }, String(d)), el('span', { className: 'wd' }, wd)), slots));
  }
}

// ---------- Diálogos del calendario ----------
const mapUrl = (addr) => `https://maps.google.com/maps?q=${encodeURIComponent(addr)}&output=embed`;
const mapLink = (addr) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`;

function blockButton(date, blocked) {
  if (!canManage()) return null;
  return blocked
    ? btn('Habilitar día', () => act(() => api('DELETE', `/api/blocked/${barrioId}/${date}`)))
    : btn('Bloquear día', () => act(() => api('PUT', `/api/blocked/${barrioId}/${date}`, { reason: prompt('Motivo (opcional):') || '' })));
}

function openBlocked(date, blocked) {
  const actions = [closeBtn()];
  const bb = blockButton(date, blocked);
  if (bb) actions.unshift(bb);
  show(longDate(date), [el('p', {}, blocked.reason || 'Este día no está disponible.')], actions);
}

function openSlot(date, meal, m) {
  const title = `${MEAL_LABEL[meal]} · ${longDate(date)}`;
  const time = config[`time_${meal}`];
  const barrioLine = el('p', { className: 'meta' }, `${barrioName(barrioId)}${time ? ' · ' + time + ' hs' : ''}`);
  if (m) return openTaken(title, date, meal, m, barrioLine);
  if (isOver(date, meal) && !canManage()) return show(title, [barrioLine, el('p', {}, 'Este horario ya pasó.')], [closeBtn()]);
  openForm(title, date, meal, barrioLine);
}

function openForm(title, date, meal, barrioLine, m) {

  const editing = !!m; // m viene cuando se edita un registro existente
  const family = field('Nombre de la familia', 'family', { maxLength: 80, value: m?.family || '' });
  const phone = field('Teléfono', 'phone', { type: 'tel', inputMode: 'tel', maxLength: 30, value: m?.phone || '' });
  const address = field('Dirección', 'address', { maxLength: 200, placeholder: 'Calle, número, ciudad', value: m?.address || '' });
  const comp = missionaries.length
    ? field('¿A qué compañerismo invitas?', 'comp', { options: missionaries.map((c) => [c.id, c.name]), value: String(m?.companionship_id || compId) })
    : null;
  const notes = field('Notas (opcional)', 'notes', { multiline: true, maxLength: 300, placeholder: 'Ej.: hora estimada, indicaciones para llegar', value: m?.notes || '' });
  const mode = (value, label, hint, checked) => el('label', { className: 'choice' },
    el('input', { type: 'radio', name: 'mode', value, checked }), el('span', {}, label, el('small', {}, hint)));
  const modes = el('div', { className: 'choices' }, mode('casa', 'En casa', 'Los misioneros comen en tu casa 🏠', m?.mode !== 'vianda'), mode('vianda', 'Vianda', 'Los élderes pasan a retirarla 🥡', m?.mode === 'vianda'));
  const mode_ = () => modes.querySelector('input:checked').value;
  const syncAddr = () => { address.firstChild.textContent = mode_() === 'casa' ? 'Dirección de tu casa (obligatoria)' : 'Dirección donde retiran la vianda (obligatoria)'; };
  modes.onchange = syncAddr;
  syncAddr();

  const save = btn(editing ? 'Guardar cambios' : 'Anotarme', () => {
    const body = { barrio: barrioId, date, meal, mode: mode_(), family: valueOf(family), phone: valueOf(phone), address: valueOf(address), notes: valueOf(notes), companionship: comp ? Number(valueOf(comp)) : 0 };
    if (!body.family || !body.phone) return showError('Completa el nombre de la familia y el teléfono.');
    if (!body.address) return showError(body.mode === 'casa' ? 'Indica la dirección de tu casa.' : 'Indica la dirección donde los élderes retiran la vianda.');
    if (editing) return act(() => api('PUT', `/api/meals/${m.id}`, body), 'Cambios guardados ✅');
    act(async () => {
      const { token } = await api('POST', '/api/meals', body);
      store.set('tokens', [...store.get('tokens', []), token]);
    }, '¡Gracias! Tu registro quedó guardado 🙌');
  }, 'primary');
  const actions = [closeBtn(), save];
  const bb = editing ? null : blockButton(date, null);
  if (bb) actions.unshift(bb);
  show(editing ? `Editar · ${title}` : title, [barrioLine, ...(comp ? [comp] : []), family, phone, modes, address, notes,
    el('small', {}, 'La dirección y el mapa solo los ven los misioneros y los líderes.')], actions);
}

// ---------- WhatsApp ----------
const waOpen = (phone, text) => window.open(`https://wa.me/${(phone || '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
const whenText = (date, meal) => {
  const time = config[`time_${meal}`];
  return `${longDate(date)}${time ? ` a las ${time} hs` : ''}`;
};
const placeText = (m) => m.mode === 'casa'
  ? `en la casa de la familia${m.address ? ` (${m.address})` : ''}`
  : `con vianda: los élderes la retiran${m.address ? ` en ${m.address}` : ''}`;

// Después de que los misioneros avisan que no pueden asistir: ofrece avisarle a la familia por WhatsApp.
function offerFamilyNotice(m, date, meal, note) {
  const text = `Hola familia ${m.family}, lamentablemente los misioneros no podrán asistir a la ${MEAL_LABEL[meal].toLowerCase()} del ${whenText(date, meal)}${note ? `: ${note}` : ''}. ¡Muchas gracias por su disposición!`;
  show('Avisar a la familia', [el('p', {}, `Quedó registrado que los misioneros no pueden asistir. ¿Le avisamos a la familia ${m.family} por WhatsApp?`)], [
    btn('Ahora no', close),
    btn('📲 Avisar por WhatsApp', () => { waOpen(m.phone, text); close(); }, 'primary'),
  ]);
}

function openTaken(title, date, meal, m, barrioLine) {
  const body = [barrioLine, ...(m.companionship_id ? [el('p', {}, `Invita a: ${compName(m.companionship_id)}`)] : []), el('p', { className: 'info-line' }, `👨‍👩‍👧 Familia: ${m.family}`), el('p', { className: 'info-line' }, `${m.mode === 'casa' ? '🏠' : '🥡'} Modalidad: ${MODE_LABEL[m.mode]}`)];
  if (m.notes) body.push(el('p', {}, `Notas: ${m.notes}`));
  if (m.phone) body.push(el('p', {}, 'Teléfono: ', el('a', { href: `tel:${m.phone}`, textContent: m.phone })));
  if (m.address && canSeePrivate()) {
    body.push(el('p', {}, `Dirección: ${m.address} · `, el('a', { href: mapLink(m.address), target: '_blank', rel: 'noopener', textContent: 'Abrir en Google Maps' })));
    body.push(el('iframe', { className: 'map', src: mapUrl(m.address), loading: 'lazy', title: 'Mapa', referrerPolicy: 'no-referrer' }));
  }
  // Estado de la confirmación (lo ve todo el mundo).
  body.push(el('p', { className: `info-line status st-${m.status}` }, `${STATUS_ICON[m.status]} ${STATUS_LABEL[m.status]}${m.status === 'no_puede' && m.status_note ? ` · ${m.status_note}` : ''}`));

  // En la hoja de móvil el último botón queda arriba: del menos al más importante.
  const actions = [closeBtn()];

  // Recordarle a la familia: misioneros, líderes y admin (ven su teléfono).
  if (canSeePrivate() && m.phone) {
    actions.push(btn('Recordar a la familia', () => waOpen(m.phone,
      `Hola familia ${m.family}, les recordamos que ${whenText(date, meal)} les toca invitar a los misioneros (${MEAL_LABEL[meal].toLowerCase()}). ¡Gracias!`)));
  }
  // Avisar a los misioneros: solo líderes y admin.
  if (canManage()) {
    const comp = missionaries.find((c) => c.id === m.companionship_id);
    const text = `Hola ${comp?.name || 'élderes'}, la familia ${m.family} los invita a ${MEAL_LABEL[meal].toLowerCase()} el ${whenText(date, meal)}, ${placeText(m)}. Tel. de la familia: ${m.phone}. Por favor confirmen en la app: ${location.origin}`;
    actions.push(btn('Avisar a los misioneros', () => waOpen(m.comp_phone || comp?.phone, text)));
  }
  if (canManage()) {
    actions.push(btn('Eliminar registro', () => confirm('¿Eliminar este registro? No se puede deshacer.') && act(() => api('DELETE', `/api/meals/${m.id}`), 'Registro eliminado'), 'danger'));
    actions.push(btn('Editar', () => openForm(title, date, meal, barrioLine, m)));
  }
  if (canSeePrivate()) {
    const set = (status, note, msg) => act(() => api('PUT', `/api/meals/${m.id}/status`, { status, note }), msg);
    if (m.status !== 'pendiente') actions.push(btn('↩ Volver a pendiente', () => set('pendiente', '', 'Vuelve a estar pendiente')));
    if (m.status !== 'no_puede') {
      actions.push(btn('❌ No podemos', async () => {
        const note = prompt('Motivo (opcional, lo verá la familia):');
        if (note === null) return;
        try {
          await api('PUT', `/api/meals/${m.id}/status`, { status: 'no_puede', note });
          await refresh();
          offerFamilyNotice(m, date, meal, note.trim());
        } catch (e) { showError(e.message); }
      }, 'danger'));
    }
    if (m.status !== 'confirmado') actions.push(btn('✅ Confirmar asistencia', () => set('confirmado', '', 'Confirmado, ¡gracias!'), 'primary'));
  }
  show(title, body, actions);
}

// ---------- Acceso (login por código) ----------
function openLogin() {
  if (me.role !== 'public') {
    return show('Sesión', [el('p', {}, `Ingresaste como ${ROLE_LABEL[me.role]}${me.barrioId ? ' del barrio ' + barrioName(me.barrioId) : ''}.`)], [
      btn('Cerrar sesión', async () => { code = ''; store.set('code', ''); me = { role: 'public', barrioId: null }; close(); renderSession(); await refresh(); }),
      closeBtn(),
    ]);
  }
  const input = field('Código de acceso', 'code', { type: 'password', autocomplete: 'off' });
  const go = btn('Entrar', async () => {
    const attempt = valueOf(input);
    if (!attempt) return;
    const prev = code;
    code = attempt;
    try {
      me = await api('GET', '/api/me');
      store.set('code', code);
      if (me.barrioId) { barrioId = me.barrioId; store.set('barrio', barrioId); }
      await loadBarrios();
      renderSession();
      close();
      await refresh();
    } catch (e) { code = prev; showError(e.message); }
  }, 'primary');
  show('Acceso', [el('p', { className: 'meta' }, 'Para líderes, misioneros y administrador. Si solo quieres anotarte, no necesitas código.'), input], [closeBtn(), go]);
}

// ---------- Gestión (admin y líderes) ----------
let editingBarrio = null;

async function openManage() {
  const body = [];
  const redo = async (fn) => { try { await fn(); await loadBarrios(); renderSession(); await refresh(); await openManage(); } catch (e) { showError(e.message); } };

  if (me.role === 'admin') {
    const f = {
      title: field('Título del sitio', 'title', { value: config.title }),
      info: field('Mensaje de bienvenida', 'info', { multiline: true, value: config.info }),
      time_almuerzo: field('Hora del almuerzo', 'time_almuerzo', { type: 'time', value: config.time_almuerzo }),
      time_cena: field('Hora de la cena', 'time_cena', { type: 'time', value: config.time_cena }),
      end_almuerzo: field('El almuerzo se puede reservar hasta las', 'end_almuerzo', { type: 'time', value: config.end_almuerzo }),
      end_cena: field('La cena se puede reservar hasta las', 'end_cena', { type: 'time', value: config.end_cena }),
    };
    body.push(el('h4', {}, 'Sitio'), ...Object.values(f), btn('Guardar sitio', () => redo(async () => {
      await api('PUT', '/api/config', Object.fromEntries(Object.entries(f).map(([k, v]) => [k, valueOf(v)])));
      await loadConfig();
    }), 'primary small'));

    body.push(el('h4', {}, 'Barrios'));
    for (const b of barrios) {
      body.push(el('div', { className: 'row' },
        el('span', {}, b.name, el('small', {}, `Líder: ${b.leader_code} · Misioneros: ${b.missionary_code}`)),
        el('span', { className: 'btns' },
          btn('Editar', () => { editingBarrio = b; openManage(); }, 'small'),
          btn('Eliminar', () => confirm(`¿Eliminar el barrio ${b.name} con todos sus registros?`) && redo(() => api('DELETE', `/api/barrios/${b.id}`)), 'small danger'))));
    }
    const e = editingBarrio;
    const nf = {
      name: field('Nombre del barrio', 'name', { value: e?.name || '' }),
      leader: field('Código de líderes', 'leader', { value: e?.leader_code || '', autocomplete: 'off' }),
      missionary: field('Código de misioneros', 'missionary', { value: e?.missionary_code || '', autocomplete: 'off' }),
    };
    body.push(el('p', { className: 'meta' }, e ? `Editando: ${e.name}` : 'Agregar barrio (los códigos tienen al menos 4 caracteres y se comparten con líderes y misioneros):'),
      ...Object.values(nf),
      btn(e ? 'Guardar barrio' : 'Agregar barrio', () => redo(async () => {
        const payload = { name: valueOf(nf.name), leader_code: valueOf(nf.leader), missionary_code: valueOf(nf.missionary) };
        const saved = await api(e ? 'PUT' : 'POST', e ? `/api/barrios/${e.id}` : '/api/barrios', payload);
        editingBarrio = null;
        barrioId = saved.id;
        store.set('barrio', barrioId);
      }), 'primary small'),
      ...(e ? [btn('Cancelar edición', () => { editingBarrio = null; openManage(); }, 'small')] : []));
  }

  if (barrioId) {
    body.push(el('h4', {}, `Compañerismos de ${barrioName(barrioId)}`));
    if (!missionaries.length) body.push(el('p', { className: 'meta' }, 'Todavía no hay compañerismos cargados. Mientras no haya ninguno, las reservas no se asignan a nadie en particular.'));
    for (const m of missionaries) {
      body.push(el('div', { className: 'row' },
        el('span', {}, m.name, el('small', {}, m.phone || '')),
        btn('Quitar', () => confirm(`¿Quitar a ${m.name}? Se borrarán también sus comidas anotadas.`) && redo(() => api('DELETE', `/api/missionaries/${m.id}`)), 'small danger')));
    }
    const mn = field('Misioneros del compañerismo', 'mname', { maxLength: 80, placeholder: 'Ej.: Elder Smith y Elder Gómez' });
    const mp = field('Teléfono para WhatsApp (con código de país)', 'mphone', { type: 'tel', maxLength: 30 });
    body.push(mn, mp, btn('Agregar compañerismo', () => redo(() => api('POST', `/api/barrios/${barrioId}/missionaries`, { name: valueOf(mn), phone: valueOf(mp) })), 'primary small'));
  } else {
    body.push(el('p', { className: 'meta' }, 'Crea un barrio para poder cargar misioneros.'));
  }
  show('Gestión', body, [closeBtn()]);
}

// ---------- Tema claro / oscuro ----------
// Por defecto sigue al sistema; el botón fija claro u oscuro y se recuerda en este navegador.
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => (document.documentElement.dataset.theme || (systemDark.matches ? 'dark' : 'light')) === 'dark';
function paintThemeBtn() {
  $('themeBtn').textContent = isDark() ? '☀️' : '🌙';
  $('themeBtn').title = isDark() ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark() ? '#143d68' : '#1b6bb5');
}
$('themeBtn').onclick = () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* sin almacenamiento */ }
  paintThemeBtn();
};
systemDark.onchange = paintThemeBtn;
paintThemeBtn();

// ---------- Eventos ----------
$('form').onsubmit = (e) => e.preventDefault();
$('barrio').onchange = (e) => { barrioId = Number(e.target.value); store.set('barrio', barrioId); compId = null; refresh(); };
$('comp').onchange = (e) => { compId = Number(e.target.value); refresh(); };
$('prev').onclick = () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1); refresh(); };
$('next').onclick = () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1); refresh(); };
$('today').onclick = () => { const n = new Date(); cursor = new Date(n.getFullYear(), n.getMonth(), 1); refresh(); };
$('print').onclick = () => {
  // La impresión usa siempre la vista de detalle (solo lo anotado).
  const wasMonth = view === 'mes';
  if (wasMonth) { view = 'detalle'; draw(lastMonth); }
  window.print();
  if (wasMonth) { view = 'mes'; draw(lastMonth); }
};
const setView = (v) => { view = v; store.set('view', v); draw(lastMonth); };
$('vDetail').onclick = () => setView('detalle');
$('vMonth').onclick = () => setView('mes');
$('loginBtn').onclick = openLogin;
$('manageBtn').onclick = () => { editingBarrio = null; openManage(); };

(async function init() {
  await loadConfig();
  if (code) {
    try { me = await api('GET', '/api/me'); if (me.barrioId) barrioId = me.barrioId; }
    catch { code = ''; store.set('code', ''); }
  }
  await loadBarrios();
  renderSession();
  await refresh();
})().catch((e) => { document.body.prepend(el('p', { className: 'error', textContent: 'No se pudo cargar: ' + e.message })); });
