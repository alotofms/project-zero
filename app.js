'use strict';

/* ---------- config ---------- */
const WEB_CLIENT_ID = '351479291268-gf1h06nicbbo1p5o9bqceqci2rrsadi9.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

/* ---------- elements ---------- */
const $ = (id) => document.getElementById(id);
const statusEl = $('status'), todayLabel = $('todayLabel');
const preview = $('preview'), shutter = $('shutter'), camStatus = $('camStatus');
const voiceBtn = $('voiceBtn'), voicePulse = $('voicePulse'), voiceStatus = $('voiceStatus');
const imageInput = $('imageInput'), fileInput = $('fileInput');
const goalsList = $('goalsList'), goalInput = $('goalInput'), goalForm = $('goalForm'),
      goalsBar = $('goalsBar'), goalsProgress = $('goalsProgress');
const notesList = $('notesList'), noteInput = $('noteInput'), noteForm = $('noteForm');

/* ---------- state ---------- */
let accessToken = null, tokenExpiry = 0, tokenClient = null, tokenResolvers = [];
let stream = null, mediaRecorder = null, recordedChunks = [];
let voiceStream = null, voiceRec = null, voiceChunks = [];
let camMode = null, lastMsg = 'Ready', processing = false, db = null, flashT = null;
let pzId = null; const dayCache = {};

/* ---------- mime / filenames / dates ---------- */
const pickMime = (c) => c.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
const VIDEO_MIME = pickMime(['video/mp4', 'video/mp4;codecs=h264', 'video/webm;codecs=vp9', 'video/webm']);
const AUDIO_MIME = pickMime(['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm']);
const videoExt = VIDEO_MIME.includes('mp4') ? 'mp4' : 'webm';
const audioExt = AUDIO_MIME.includes('mp4') ? 'm4a' : 'webm';
const pad = (n) => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`; };
const fname = (ext) => `ProjectZero_${stamp()}.${ext}`;
const localDay = (date) => { const o = date.getTimezoneOffset() * 60000; return new Date(date - o).toISOString().slice(0, 10); };
const TODAY = localDay(new Date());
todayLabel.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

/* ---------- auth ---------- */
function whenGIS(cb) { (window.google && google.accounts && google.accounts.oauth2) ? cb() : setTimeout(() => whenGIS(cb), 120); }
function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: WEB_CLIENT_ID, scope: SCOPE,
    callback: (resp) => {
      if (resp && resp.access_token) {
        accessToken = resp.access_token;
        tokenExpiry = Date.now() + ((resp.expires_in || 3600) * 1000) - 60000;
        tokenResolvers.forEach((r) => r.resolve(accessToken)); tokenResolvers = [];
        onSignedIn();
      } else { tokenResolvers.forEach((r) => r.reject(new Error('auth'))); tokenResolvers = []; }
    },
    error_callback: () => {}
  });
}
function requestToken(prompt) {
  return new Promise((resolve, reject) => { tokenResolvers.push({ resolve, reject }); tokenClient.requestAccessToken({ prompt: prompt || '' }); });
}
async function ensureToken() { return (accessToken && Date.now() < tokenExpiry) ? accessToken : requestToken(''); }
function onSignedIn() { render(); processQueue(); syncJournal(); }
function requireAuth() { if (!accessToken) { requestToken('').catch(() => {}); return false; } return true; }

/* ---------- Drive ---------- */
async function findOrCreateFolder(name, parentId, token) {
  const q = `mimeType='application/vnd.google-apps.folder' and name='${name}' and '${parentId}' in parents and trashed=false`;
  const fr = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`, { headers: { Authorization: 'Bearer ' + token } });
  if (!fr.ok) throw new Error('find ' + fr.status);
  const fd = await fr.json();
  if (fd.files && fd.files.length) return fd.files[0].id;
  const cr = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }) });
  if (!cr.ok) throw new Error('mkdir ' + cr.status);
  return (await cr.json()).id;
}
async function resolveDailyFolder(date, token) {
  const ds = localDay(date);
  if (dayCache[ds]) return dayCache[ds];
  if (!pzId) { const pb = await findOrCreateFolder('Personal Brand', 'root', token); pzId = await findOrCreateFolder('Project Zero', pb, token); }
  const id = await findOrCreateFolder(ds, pzId, token);
  dayCache[ds] = id; return id;
}
async function uploadToDrive(name, mime, blob, createdAt) {
  const token = await ensureToken();
  const folderId = await resolveDailyFolder(new Date(createdAt), token);
  const cr = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parents: [folderId] }) });
  if (!cr.ok) throw new Error('create ' + cr.status);
  const { id } = await cr.json();
  const ur = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': mime || 'application/octet-stream' }, body: blob });
  if (!ur.ok) throw new Error('media ' + ur.status);
  return id;
}
async function upsertTextFile(name, content, folderId, token) {
  const q = `name='${name}' and '${folderId}' in parents and trashed=false`;
  const fr = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`, { headers: { Authorization: 'Bearer ' + token } });
  const fd = await fr.json();
  let id = fd.files && fd.files[0] && fd.files[0].id;
  if (!id) {
    const cr = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parents: [folderId], mimeType: 'text/plain' }) });
    id = (await cr.json()).id;
  }
  await fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'text/plain' }, body: content });
}

/* ---------- queue (IndexedDB) ---------- */
function openDB() { return new Promise((res, rej) => { const r = indexedDB.open('projectzero', 1); r.onupgradeneeded = () => r.result.createObjectStore('uploads', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
const txDone = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
const qAdd = (item) => { const t = db.transaction('uploads', 'readwrite'); t.objectStore('uploads').put(item); return txDone(t); };
const qDel = (id) => { const t = db.transaction('uploads', 'readwrite'); t.objectStore('uploads').delete(id); return txDone(t); };
const qAll = () => new Promise((res) => { const out = []; const c = db.transaction('uploads').objectStore('uploads').openCursor(); c.onsuccess = (e) => { const cur = e.target.result; if (cur) { out.push(cur.value); cur.continue(); } else res(out); }; c.onerror = () => res(out); });
async function enqueue(blob, name, mime) {
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.round(performance.now());
  await qAdd({ id, name, mime, blob, createdAt: Date.now() });
  flash('Saved'); processQueue();
}
async function processQueue() {
  if (processing || !accessToken || !db) { render(); return; }
  processing = true;
  try {
    for (const it of await qAll()) {
      try { lastMsg = 'Uploading…'; render(); await uploadToDrive(it.name, it.mime, it.blob, it.createdAt); await qDel(it.id); lastMsg = 'Uploaded ✓'; }
      catch (e) { lastMsg = 'Will retry'; }
      render();
    }
  } finally { processing = false; render(); }
}

/* ---------- status rendering ---------- */
async function render() {
  if (!accessToken) { statusEl.textContent = 'Sign in'; statusEl.classList.add('signin'); statusEl.classList.remove('busy'); }
  else {
    statusEl.classList.remove('signin');
    const n = db ? (await qAll()).length : 0;
    statusEl.textContent = n > 0 ? `${n} pending` : lastMsg;
    statusEl.classList.toggle('busy', n > 0);
  }
  if (camMode) { const n = db ? (await qAll()).length : 0; setCam(n > 0 ? `${n} pending` : (lastMsg !== 'Ready' ? lastMsg : '')); }
}
function setCam(msg) { camStatus.textContent = msg; camStatus.classList.toggle('show', !!msg); }
function flash(m) { lastMsg = m; render(); clearTimeout(flashT); flashT = setTimeout(() => { if (lastMsg === m) { lastMsg = 'Ready'; render(); } }, 2200); }

/* ---------- camera ---------- */
async function startCamera() {
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true }); preview.srcObject = stream; }
  catch (e) { setCam('Allow camera + mic, then reopen'); }
}
function stopCamera() { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } preview.srcObject = null; }
function toggleVideo() {
  if (!stream) return;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') { mediaRecorder.stop(); shutter.classList.remove('recording'); }
  else {
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, VIDEO_MIME ? { mimeType: VIDEO_MIME } : undefined);
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => { const b = new Blob(recordedChunks, { type: VIDEO_MIME || 'video/mp4' }); enqueue(b, fname(videoExt), b.type); };
    mediaRecorder.start(); shutter.classList.add('recording');
  }
}
function takePhoto() {
  if (!preview.videoWidth) return;
  const c = document.createElement('canvas'); c.width = preview.videoWidth; c.height = preview.videoHeight;
  c.getContext('2d').drawImage(preview, 0, 0, c.width, c.height);
  c.toBlob((b) => { if (b) enqueue(b, fname('jpg'), 'image/jpeg'); }, 'image/jpeg', 0.92);
}

/* ---------- voice ---------- */
async function toggleVoice() {
  if (voiceRec && voiceRec.state !== 'inactive') {
    voiceRec.stop(); voiceBtn.classList.remove('recording'); voicePulse.classList.remove('on'); voiceStatus.textContent = 'Saved ✓'; return;
  }
  try { voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { voiceStatus.textContent = 'Allow mic access'; return; }
  voiceChunks = [];
  voiceRec = new MediaRecorder(voiceStream, AUDIO_MIME ? { mimeType: AUDIO_MIME } : undefined);
  voiceRec.ondataavailable = (e) => { if (e.data && e.data.size) voiceChunks.push(e.data); };
  voiceRec.onstop = () => { const b = new Blob(voiceChunks, { type: AUDIO_MIME || 'audio/mp4' }); enqueue(b, fname(audioExt), b.type); if (voiceStream) { voiceStream.getTracks().forEach((t) => t.stop()); voiceStream = null; } };
  voiceRec.start(); voiceBtn.classList.add('recording'); voicePulse.classList.add('on'); voiceStatus.textContent = 'Recording…';
}

/* ---------- goals & notes ---------- */
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { return []; } };
const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));
let goals = lsGet('goals_' + TODAY);   // [{t, done}]
let notes = lsGet('notes_' + TODAY);   // [{t, ts}]

function renderGoals() {
  goalsList.innerHTML = '';
  if (!goals.length) goalsList.innerHTML = '<li class="empty">No goals yet — set the tone for today.</li>';
  goals.forEach((g, idx) => {
    const li = document.createElement('li'); li.className = 'item' + (g.done ? ' done' : '');
    li.innerHTML = '<button class="check"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg></button><span class="item-text"></span><button class="del">×</button>';
    li.querySelector('.item-text').textContent = g.t;
    li.querySelector('.check').onclick = () => { goals[idx].done = !goals[idx].done; saveGoals(); };
    li.querySelector('.del').onclick = () => { goals.splice(idx, 1); saveGoals(); };
    goalsList.appendChild(li);
  });
  const done = goals.filter((g) => g.done).length;
  goalsProgress.textContent = `${done} / ${goals.length}`;
  goalsBar.style.width = goals.length ? (done / goals.length * 100) + '%' : '0%';
}
function saveGoals() { lsSet('goals_' + TODAY, goals); renderGoals(); scheduleJournal(); }

function renderNotes() {
  notesList.innerHTML = '';
  if (!notes.length) notesList.innerHTML = '<li class="empty">No notes yet.</li>';
  notes.forEach((n, idx) => {
    const li = document.createElement('li'); li.className = 'item';
    li.innerHTML = '<span class="item-text"></span><button class="del">×</button>';
    li.querySelector('.item-text').textContent = n.t;
    li.querySelector('.del').onclick = () => { notes.splice(idx, 1); saveNotes(); };
    notesList.appendChild(li);
  });
}
function saveNotes() { lsSet('notes_' + TODAY, notes); renderNotes(); scheduleJournal(); }

let journalTimer = null;
function scheduleJournal() { clearTimeout(journalTimer); journalTimer = setTimeout(syncJournal, 2500); }
async function syncJournal() {
  if (!accessToken) return;
  const L = ['PROJECT ZERO — ' + TODAY, '', 'GOALS'];
  goals.length ? goals.forEach((g) => L.push((g.done ? '[x] ' : '[ ] ') + g.t)) : L.push('(none)');
  L.push('', 'NOTES');
  notes.length ? notes.forEach((n) => L.push('• ' + n.t)) : L.push('(none)');
  try { const token = await ensureToken(); const folderId = await resolveDailyFolder(new Date(), token); await upsertTextFile('Journal — ' + TODAY + '.txt', L.join('\n'), folderId, token); } catch (e) {}
}

/* ---------- navigation ---------- */
function show(id) { document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active')); $(id).classList.add('active'); }

/* ---------- wiring ---------- */
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
  if (!requireAuth()) return;
  const go = b.getAttribute('data-go');
  if (go === 'voice') { show('voice'); voiceStatus.textContent = 'Tap to record a voice note'; voicePulse.classList.remove('on'); return; }
  camMode = go; show('camera'); setCam(''); startCamera(); render();
}));
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (voiceRec && voiceRec.state !== 'inactive') voiceRec.stop();
  shutter.classList.remove('recording'); voiceBtn.classList.remove('recording'); voicePulse.classList.remove('on');
  stopCamera(); camMode = null; show('home'); render();
}));
shutter.addEventListener('click', () => { camMode === 'video' ? toggleVideo() : takePhoto(); });
voiceBtn.addEventListener('click', toggleVoice);
$('pickImage').addEventListener('click', () => { if (requireAuth()) imageInput.click(); });
$('pickFile').addEventListener('click', () => { if (requireAuth()) fileInput.click(); });
$('uploadAll').addEventListener('click', () => { if (requireAuth()) { flash('Uploading…'); processQueue(); } });
imageInput.addEventListener('change', () => { [...imageInput.files].forEach((f) => enqueue(f, f.name || fname('jpg'), f.type || 'image/jpeg')); imageInput.value = ''; });
fileInput.addEventListener('change', () => { [...fileInput.files].forEach((f) => enqueue(f, f.name || fname('dat'), f.type || 'application/octet-stream')); fileInput.value = ''; });
statusEl.addEventListener('click', () => { accessToken ? processQueue() : requestToken('').catch(() => {}); });
goalForm.addEventListener('submit', (e) => { e.preventDefault(); const v = goalInput.value.trim(); if (!v) return; goals.push({ t: v, done: false }); goalInput.value = ''; saveGoals(); });
noteForm.addEventListener('submit', (e) => { e.preventDefault(); const v = noteInput.value.trim(); if (!v) return; notes.push({ t: v, ts: Date.now() }); noteInput.value = ''; saveNotes(); });

/* ---------- boot ---------- */
(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { db = await openDB(); } catch (e) {}
  renderGoals(); renderNotes(); await render();
  whenGIS(initAuth);
})();
