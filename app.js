'use strict';

/* =========================================================
   みつけたマップ v1
   - 記録は端末内の IndexedDB にだけ保存する（外部送信なし）
   - 家族との共有は zip の書き出し／取り込み
   ========================================================= */

const APP_VERSION = '1.0.0';
const APP_ID = 'mitsuketa-map';
const DATA_FORMAT = 1;

const CATS = [
  { id: 'ikimono',    label: 'いきもの', emoji: '🐞', color: '#FF9A52' },
  { id: 'shokubutsu', label: 'しょくぶつ', emoji: '🌸', color: '#FF7FA3' },
  { id: 'rekishi',    label: 'れきし',   emoji: '🏯', color: '#A98BDB' },
  { id: 'chikei',     label: 'ちけい',   emoji: '⛰️', color: '#43BF9B' },
  { id: 'tabemono',   label: 'たべもの', emoji: '🍙', color: '#F5C02B' },
  { id: 'sonota',     label: 'そのほか', emoji: '⭐', color: '#5DB7EE' },
];
const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));
const TAGS = ['きれい', 'ちいさい', 'おおきい', 'たくさん', 'いいにおい', 'はじめて見た', 'かわいい', 'ふしぎ'];
const ANIMALS = ['🐰', '🦉', '🐻', '🐱', '🐶', '🐼', '🦊', '🐧', '🐹', '🐨', '🐯', '🐸', '🐥', '🐿️', '🦄'];
const BADGES = [
  { n: 5, icon: '🥉' }, { n: 10, icon: '🥈' }, { n: 30, icon: '🥇' }, { n: 50, icon: '👑' },
];
const JAPAN = { center: [37.0, 137.5], zoom: 5 };
const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';
// 空中写真は、ズームによって衛星画像なども使われるので出所も併記する（地理院タイル一覧の備考による）
const PHOTO_ATTR = `${GSI_ATTR}（Landsat8画像: GSI,TSIC,GEO Grid/AIST, courtesy of the U.S. Geological Survey／海底地形: GEBCO／GRUS画像 © Axelspace）`;
const BASES = {
  std:   { label: 'ちず',   url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png' },
  pale:  { label: 'うすい', url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png' },
  photo: { label: 'しゃしん', url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg' },
};
const REMIND_DAYS = 14;
const REMIND_COUNT = 10;
const ACCURACY_WARN = 100;
const IMPORT_LIMITS = { zip: 500 * 1024 * 1024, json: 20 * 1024 * 1024, photo: 15 * 1024 * 1024, records: 20000, members: 200 };
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/* ---------- 小さな道具 ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const R = (k, r) => `<ruby>${k}<rt>${r}</rt></ruby>`;
const tagHTML = t => esc(t).replace('見', R('見', 'み')).replace('書', R('書', 'か'));
function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const x = [...b].map(v => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
const nowISO = () => new Date().toISOString();
function fmtDate(iso, withYear = false) {
  const d = new Date(iso);
  const y = withYear ? `${d.getFullYear()}${R('年', 'ねん')}` : '';
  return `${y}${d.getMonth() + 1}${R('月', 'がつ')}${d.getDate()}${R('日', 'にち')}`;
}
function toLocalInput(iso) {
  const d = new Date(iso); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(v) { const d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/* ---------- IndexedDB ---------- */
let dbPromise = null;
function openDB() {
  if (!dbPromise) dbPromise = new Promise((res, rej) => {
    const q = indexedDB.open(APP_ID, 1);
    q.onupgradeneeded = () => {
      const d = q.result;
      for (const s of ['records', 'photos', 'members']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
    };
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  return dbPromise;
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });
async function dbAll(store) { const d = await openDB(); return reqP(d.transaction(store).objectStore(store).getAll()); }
async function dbGet(store, key) { const d = await openDB(); return reqP(d.transaction(store).objectStore(store).get(key)); }
async function dbPut(store, val) { const d = await openDB(); const t = d.transaction(store, 'readwrite'); t.objectStore(store).put(val); return txDone(t); }
async function dbDel(store, key) { const d = await openDB(); const t = d.transaction(store, 'readwrite'); t.objectStore(store).delete(key); return txDone(t); }
async function dbClearAll() {
  const d = await openDB(); const names = ['records', 'photos', 'members', 'settings'];
  const t = d.transaction(names, 'readwrite'); names.forEach(n => t.objectStore(n).clear()); return txDone(t);
}

/* ---------- 状態 ---------- */
const S = {
  records: new Map(), members: new Map(), settings: {},
  filter: 'all', map: null, cluster: null, bases: {}, base: 'std', markers: new Map(),
  thumbURLs: new Map(), meMarker: null, meCircle: null, lastPos: null, bannerClosed: false,
};
async function setSetting(key, value) { S.settings[key] = value; await dbPut('settings', { key, value }); }
const liveRecords = () => [...S.records.values()].filter(r => !r.deleted);
const memberOf = id => S.members.get(id);
function memberLabel(id) { const m = memberOf(id); return m ? `${m.icon} ${esc(m.name)}` : '❔ だれか'; }

// カテゴリごとの通し番号（見つけた日時の順）
function seqMap() {
  const m = new Map(), n = {};
  liveRecords().sort((a, b) => (a.foundAt.localeCompare(b.foundAt)) || a.createdAt.localeCompare(b.createdAt))
    .forEach(r => { n[r.category] = (n[r.category] || 0) + 1; m.set(r.id, n[r.category]); });
  return m;
}
const seqOf = rec => seqMap().get(rec.id) || 0;

async function thumbURL(photoId) {
  if (!photoId) return null;
  if (S.thumbURLs.has(photoId)) return S.thumbURLs.get(photoId);
  const p = await dbGet('photos', photoId);
  if (!p) return null;
  const u = URL.createObjectURL(p.thumb || p.blob);
  S.thumbURLs.set(photoId, u);
  return u;
}
function forgetThumb(photoId) {
  const u = S.thumbURLs.get(photoId);
  if (u) { URL.revokeObjectURL(u); S.thumbURLs.delete(photoId); }
}
async function deletePhoto(photoId) {
  if (!photoId) return;
  forgetThumb(photoId);
  await dbDel('photos', photoId);
}

/* ---------- 写真（縮小・EXIF除去） ---------- */
async function decodeImage(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (e) {
    // 古いSafari向け：<img> は EXIF の向きを反映して描画される
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image(); img.decoding = 'async'; img.src = url;
      await img.decode();
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
}
function drawJpeg(src, maxSide, quality) {
  const w0 = src.width, h0 = src.height;
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k)), hgt = Math.max(1, Math.round(h0 * k));
  const c = document.createElement('canvas'); c.width = w; c.height = hgt;
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, w, hgt);
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('toBlob')), 'image/jpeg', quality));
}
async function processPhoto(file) {
  const img = await decodeImage(file);
  const blob = await drawJpeg(img, 1280, 0.8);
  const thumb = await drawJpeg(img, 320, 0.75);
  if (img.close) img.close();
  return { blob, thumb };
}
async function makeThumb(blob) {
  try { const img = await decodeImage(blob); const t = await drawJpeg(img, 320, 0.75); if (img.close) img.close(); return t; }
  catch { return blob; }
}

/* ---------- 現在地 ---------- */
function getPosition() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('nogeo'));
    navigator.geolocation.getCurrentPosition(
      p => { S.lastPos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }; res(S.lastPos); },
      err => rej(err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  });
}

/* ---------- トースト・モーダル ---------- */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.innerHTML = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function modal(inner, { onBack } = {}) {
  const back = h('<div class="modal-back"><div class="modal" role="dialog" aria-modal="true"></div></div>');
  back.firstChild.append(inner);
  back.addEventListener('click', e => { if (e.target === back && onBack) onBack(); });
  $('#modal-root').append(back);
  return { el: back, close: () => back.remove() };
}
function ask({ icon = '', title, text = '', ok = 'OK', cancel = 'やめる', danger = false }) {
  return new Promise(resolve => {
    const box = h(`<div>
      ${icon ? `<div class="m-icon">${icon}</div>` : ''}
      <h3>${title}</h3>${text ? `<p>${text}</p>` : ''}
      <div class="m-btns">
        <button class="${danger ? 'danger' : 'ok'}" data-v="1">${ok}</button>
        ${cancel ? `<button data-v="0">${cancel}</button>` : ''}
      </div></div>`);
    const m = modal(box, { onBack: () => { m.close(); resolve(false); } });
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-v]'); if (!b) return;
      m.close(); resolve(b.dataset.v === '1');
    });
  });
}
function memberDialog(member) {
  return new Promise(resolve => {
    let icon = member?.icon || ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const box = h(`<div>
      <div class="m-icon" id="md-icon">${icon}</div>
      <h3>${member ? 'かぞくを なおす' : 'かぞくを ふやす'}</h3>
      <input class="text-in" id="md-name" maxlength="12" placeholder="なまえ（れい：ママ）" autocomplete="off">
      <div class="animal-grid">${ANIMALS.map(a => `<button data-a="${a}" class="${a === icon ? 'on' : ''}" aria-label="${a}">${a}</button>`).join('')}</div>
      <div class="m-btns"><button class="ok" data-v="1">✓ きめた</button><button data-v="0">やめる</button></div>
    </div>`);
    $('#md-name', box).value = member?.name || '';
    const m = modal(box);
    box.addEventListener('click', e => {
      const a = e.target.closest('[data-a]');
      if (a) { icon = a.dataset.a; $('#md-icon', box).textContent = icon; $$('[data-a]', box).forEach(b => b.classList.toggle('on', b === a)); return; }
      const v = e.target.closest('[data-v]'); if (!v) return;
      if (v.dataset.v === '0') { m.close(); return resolve(null); }
      const name = $('#md-name', box).value.trim();
      if (!name) { $('#md-name', box).classList.add('shake'); setTimeout(() => $('#md-name', box).classList.remove('shake'), 500); return; }
      m.close(); resolve({ name, icon });
    });
  });
}
async function addMember(data) {
  const m = { id: uuid(), name: data.name, icon: data.icon, updatedAt: nowISO() };
  await dbPut('members', m); S.members.set(m.id, m); return m;
}
function lightbox(url) {
  const lb = h(`<div class="lightbox"><img alt=""><button class="x" aria-label="とじる">✕</button></div>`);
  $('img', lb).src = url;
  lb.addEventListener('click', () => lb.remove());
  $('#modal-root').append(lb);
}

/* ---------- 画面（スクリーン）の重ね合わせ ---------- */
function openScreen(el) {
  $('#screens').append(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
  return el;
}
function closeScreen(el) {
  if (!el || el._closing) return;
  el._closing = true;
  el.classList.remove('open');
  if (el._onClose) el._onClose();
  setTimeout(() => el.remove(), 300);
}
function closeAllScreens() { $$('#screens > .screen').forEach(closeScreen); }
function screenShell(title, { left = '✕', right = '' } = {}) {
  return h(`<section class="screen">
    <header class="screen-head">
      <button class="icon-btn" data-act="close" aria-label="もどる">${left}</button>
      <h2>${title}</h2>
      ${right || '<span class="spacer"></span>'}
    </header>
    <div class="screen-body"><div class="wrap"></div></div>
  </section>`);
}
function makeMiniMap(el, opts = {}) {
  const m = L.map(el, {
    zoomControl: false, attributionControl: false, dragging: false, touchZoom: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, tap: false, ...opts,
  });
  L.tileLayer(BASES.pale.url, { maxZoom: 18, minZoom: 5 }).addTo(m);
  return m;
}

/* =========================================================
   1. 地図（ホーム）
   ========================================================= */
function pinIcon(catId) {
  const c = CAT[catId] || CAT.sonota;
  return L.divIcon({
    className: 'pin-wrap',
    html: `<div class="pin" style="--c:${c.color}"><div class="pin-head"><span>${c.emoji}</span></div></div>`,
    iconSize: [46, 58], iconAnchor: [23, 56], popupAnchor: [0, -50],
  });
}

function initMap() {
  const map = L.map('map', { zoomControl: false, attributionControl: false, minZoom: 5, maxZoom: 18, tap: false });
  L.control.attribution({ position: 'bottomright', prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>' }).addTo(map);
  for (const [k, b] of Object.entries(BASES)) {
    S.bases[k] = L.tileLayer(b.url, { maxZoom: 18, minZoom: 5, attribution: k === 'photo' ? PHOTO_ATTR : GSI_ATTR });
  }
  S.base = BASES[S.settings.base] ? S.settings.base : 'std';
  S.bases[S.base].addTo(map);
  map.setView(JAPAN.center, JAPAN.zoom);

  S.cluster = L.markerClusterGroup({
    showCoverageOnHover: false, maxClusterRadius: 48, spiderfyOnMaxZoom: true,
    iconCreateFunction: cl => L.divIcon({ className: 'cluster-wrap', html: `<div class="cluster"><span>${cl.getChildCount()}</span></div>`, iconSize: [48, 48] }),
  });
  map.addLayer(S.cluster);
  S.map = map;

  // ちず／うすい／しゃしん
  const sw = $('#layer-switch');
  sw.innerHTML = Object.entries(BASES).map(([k, b]) => `<button data-base="${k}" class="${k === S.base ? 'on' : ''}">${b.label}</button>`).join('');
  sw.addEventListener('click', e => {
    const b = e.target.closest('[data-base]'); if (!b || b.dataset.base === S.base) return;
    map.removeLayer(S.bases[S.base]); S.base = b.dataset.base; S.bases[S.base].addTo(map);
    $$('button', sw).forEach(x => x.classList.toggle('on', x === b));
    setSetting('base', S.base);
  });

  $('#btn-locate').addEventListener('click', () => locateMe(true));
  $('#btn-add').addEventListener('click', () => openForm(null));
  $('#btn-menu').addEventListener('click', openMenu);
}

function renderFilters() {
  const nav = $('#filters');
  const items = [{ id: 'all', label: 'ぜんぶ', emoji: '', color: 'var(--coral)' }, ...CATS];
  nav.innerHTML = items.map(c => `<button class="chip ${S.filter === c.id ? 'on' : ''}" data-f="${c.id}" style="--c:${c.color}">${c.emoji}${c.label}</button>`).join('');
  nav.onclick = e => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    S.filter = b.dataset.f; renderFilters(); refreshMarkers();
  };
}

function refreshMarkers() {
  S.cluster.clearLayers(); S.markers.clear();
  const ms = [];
  for (const r of liveRecords()) {
    if (S.filter !== 'all' && r.category !== S.filter) continue;
    const m = L.marker([r.lat, r.lng], { icon: pinIcon(r.category), title: r.name || 'なまえ まだ' });
    m.bindPopup(() => popupContent(r.id), { className: 'pin-popup', closeButton: false, autoPanPadding: [20, 80] });
    S.markers.set(r.id, m); ms.push(m);
  }
  S.cluster.addLayers(ms);
}

function popupContent(id) {
  const r = S.records.get(id); const c = CAT[r.category];
  const el = h(`<button class="pop"><div class="ph">${c.emoji}</div><div class="nm">${esc(r.name) || 'なまえ まだ'}</div><div class="go">カードを みる ▶</div></button>`);
  thumbURL(r.photoId).then(u => { if (u) $('.ph', el).innerHTML = `<img src="${u}" alt="">`; });
  el.addEventListener('click', () => { S.map.closePopup(); openCard(id); });
  return el;
}

function showRecordOnMap(id, { bounce = false, popup = false } = {}) {
  const r = S.records.get(id); if (!r) return;
  if (S.filter !== 'all' && S.filter !== r.category) { S.filter = 'all'; renderFilters(); refreshMarkers(); }
  const m = S.markers.get(id); if (!m) return;
  const go = () => S.cluster.zoomToShowLayer(m, () => {
    if (popup) m.openPopup();
    if (bounce) {
      const pin = m.getElement() && m.getElement().querySelector('.pin');
      if (pin) { pin.classList.remove('bounce'); void pin.offsetWidth; pin.classList.add('bounce'); }
    }
  });
  if (S.map.getZoom() < 15) { S.map.setView([r.lat, r.lng], 16, { animate: false }); setTimeout(go, 50); }
  else { S.map.panTo([r.lat, r.lng]); setTimeout(go, 300); }
}

function drawMe(pos) {
  const ll = [pos.lat, pos.lng];
  if (!S.meMarker) {
    S.meCircle = L.circle(ll, { radius: pos.accuracy, color: '#2F80ED', weight: 1, fillColor: '#2F80ED', fillOpacity: .12, interactive: false }).addTo(S.map);
    S.meMarker = L.marker(ll, { icon: L.divIcon({ className: 'me-dot', html: '<div></div>', iconSize: [20, 20] }), interactive: false, zIndexOffset: 1000 }).addTo(S.map);
  } else {
    S.meMarker.setLatLng(ll); S.meCircle.setLatLng(ll).setRadius(pos.accuracy);
  }
}
async function locateMe(userAction) {
  try {
    if (userAction) toast('📡 いまの ばしょを さがしてるよ…', 10000);
    const pos = await getPosition();
    drawMe(pos);
    S.map.setView([pos.lat, pos.lng], Math.max(S.map.getZoom(), 16));
    if (userAction) toast(pos.accuracy > ACCURACY_WARN ? 'ばしょが すこし ずれているかも' : '📍 ここに いるよ');
  } catch (e) {
    if (userAction) toast('いまの ばしょが わからなかったよ');
  }
}

/* ---------- かきだしの おしらせ ---------- */
function checkReminder() {
  const b = $('#banner');
  const live = liveRecords();
  const last = S.settings.lastExportAt || null;
  const newCount = live.filter(r => !last || r.createdAt > last).length;
  const since = last || S.settings.firstRunAt || nowISO();
  const days = (Date.now() - Date.parse(since)) / 864e5;
  const need = !S.bannerClosed && newCount > 0 && (days >= REMIND_DAYS || newCount >= REMIND_COUNT);
  if (!need) { b.hidden = true; return; }
  b.innerHTML = `<span>💾</span><span class="grow">かきだして ほぞんしておこう<br><small class="muted">まだ かきだしていない きろく ${newCount}こ</small></span>
    <button class="go">かきだす</button><button class="x" aria-label="とじる">✕</button>`;
  b.hidden = false;
  $('.go', b).onclick = () => openExport();
  $('.x', b).onclick = () => { S.bannerClosed = true; b.hidden = true; };
}

/* =========================================================
   2. きろくする（新規・へんしゅう）
   ========================================================= */
function openForm(existing) {
  return new Promise(resolve => {
    const isNew = !existing;
    const defaultAuthor = [S.settings.lastAuthorId, S.settings.deviceOwnerId, [...S.members.keys()][0]].find(id => id && S.members.has(id)) || null;
    const f = {
      category: existing?.category || null,
      tags: new Set(existing?.tags || []),
      lat: existing?.lat ?? null, lng: existing?.lng ?? null,
      accuracy: existing ? existing.accuracy : null,
      authorId: existing?.authorId || defaultAuthor,
      photoId: existing?.photoId || null,
      newPhoto: null, removePhoto: false, saving: false,
    };
    const el = h(`<section class="screen">
      <header class="screen-head">
        <button class="icon-btn" data-act="close" aria-label="とじる">✕</button>
        <h2>${isNew ? 'きろくする' : 'へんしゅう'}</h2><span class="spacer"></span>
      </header>
      <div class="screen-body"><div class="wrap">
        <div class="photo-box" id="f-photo"></div>
        <div class="photo-btns">
          <button class="pill-btn" data-act="camera">📷 とる</button>
          <button class="pill-btn" data-act="library">🖼️ えらぶ</button>
          <button class="pill-btn subtle" data-act="nophoto" hidden>しゃしんを はずす</button>
        </div>
        <input type="file" accept="image/*" capture="environment" id="f-cam" hidden>
        <input type="file" accept="image/*" id="f-lib" hidden>

        <h3 class="q">なにを みつけた？</h3>
        <div class="cat-grid" id="f-cats">${CATS.map(c => `<button class="cat-btn" data-cat="${c.id}" style="--c:${c.color}"><span class="e">${c.emoji}</span>${c.label}</button>`).join('')}</div>

        <h3 class="q">なまえ</h3>
        <input class="text-in" id="f-name" maxlength="40" autocomplete="off" placeholder="わからなければ からっぽで OK">

        <h3 class="q">どんな かんじ？</h3>
        <div class="tags" id="f-tags">
          ${TAGS.map(t => `<button class="tag" data-tag="${esc(t)}">${tagHTML(t)}</button>`).join('')}
          <button class="tag write" data-act="write">✏️ じぶんで${R('書', 'か')}く</button>
        </div>
        <textarea class="text-in" id="f-note" rows="3" maxlength="500" placeholder="きづいたこと、おもったこと" hidden></textarea>

        <h3 class="q">${R('場所', 'ばしょ')}</h3>
        <div class="loc-row">
          <div class="mini-map" id="f-minimap"></div>
          <div class="loc-btns">
            <button class="loc-btn mint" data-act="here">📍 いまの${R('場所', 'ばしょ')}にする</button>
            <button class="loc-btn" data-act="pick">🗺️ ${R('地図', 'ちず')}で えらびなおす</button>
          </div>
        </div>
        <p class="loc-status" id="f-locstatus"></p>

        <h3 class="q">だれが みつけた？</h3>
        <div class="who" id="f-who"></div>

        <h3 class="q">いつ？</h3>
        <input type="datetime-local" class="text-in" id="f-when">
      </div></div>
      <footer class="screen-foot"><button class="save-btn" data-act="save">✓ ほぞん</button></footer>
    </section>`);

    const name = $('#f-name', el), note = $('#f-note', el), when = $('#f-when', el);
    name.value = existing?.name || '';
    note.value = existing?.note || '';
    note.hidden = !note.value;
    $('[data-act="write"]', el).classList.toggle('on', !note.hidden);
    when.value = toLocalInput(existing?.foundAt || nowISO());

    // 写真
    let previewURL = null;
    async function renderPhoto() {
      const box = $('#f-photo', el);
      if (previewURL) { URL.revokeObjectURL(previewURL); previewURL = null; }
      let url = null;
      if (f.newPhoto) url = previewURL = URL.createObjectURL(f.newPhoto.blob);
      else if (f.photoId && !f.removePhoto) { const p = await dbGet('photos', f.photoId); if (p) url = previewURL = URL.createObjectURL(p.blob); }
      box.innerHTML = url ? `<img src="${url}" alt="">` : `<div class="ph-empty">📷<small>しゃしんは なくても だいじょうぶ</small></div>`;
      $('[data-act="nophoto"]', el).hidden = !url;
    }
    async function onFile(input) {
      const file = input.files && input.files[0]; input.value = '';
      if (!file) return;
      if (!/^image\//.test(file.type) && !/\.(jpe?g|png|heic|heif|webp|gif)$/i.test(file.name)) { toast('しゃしんを えらんでね'); return; }
      toast('📷 しゃしんを じゅんびちゅう…', 10000);
      try { f.newPhoto = await processPhoto(file); f.removePhoto = false; await renderPhoto(); toast('📷 しゃしん OK！', 1200); }
      catch (e) { console.error(e); toast('この しゃしんは よめなかったよ'); }
    }
    $('#f-cam', el).addEventListener('change', e => onFile(e.target));
    $('#f-lib', el).addEventListener('change', e => onFile(e.target));

    // カテゴリ
    function renderCats() { $$('.cat-btn', el).forEach(b => b.classList.toggle('on', b.dataset.cat === f.category)); }
    // シール
    function renderTags() { $$('[data-tag]', el).forEach(b => b.classList.toggle('on', f.tags.has(b.dataset.tag))); }
    // だれが
    function renderWho() {
      const box = $('#f-who', el);
      box.innerHTML = [...S.members.values()].map(m =>
        `<button class="who-btn ${m.id === f.authorId ? 'on' : ''}" data-who="${m.id}"><span class="avatar">${m.icon}</span>${esc(m.name)}</button>`).join('') +
        `<button class="who-btn add" data-act="addwho"><span class="avatar">＋</span>ふやす</button>`;
    }
    // 場所
    let mini = null, miniMarker = null;
    function renderLoc() {
      if (!mini) return;
      if (f.lat == null) { mini.setView(S.map.getCenter(), Math.min(S.map.getZoom(), 12)); if (miniMarker) { miniMarker.remove(); miniMarker = null; } return; }
      const ll = [f.lat, f.lng];
      mini.setView(ll, 15);
      if (!miniMarker) miniMarker = L.marker(ll, { icon: pinIcon(f.category || 'sonota'), interactive: false }).addTo(mini);
      else { miniMarker.setLatLng(ll); miniMarker.setIcon(pinIcon(f.category || 'sonota')); }
    }
    function setStatus(text, warn = false) { const s = $('#f-locstatus', el); s.innerHTML = text; s.classList.toggle('warn', warn); }
    async function useHere(auto) {
      setStatus('📡 いまの ばしょを さがしてるよ…');
      try {
        const pos = await getPosition();
        Object.assign(f, { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy });
        renderLoc();
        if (pos.accuracy > ACCURACY_WARN) setStatus(`ばしょが ずれているかも。${R('地図', 'ちず')}で えらびなおしてね（±${pos.accuracy}m）`, true);
        else setStatus(`📍 いまの ${R('場所', 'ばしょ')}に したよ（±${pos.accuracy}m）`);
      } catch (e) {
        setStatus(`いまの ばしょが わからなかったよ。${R('地図', 'ちず')}で えらんでね`, true);
        if (auto) await pick();
      }
    }
    async function pick() {
      const start = f.lat != null ? { lat: f.lat, lng: f.lng } : (S.lastPos || null);
      const res = await pickLocation(start, f.category);
      if (res) { Object.assign(f, { lat: res.lat, lng: res.lng, accuracy: null }); renderLoc(); setStatus(`🗺️ ${R('地図', 'ちず')}で えらんだ ${R('場所', 'ばしょ')}だよ`); }
    }

    el.addEventListener('click', async e => {
      const cat = e.target.closest('[data-cat]');
      if (cat) { f.category = cat.dataset.cat; renderCats(); renderLoc(); return; }
      const tag = e.target.closest('[data-tag]');
      if (tag) { const t = tag.dataset.tag; f.tags.has(t) ? f.tags.delete(t) : f.tags.add(t); renderTags(); return; }
      const who = e.target.closest('[data-who]');
      if (who) { f.authorId = who.dataset.who; renderWho(); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'close') {
        if (isNew && (f.newPhoto || name.value.trim() || f.category)) {
          if (!await ask({ icon: '🤔', title: 'ほぞんしないで とじる？', ok: 'とじる', cancel: 'もどる' })) return;
        }
        closeScreen(el); resolve(null);
      }
      else if (act === 'camera') $('#f-cam', el).click();
      else if (act === 'library') $('#f-lib', el).click();
      else if (act === 'nophoto') { f.newPhoto = null; f.removePhoto = true; renderPhoto(); }
      else if (act === 'write') { note.hidden = !note.hidden; e.target.closest('[data-act]').classList.toggle('on', !note.hidden); if (!note.hidden) note.focus(); }
      else if (act === 'here') useHere(false);
      else if (act === 'pick') pick();
      else if (act === 'addwho') {
        const d = await memberDialog(null);
        if (d) { const m = await addMember(d); f.authorId = m.id; renderWho(); }
      }
      else if (act === 'save') save();
    });

    async function save() {
      if (f.saving) return;
      if (!f.category) {
        const g = $('#f-cats', el); g.scrollIntoView({ behavior: 'smooth', block: 'center' });
        g.classList.add('shake'); setTimeout(() => g.classList.remove('shake'), 500);
        toast('なにを みつけたか えらんでね'); return;
      }
      if (f.lat == null) { toast('ばしょを えらんでね'); await pick(); if (f.lat == null) return; }
      f.saving = true;
      try {
        const t = nowISO();
        let photoId = f.photoId;
        if (f.newPhoto) {
          const newId = uuid();
          await dbPut('photos', { id: newId, blob: f.newPhoto.blob, thumb: f.newPhoto.thumb });
          if (photoId) await deletePhoto(photoId);
          photoId = newId;
        } else if (f.removePhoto && photoId) { await deletePhoto(photoId); photoId = null; }
        const rec = {
          id: existing?.id || uuid(),
          createdAt: existing?.createdAt || t,
          updatedAt: t,
          foundAt: fromLocalInput(when.value) || existing?.foundAt || t,
          authorId: f.authorId,
          category: f.category,
          name: name.value.trim().slice(0, 40),
          tags: [...f.tags],
          note: note.value.trim().slice(0, 500),
          lat: +f.lat.toFixed(6), lng: +f.lng.toFixed(6),
          accuracy: f.accuracy,
          photoId,
          deleted: false,
        };
        await dbPut('records', rec);
        S.records.set(rec.id, rec);
        if (f.authorId) setSetting('lastAuthorId', f.authorId);
        refreshMarkers(); checkReminder();
        closeScreen(el);
        resolve(rec);
        if (isNew) {
          const c = CAT[rec.category];
          setTimeout(() => showRecordOnMap(rec.id, { bounce: true }), 320);
          toast(`🎉 ${c.emoji} ${c.label} ${seqOf(rec)}こめ！`, 3200);
        } else toast('✓ なおしたよ');
      } catch (e) {
        console.error(e); f.saving = false; toast('ほぞん できなかったよ… もういちど ためしてね');
      }
    }

    el._onClose = () => { if (previewURL) URL.revokeObjectURL(previewURL); if (mini) mini.remove(); };
    openScreen(el);
    renderPhoto(); renderCats(); renderTags(); renderWho();
    setTimeout(() => { mini = makeMiniMap($('#f-minimap', el)); renderLoc(); setTimeout(() => mini && mini.invalidateSize(), 300); }, 50);
    if (isNew) setTimeout(() => useHere(true), 350);
    else if (existing.accuracy == null) setStatus(`🗺️ ${R('地図', 'ちず')}で えらんだ ${R('場所', 'ばしょ')}だよ`);
  });
}

/* ---------- 地図で場所をえらぶ ---------- */
function pickLocation(start, catId) {
  return new Promise(resolve => {
    const el = h(`<section class="screen">
      <header class="screen-head">
        <button class="icon-btn" data-act="close" aria-label="やめる">✕</button>
        <h2>${R('場所', 'ばしょ')}を えらぶ</h2><span class="spacer"></span>
      </header>
      <div class="screen-body nopad">
        <div class="picker-map" id="pk-map"></div>
        <div class="picker-hint">みつけた ばしょを タップしてね</div>
      </div>
      <footer class="screen-foot"><button class="save-btn" data-act="ok">✓ ここに する</button></footer>
    </section>`);
    let pm, marker, chosen = start ? { lat: start.lat, lng: start.lng } : null;
    function place(ll) {
      chosen = { lat: ll.lat, lng: ll.lng };
      if (!marker) {
        marker = L.marker(ll, { icon: pinIcon(catId || 'sonota'), draggable: true }).addTo(pm);
        marker.on('dragend', () => { const p = marker.getLatLng(); chosen = { lat: p.lat, lng: p.lng }; });
      } else marker.setLatLng(ll);
    }
    el.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') { closeScreen(el); resolve(null); }
      if (act === 'ok') {
        if (!chosen) { toast('ちずを タップして ばしょを えらんでね'); return; }
        closeScreen(el); resolve(chosen);
      }
    });
    el._onClose = () => pm && pm.remove();
    openScreen(el);
    setTimeout(() => {
      pm = L.map($('#pk-map', el), { zoomControl: false, attributionControl: false, minZoom: 5, maxZoom: 18, tap: false });
      L.control.attribution({ position: 'bottomright', prefix: false }).addTo(pm);
      L.tileLayer(BASES[S.base].url, { maxZoom: 18, minZoom: 5, attribution: S.base === 'photo' ? PHOTO_ATTR : GSI_ATTR }).addTo(pm);
      if (chosen) { pm.setView([chosen.lat, chosen.lng], 17); place(L.latLng(chosen.lat, chosen.lng)); }
      else pm.setView(S.map.getCenter(), Math.max(S.map.getZoom(), S.map.getZoom() <= 6 ? 6 : 15));
      pm.on('click', e => place(e.latlng));
      setTimeout(() => pm.invalidateSize(), 320);
    }, 30);
  });
}

/* =========================================================
   3. きろくカード
   ========================================================= */
function openCard(id) {
  const el = screenShell('きろくカード', { left: '←', right: '<button class="icon-btn" data-act="edit" aria-label="へんしゅう">✏️</button>' });
  const body = $('.wrap', el);
  let fullURL = null;

  async function render() {
    const r = S.records.get(id);
    if (!r || r.deleted) { closeScreen(el); return; }
    const c = CAT[r.category] || CAT.sonota;
    body.innerHTML = `
      <div class="card-photo" style="background:color-mix(in srgb, ${c.color} 22%, white)">${c.emoji}</div>
      <div style="margin-top:14px"><span class="badge" style="--c:${c.color}">${c.emoji} ${c.label}</span></div>
      <h1 class="card-name ${r.name ? '' : 'none'}">${esc(r.name) || 'なまえ まだ'}</h1>
      <div class="meta"><span>📅 ${fmtDate(r.foundAt, new Date(r.foundAt).getFullYear() !== new Date().getFullYear())}</span><span>${memberLabel(r.authorId)}</span>
        <span>${r.accuracy == null ? `🗺️ ${R('地図', 'ちず')}で えらんだ` : `📍 ±${r.accuracy}m`}</span></div>
      ${r.tags.length ? `<div class="tags" style="margin-top:10px">${r.tags.map(t => `<span class="tag static on">${tagHTML(t)}</span>`).join('')}</div>` : ''}
      ${r.note ? `<div class="note-box">${esc(r.note)}</div>` : ''}
      <div class="count-box"><span>${c.emoji}</span><span class="grow">${c.label} <b>${seqOf(r)}</b> こめ！</span><span>🏅</span></div>
      <div class="card-actions">
        <button data-act="map">🗺️ ${R('地図', 'ちず')}で ${R('見', 'み')}る</button>
        <button data-act="delete">🗑️ けす</button>
      </div>`;
    if (r.photoId) {
      const p = await dbGet('photos', r.photoId);
      if (p) {
        if (fullURL) URL.revokeObjectURL(fullURL);
        fullURL = URL.createObjectURL(p.blob);
        const box = $('.card-photo', body); box.innerHTML = `<img src="${fullURL}" alt="${esc(r.name)}">`;
        $('img', box).addEventListener('click', () => lightbox(fullURL));
      }
    }
  }

  el.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') closeScreen(el);
    else if (act === 'edit') { const saved = await openForm(S.records.get(id)); if (saved) render(); }
    else if (act === 'map') { closeAllScreens(); setTimeout(() => showRecordOnMap(id, { bounce: true }), 320); }
    else if (act === 'delete') {
      if (!await ask({ icon: '🗑️', title: 'この きろくを けす？', ok: 'けす', cancel: 'やめる', danger: true })) return;
      if (!await ask({ icon: '⚠️', title: 'ほんとうに けして いい？', text: 'けすと もとに もどせないよ', ok: 'ほんとうに けす', cancel: 'やめる', danger: true })) return;
      const r = S.records.get(id);
      await deletePhoto(r.photoId);
      const dead = { ...r, photoId: null, deleted: true, updatedAt: nowISO() };
      await dbPut('records', dead); S.records.set(id, dead);
      refreshMarkers(); checkReminder();
      closeScreen(el); toast('けしたよ');
    }
  });
  el._onClose = () => { if (fullURL) setTimeout(() => URL.revokeObjectURL(fullURL), 400); };
  openScreen(el);
  render();
}

/* =========================================================
   4. 📖 メニュー
   ========================================================= */
function openMenu() {
  const el = screenShell('📖 メニュー');
  const n = liveRecords().length;
  $('.wrap', el).innerHTML = `<div class="menu-list">
    <button class="menu-item" data-go="zukan"><span class="e">📚</span><span><b>ずかん</b><small>あつめた きろく ${n}こ</small></span></button>
    <button class="menu-item" data-go="family"><span class="e">👨‍👩‍👧</span><span><b>かぞく</b><small>だれが みつけたか の なかま</small></span></button>
    <button class="menu-item" data-go="export"><span class="e">📤</span><span><b>かきだす</b><small>ファイルに して かぞくに おくる</small></span></button>
    <button class="menu-item" data-go="import"><span class="e">📥</span><span><b>とりこむ</b><small>もらった ファイルを がったい</small></span></button>
    <button class="menu-item" data-go="parents"><span class="e">🏠</span><span><b>おうちの${R('人', 'ひと')}へ</b><small>つかいかた・ほぞんの しくみ</small></span></button>
  </div>`;
  el.addEventListener('click', e => {
    if (e.target.closest('[data-act="close"]')) return closeScreen(el);
    const go = e.target.closest('[data-go]')?.dataset.go;
    if (go === 'zukan') openZukan();
    if (go === 'family') openFamily();
    if (go === 'export') openExport();
    if (go === 'import') openImport();
    if (go === 'parents') openParents();
  });
  openScreen(el);
}

/* ---------- ずかん ---------- */
function openZukan() {
  const el = screenShell('📚 ずかん');
  const body = $('.wrap', el);
  let tab = 'all';
  async function render() {
    const live = liveRecords();
    const counts = Object.fromEntries(CATS.map(c => [c.id, live.filter(r => r.category === c.id).length]));
    const items = [{ id: 'all', label: 'ぜんぶ', emoji: '', color: 'var(--coral)' }, ...CATS];
    const list = live.filter(r => tab === 'all' || r.category === tab)
      .sort((a, b) => b.foundAt.localeCompare(a.foundAt));
    const c = CAT[tab];
    const n = tab === 'all' ? live.length : counts[tab];
    const seq = seqMap();
    body.innerHTML = `
      <div class="zk-tabs">${items.map(i => `<button class="chip ${tab === i.id ? 'on' : ''}" data-tab="${i.id}" style="--c:${i.color}">${i.emoji}${i.label} ${i.id === 'all' ? live.length : counts[i.id]}</button>`).join('')}</div>
      ${c ? `<div class="zk-summary"><span class="big">${c.emoji}</span><span class="cnt">${c.label}<br>${n}こ</span>
        <span class="medals">${BADGES.map(b => `<span class="medal ${n >= b.n ? '' : 'off'}">${b.icon}<small>${b.n}こ</small></span>`).join('')}</span></div>`
        : `<div class="zk-summary" style="flex-wrap:wrap;gap:6px 12px">${CATS.map(k => {
          const got = BADGES.filter(b => counts[k.id] >= b.n).pop();
          return `<span><b>${k.emoji}${counts[k.id]}</b>${got ? got.icon : ''}</span>`;
        }).join('')}</div>`}
      ${list.length ? `<div class="grid">${list.map(r => {
        const k = CAT[r.category];
        return `<button class="tile" data-id="${r.id}" style="--c:color-mix(in srgb, ${k.color} 30%, white)">${k.emoji}<span class="no">${k.emoji}${seq.get(r.id)}</span><span class="lbl">${esc(r.name) || 'なまえ まだ'}</span></button>`;
      }).join('')}</div>` : `<div class="empty"><span class="e">🔍</span>まだ ないよ。<br>さがしに いこう！</div>`}`;
    for (const t of $$('.tile', body)) {
      const r = S.records.get(t.dataset.id);
      thumbURL(r.photoId).then(u => { if (u) t.insertAdjacentHTML('afterbegin', `<img src="${u}" alt="" loading="lazy">`); });
    }
  }
  el.addEventListener('click', e => {
    if (e.target.closest('[data-act="close"]')) return closeScreen(el);
    const t = e.target.closest('[data-tab]'); if (t) { tab = t.dataset.tab; render(); return; }
    const tile = e.target.closest('[data-id]'); if (tile) openCard(tile.dataset.id);
  });
  el._refresh = render;
  openScreen(el); render();
}

/* ---------- かぞく ---------- */
function openFamily() {
  const el = screenShell('👨‍👩‍👧 かぞく');
  const body = $('.wrap', el);
  function render() {
    const owner = S.settings.deviceOwnerId;
    body.innerHTML = `<p class="muted">「この たんまつ」に した ${R('人', 'ひと')}が、きろくする ときの さいしょの「だれが」に なるよ。</p>
      ${[...S.members.values()].map(m => `<div class="fam-row">
        <button class="avatar" data-edit="${m.id}" aria-label="なおす">${m.icon}</button>
        <span class="nm">${esc(m.name)}${m.id === owner ? '<small>📱 この たんまつ</small>' : ''}</span>
        <button class="mini-btn" data-edit="${m.id}">なおす</button>
        <button class="mini-btn ${m.id === owner ? 'on' : ''}" data-owner="${m.id}">📱</button>
      </div>`).join('')}
      <button class="big-btn white" data-act="add" style="margin-top:6px">＋ かぞくを ふやす</button>`;
  }
  el.addEventListener('click', async e => {
    if (e.target.closest('[data-act="close"]')) return closeScreen(el);
    const ed = e.target.closest('[data-edit]');
    if (ed) {
      const m = S.members.get(ed.dataset.edit);
      const d = await memberDialog(m);
      if (d) { const nm = { ...m, ...d, updatedAt: nowISO() }; await dbPut('members', nm); S.members.set(nm.id, nm); render(); }
      return;
    }
    const ow = e.target.closest('[data-owner]');
    if (ow) { await setSetting('deviceOwnerId', ow.dataset.owner); await setSetting('lastAuthorId', ow.dataset.owner); render(); toast('📱 この たんまつの ひとに したよ'); return; }
    if (e.target.closest('[data-act="add"]')) { const d = await memberDialog(null); if (d) { await addMember(d); render(); } }
  });
  openScreen(el); render();
}

/* =========================================================
   5. かきだす・とりこむ
   ========================================================= */
function safeName(s) { return String(s || 'kazoku').replace(/[\\/:*?"<>|\s.]+/g, '').slice(0, 20) || 'kazoku'; }
function ymd(d = new Date()) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; }

async function buildExport(mode, onProgress) {
  const startedAt = nowISO();
  const since = mode === 'diff' ? S.settings.lastExportAt : null;
  const recs = [...S.records.values()].filter(r => !since || r.updatedAt > since);
  const zip = new JSZip();
  const folder = zip.folder('photos');
  let photos = 0;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r.deleted && r.photoId) {
      const p = await dbGet('photos', r.photoId);
      if (p) { folder.file(`${r.photoId}.jpg`, p.blob); photos++; }
    }
    onProgress && onProgress((i + 1) / recs.length * 0.5);
  }
  const owner = memberOf(S.settings.deviceOwnerId);
  zip.file('data.json', JSON.stringify({
    app: APP_ID, format: DATA_FORMAT, appVersion: APP_VERSION, exportedAt: startedAt,
    exportedBy: owner ? owner.name : null, mode: since ? 'diff' : 'all', since,
    records: recs, members: [...S.members.values()],
  }));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/zip' },
    m => onProgress && onProgress(0.5 + m.percent / 200));
  const fileName = `mitsuketa-${safeName(owner && owner.name)}-${ymd()}.zip`;
  const file = new File([blob], fileName, { type: 'application/zip' });
  return { file, startedAt, count: recs.length, photos };
}

function openExport() {
  const el = screenShell('📤 かきだす');
  const body = $('.wrap', el);
  const last = S.settings.lastExportAt;
  const all = S.records.size;
  const diff = last ? [...S.records.values()].filter(r => r.updatedAt > last).length : 0;
  let mode = last && diff ? 'diff' : 'all';
  let built = null;
  function renderChoose() {
    body.innerHTML = `
      <div class="info good">きろくを 1つの ファイルに まとめるよ。LINE や AirDrop で かぞくに おくってね。</div>
      <button class="radio-card ${mode === 'all' ? 'on' : ''}" data-mode="all"><span class="dot"></span><span>ぜんぶ<small>きろく ${all}こ（けした しるしも ふくむ）</small></span></button>
      <button class="radio-card ${mode === 'diff' ? 'on' : ''}" data-mode="diff" ${last ? '' : 'disabled'}><span class="dot"></span><span>まえに かきだしてから あたらしい ぶんだけ<small>${last ? `${fmtDate(last, true)}から ${diff}こ` : 'まだ かきだしたことが ないよ'}</small></span></button>
      <button class="big-btn coral" data-act="build" style="margin-top:16px">📦 ファイルを つくる</button>
      <p class="muted" style="margin-top:14px">⚠️ ファイルには みつけた ばしょが はいっているよ。かぞく いがいには おくらないでね。</p>`;
  }
  async function build() {
    const n = mode === 'diff' ? diff : all;
    if (!n) { toast('かきだす きろくが ないよ'); return; }
    body.innerHTML = `<div class="center" style="padding:30px 0"><div style="font-size:50px">📦</div><b>ファイルを つくってるよ…</b><div class="progress"><div></div></div></div>`;
    try {
      built = await buildExport(mode, p => { const bar = $('.progress div', body); if (bar) bar.style.width = `${Math.round(p * 100)}%`; });
      renderReady();
    } catch (e) { console.error(e); toast('ファイルが つくれなかったよ'); renderChoose(); }
  }
  function renderReady() {
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [built.file] }));
    const mb = (built.file.size / 1024 / 1024).toFixed(1);
    body.innerHTML = `
      <div class="center" style="padding:10px 0 4px"><div style="font-size:50px">🎁</div><b>じゅんび できた！</b>
      <p class="muted">きろく ${built.count}こ・しゃしん ${built.photos}まい（${mb}MB）<br>${esc(built.file.name)}</p></div>
      ${canShare ? `<button class="big-btn coral" data-act="share">📨 おくる（LINE・AirDrop）</button>` : ''}
      <button class="big-btn white" data-act="download">💾 ファイルに ほぞんする</button>
      <p class="muted" style="margin-top:14px">⚠️ かぞく いがいには おくらないでね。</p>`;
  }
  async function markDone() {
    await setSetting('lastExportAt', built.startedAt);
    S.bannerClosed = false; checkReminder();
  }
  el.addEventListener('click', async e => {
    if (e.target.closest('[data-act="close"]')) return closeScreen(el);
    const m = e.target.closest('[data-mode]');
    if (m && !m.disabled) { mode = m.dataset.mode; renderChoose(); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'build') build();
    if (act === 'share') {
      try { await navigator.share({ files: [built.file], title: 'みつけたマップ' }); await markDone(); toast('📨 おくったよ'); }
      catch (err) { if (err && err.name !== 'AbortError') { console.error(err); toast('おくれなかったよ。「ファイルに ほぞん」を ためしてね'); } }
    }
    if (act === 'download') {
      const url = URL.createObjectURL(built.file);
      const a = document.createElement('a'); a.href = url; a.download = built.file.name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      await markDone(); toast('💾 ほぞんしたよ');
    }
  });
  openScreen(el); renderChoose();
}

/* ---------- 取り込み：中身のチェック ---------- */
function cleanISO(v) { if (typeof v !== 'string' || v.length > 40) return null; const t = Date.parse(v); return isNaN(t) ? null : new Date(t).toISOString(); }
function cleanStr(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
function sanitizeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  const createdAt = cleanISO(r.createdAt), updatedAt = cleanISO(r.updatedAt);
  if (!createdAt || !updatedAt) return null;
  const deleted = r.deleted === true;
  const lat = Number(r.lat), lng = Number(r.lng);
  if (!deleted && (!CAT[r.category] || !isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)) return null;
  return {
    id: r.id, createdAt, updatedAt,
    foundAt: cleanISO(r.foundAt) || createdAt,
    authorId: typeof r.authorId === 'string' && ID_RE.test(r.authorId) ? r.authorId : null,
    category: CAT[r.category] ? r.category : 'sonota',
    name: cleanStr(r.name, 40),
    tags: Array.isArray(r.tags) ? r.tags.filter(t => typeof t === 'string').slice(0, 20).map(t => t.slice(0, 20)) : [],
    note: cleanStr(r.note, 1000),
    lat: isFinite(lat) ? lat : 0, lng: isFinite(lng) ? lng : 0,
    accuracy: typeof r.accuracy === 'number' && isFinite(r.accuracy) ? Math.round(r.accuracy) : null,
    photoId: !deleted && typeof r.photoId === 'string' && ID_RE.test(r.photoId) ? r.photoId : null,
    deleted,
  };
}
function sanitizeMember(m) {
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !ID_RE.test(m.id)) return null;
  const name = cleanStr(m.name, 12).trim(); if (!name) return null;
  const icon = typeof m.icon === 'string' && [...m.icon].length <= 4 ? m.icon : '🙂';
  return { id: m.id, name, icon, updatedAt: cleanISO(m.updatedAt) || '1970-01-01T00:00:00.000Z' };
}
function importError(msg) { const e = new Error(msg); e.user = true; return e; }

async function analyzeImport(file) {
  if (file.size > IMPORT_LIMITS.zip) throw importError('ファイルが おおきすぎるよ');
  if (file.size < 22) throw importError('みつけたマップの ファイルじゃ ないみたい');
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!(head[0] === 0x50 && head[1] === 0x4B && head[2] === 0x03 && head[3] === 0x04)) throw importError('みつけたマップの ファイルじゃ ないみたい');
  let zip;
  try { zip = await JSZip.loadAsync(file); } catch { throw importError('ファイルが こわれているみたい'); }
  const dj = zip.file('data.json');
  if (!dj) throw importError('みつけたマップの ファイルじゃ ないみたい');
  const size = dj._data && dj._data.uncompressedSize;
  if (size && size > IMPORT_LIMITS.json) throw importError('ファイルが おおきすぎるよ');
  let data;
  try { data = JSON.parse(await dj.async('string')); } catch { throw importError('ファイルが こわれているみたい'); }
  if (!data || data.app !== APP_ID || !Array.isArray(data.records) || !Array.isArray(data.members)) throw importError('みつけたマップの ファイルじゃ ないみたい');
  if (data.format > DATA_FORMAT) throw importError('あたらしい バージョンの ファイルだよ。ページを よみこみなおしてね');
  if (data.records.length > IMPORT_LIMITS.records || data.members.length > IMPORT_LIMITS.members) throw importError('きろくが おおすぎるよ');

  const plan = { zip, add: [], update: [], del: [], marks: [], same: 0, newMembers: [], updMembers: [], skipped: 0, exportedBy: cleanStr(data.exportedBy, 12) };
  const seen = new Set();
  for (const raw of data.records) {
    const r = sanitizeRecord(raw);
    if (!r || seen.has(r.id)) { plan.skipped++; continue; }
    seen.add(r.id);
    const cur = S.records.get(r.id);
    if (!cur) (r.deleted ? plan.marks : plan.add).push(r);
    else if (r.updatedAt > cur.updatedAt) {
      if (r.deleted && !cur.deleted) plan.del.push(r);
      else if (r.deleted) plan.marks.push(r);
      else plan.update.push(r);
    } else plan.same++;
  }
  for (const raw of data.members) {
    const m = sanitizeMember(raw); if (!m) continue;
    const cur = S.members.get(m.id);
    if (!cur) plan.newMembers.push(m);
    else if (m.updatedAt > cur.updatedAt) plan.updMembers.push(m);
  }
  return plan;
}

async function readZipPhoto(zip, photoId) {
  const zf = zip.file(`photos/${photoId}.jpg`);
  if (!zf) return null;
  const size = zf._data && zf._data.uncompressedSize;
  if (size && size > IMPORT_LIMITS.photo) return null;
  const ab = await zf.async('arraybuffer');
  if (ab.byteLength > IMPORT_LIMITS.photo) return null;
  const b = new Uint8Array(ab, 0, 3);
  if (!(b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF)) return null;
  return new Blob([ab], { type: 'image/jpeg' });
}

async function applyImport(plan, onProgress) {
  for (const m of [...plan.newMembers, ...plan.updMembers]) { await dbPut('members', m); S.members.set(m.id, m); }
  const all = [...plan.add, ...plan.update, ...plan.del, ...plan.marks];
  for (let i = 0; i < all.length; i++) {
    const r = { ...all[i] };
    const cur = S.records.get(r.id);
    if (!r.deleted && r.photoId) {
      const have = await dbGet('photos', r.photoId);
      if (!have) {
        const blob = await readZipPhoto(plan.zip, r.photoId);
        if (blob) await dbPut('photos', { id: r.photoId, blob, thumb: await makeThumb(blob) });
        else if (cur && cur.photoId === r.photoId) { /* そのまま */ }
        else r.photoId = (cur && !cur.deleted) ? cur.photoId : null;
      }
    }
    if (cur && cur.photoId && cur.photoId !== r.photoId) {
      const used = [...S.records.values()].some(x => x.id !== r.id && x.photoId === cur.photoId);
      if (!used) await deletePhoto(cur.photoId);
    }
    await dbPut('records', r); S.records.set(r.id, r);
    onProgress && onProgress((i + 1) / all.length);
  }
}

function openImport() {
  const el = screenShell('📥 とりこむ');
  const body = $('.wrap', el);
  let plan = null;
  function renderStart(msg = '') {
    body.innerHTML = `
      <div class="info good">かぞくから もらった「mitsuketa-〜.zip」を えらんでね。じぶんの きろくと がったい するよ。</div>
      ${msg ? `<div class="info warn">${msg}</div>` : ''}
      <button class="big-btn coral" data-act="pick">📂 ファイルを えらぶ</button>
      <input type="file" id="im-file" accept=".zip,application/zip,application/x-zip-compressed" hidden>
      <p class="muted" style="margin-top:14px">LINE で もらったときは、ファイルを ひらいて「ファイルに ほぞん」してから えらんでね。<br>おなじ ファイルを なんかい とりこんでも きろくは ふえないよ。</p>`;
    $('#im-file', body).addEventListener('change', e => onFile(e.target));
  }
  async function onFile(input) {
    const file = input.files && input.files[0]; input.value = '';
    if (!file) return;
    body.innerHTML = `<div class="center" style="padding:30px 0"><div style="font-size:50px">🔍</div><b>ファイルを しらべてるよ…</b></div>`;
    try { plan = await analyzeImport(file); renderPlan(); }
    catch (e) { console.error(e); renderStart(e.user ? esc(e.message) : 'ファイルが よめなかったよ'); }
  }
  function renderPlan() {
    const p = plan;
    const total = p.add.length + p.update.length + p.del.length + p.marks.length + p.newMembers.length + p.updMembers.length;
    body.innerHTML = `
      <div class="center"><div style="font-size:50px">📬</div><b>${p.exportedBy ? `${esc(p.exportedBy)} から の ファイル` : 'ファイルの なかみ'}</b></div>
      <div class="info" style="margin-top:12px">
        <p>✨ あたらしい きろく <span class="result-num">${p.add.length}</span>こ</p>
        <p>🔄 こうしん <span class="result-num">${p.update.length}</span>こ</p>
        ${p.del.length ? `<p>🗑️ けされた きろく <span class="result-num">${p.del.length}</span>こ</p>` : ''}
        <p class="muted">おなじ（かわらない） ${p.same}こ${p.skipped ? `・よめなかった ${p.skipped}こ` : ''}</p>
        ${p.newMembers.length ? `<p>👋 あたらしい かぞく：${p.newMembers.map(m => `${m.icon}${esc(m.name)}`).join('、')}</p>` : ''}
      </div>
      ${total ? `<button class="big-btn" data-act="apply">✓ とりこむ</button>` : `<div class="info good center">もう ぜんぶ はいってるよ 👍</div>`}
      <button class="big-btn white" data-act="cancel">やめる</button>`;
  }
  el.addEventListener('click', async e => {
    if (e.target.closest('[data-act="close"]')) return closeScreen(el);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'pick') $('#im-file', body).click();
    if (act === 'cancel') { plan = null; renderStart(); }
    if (act === 'apply') {
      body.innerHTML = `<div class="center" style="padding:30px 0"><div style="font-size:50px">🧩</div><b>がったい してるよ…</b><div class="progress"><div></div></div></div>`;
      try {
        await applyImport(plan, p => { const bar = $('.progress div', body); if (bar) bar.style.width = `${Math.round(p * 100)}%`; });
        refreshMarkers(); checkReminder();
        const n = plan.add.length;
        body.innerHTML = `<div class="center" style="padding:30px 0"><div style="font-size:60px">🎉</div><b style="font-size:20px">とりこんだよ！</b>
          <p class="muted">あたらしい きろく ${n}こ・こうしん ${plan.update.length}こ</p></div>
          <button class="big-btn" data-act="tomap">🗺️ ${R('地図', 'ちず')}を ${R('見', 'み')}る</button>`;
        plan = null;
      } catch (err) { console.error(err); renderStart('とちゅうで とまっちゃった。もういちど ためしてね（おなじ ファイルで だいじょうぶ）'); }
    }
    if (act === 'tomap') { closeAllScreens(); fitAll(); }
  });
  openScreen(el); renderStart();
}

function fitAll() {
  const live = liveRecords(); if (!live.length) return;
  const b = L.latLngBounds(live.map(r => [r.lat, r.lng]));
  S.map.fitBounds(b, { padding: [60, 60], maxZoom: 16 });
}

/* ---------- おうちの人へ ---------- */
async function openParents() {
  const el = screenShell(`🏠 おうちの${R('人', 'ひと')}へ`);
  const body = $('.wrap', el);
  let persisted = null, usage = '';
  try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch { }
  try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); usage = `${(e.usage / 1024 / 1024).toFixed(1)}MB`; } } catch { }
  const last = S.settings.lastExportAt;
  body.innerHTML = `
    <div class="info ${isStandalone() ? 'good' : 'warn'}">
      <h3>📲 ホーム画面に追加して使ってください</h3>
      ${isStandalone() ? '<p>ホーム画面から起動されています 👍</p>' : `
      <ol><li>Safari の共有ボタン（□に↑）をタップ</li><li>「ホーム画面に追加」をタップ</li><li>次からはホーム画面のアイコンから開く</li></ol>
      <p>Safari は、しばらく開かれていないサイトのデータを自動で消すことがあります。ホーム画面から使うと消えにくくなります。</p>`}
    </div>
    <div class="info">
      <h3>💾 記録の保存のしくみ</h3>
      <p>記録と写真は<b>この端末の中だけ</b>（ブラウザの保存領域）に保存されます。サーバーには送られません。GitHub に置いてあるのはアプリのプログラムだけです。</p>
      <p class="muted">使用量：${usage || '不明'}／消えにくい保存：${persisted === true ? '有効' : persisted === false ? '未許可（ブラウザ判断）' : '不明'}</p>
    </div>
    <div class="info">
      <h3>🛟 バックアップのすすめ</h3>
      <p>端末の故障・機種変更・Safari のデータ消去に備えて、ときどき「📤 かきだす」でファイルを作り、保護者の端末やクラウドに保存してください。最後の書き出しから14日たつか、新しい記録が10こたまると、地図の上でお知らせします。</p>
      <p class="muted">最後の書き出し：${last ? new Date(last).toLocaleString('ja-JP') : 'まだありません'}</p>
    </div>
    <div class="info">
      <h3>👨‍👩‍👧 家族での共有</h3>
      <ol><li>📤 かきだす → LINE・AirDrop で送る</li><li>受け取った人は、ファイルを「ファイル」アプリに保存</li><li>📥 とりこむ → ファイルを選ぶ</li></ol>
      <p>同じ記録は新しい方が残ります。同じファイルを何度取り込んでも記録は増えません。消した記録は、取り込んだ先でも消えます。</p>
    </div>
    <div class="info warn">
      <h3>🔒 位置情報について</h3>
      <p>書き出したファイルには、見つけた場所の正確な位置（自宅の近くなど）が入っています。<b>家族以外には送らないでください。</b>写真は保存時に描き直すので、写真に埋め込まれた位置情報（EXIF）は残りません。</p>
    </div>
    <div class="info">
      <h3>🗺️ 出典・ライセンス</h3>
      <p>地図：<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>（国土地理院）</p>
      <p class="muted">「しゃしん」の地図：データソース Landsat8画像（GSI,TSIC,GEO Grid/AIST）、Landsat8画像（courtesy of the U.S. Geological Survey）、海底地形（GEBCO）、GRUS画像（© Axelspace）を含みます。</p>
      <p class="muted">Leaflet（BSD-2-Clause）／Leaflet.markercluster（MIT）／JSZip（MIT または GPLv3）を同梱しています。解析ツール・広告・外部送信はありません（地図画像の読み込みのみ国土地理院のサーバーと通信します）。</p>
      <p class="muted">みつけたマップ v${APP_VERSION}</p>
    </div>
    <button class="danger-btn" data-act="reset">⚠️ 記録をリセット</button>`;
  el.addEventListener('click', async e => {
    if (e.target.closest('[data-act="close"]')) return closeScreen(el);
    if (e.target.closest('[data-act="reset"]')) {
      if (!await ask({ icon: '⚠️', title: '記録をすべて消しますか？', text: 'この端末の記録・写真・家族の設定がすべて消えます。', ok: '消す', danger: true })) return;
      if (!await ask({ icon: '🛑', title: '本当に消しますか？', text: '元に戻せません。必要なら先に「かきだす」でバックアップしてください。', ok: 'すべて消す', danger: true })) return;
      await dbClearAll();
      location.reload();
    }
  });
  openScreen(el);
}

/* =========================================================
   はじめて開いたとき
   ========================================================= */
function welcome() {
  return new Promise(resolve => {
    let icon = '🐰';
    const el = h(`<section class="screen">
      <div class="screen-body"><div class="wrap" style="padding-top:calc(20px + var(--safe-t))">
        <div class="center"><img src="icons/icon-192.png" alt="" width="96" height="96" style="border-radius:24px;box-shadow:var(--shadow)">
          <h2 style="font-size:26px;margin:14px 0 4px">みつけたマップへ ようこそ！</h2>
          <p class="muted" style="font-size:16px;line-height:1.8">みつけた ものを しゃしんと いっしょに<br>${R('地図', 'ちず')}に のこして いこう 🌸🐞🏯</p></div>
        <h3 class="q">あなたの なまえは？</h3>
        <input class="text-in" id="w-name" maxlength="12" autocomplete="off" placeholder="なまえ">
        <h3 class="q">すきな どうぶつを えらんでね</h3>
        <div class="animal-grid" id="w-animals">${ANIMALS.map(a => `<button data-a="${a}" class="${a === icon ? 'on' : ''}">${a}</button>`).join('')}</div>
        ${isStandalone() ? '' : `<div class="info warn" style="margin-top:18px"><h3>おうちの人へ</h3>Safari の共有ボタン →「ホーム画面に追加」で、アプリのように使えます。記録が消えにくくなるので、ぜひ追加してください。</div>`}
      </div></div>
      <footer class="screen-foot"><button class="save-btn" data-act="go">はじめる！</button></footer>
    </section>`);
    el.addEventListener('click', async e => {
      const a = e.target.closest('[data-a]');
      if (a) { icon = a.dataset.a; $$('[data-a]', el).forEach(b => b.classList.toggle('on', b === a)); return; }
      if (e.target.closest('[data-act="go"]')) {
        const inp = $('#w-name', el); const name = inp.value.trim();
        if (!name) { inp.classList.add('shake'); setTimeout(() => inp.classList.remove('shake'), 500); inp.focus(); return; }
        const m = await addMember({ name, icon });
        await setSetting('deviceOwnerId', m.id); await setSetting('lastAuthorId', m.id);
        closeScreen(el); resolve();
      }
    });
    openScreen(el);
  });
}

/* =========================================================
   起動
   ========================================================= */
async function start() {
  try {
    const [records, members, settings] = await Promise.all([dbAll('records'), dbAll('members'), dbAll('settings')]);
    records.forEach(r => S.records.set(r.id, r));
    members.forEach(m => S.members.set(m.id, m));
    settings.forEach(s => { S.settings[s.key] = s.value; });
  } catch (e) {
    console.error(e);
    toast('ほぞんの ばしょが つかえないみたい（プライベートブラウズ では つかえないよ）', 8000);
  }
  if (!S.settings.firstRunAt) await setSetting('firstRunAt', nowISO()).catch(() => { });
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { }

  initMap();
  renderFilters();
  refreshMarkers();

  if (!S.members.size) await welcome();

  // 初期表示：現在地がとれればそこへ。とれなければ日本全体（記録があれば記録全体）
  try { const pos = await getPosition(); drawMe(pos); S.map.setView([pos.lat, pos.lng], 16); }
  catch { if (liveRecords().length) fitAll(); }
  checkReminder();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e));
  }
}
start();
