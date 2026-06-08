'use strict';

/* ---------- config ---------- */
const WEB_CLIENT_ID = '__WEB_CLIENT_ID__';                 // injected at deploy
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

/* ---------- elements ---------- */
const $ = (id) => document.getElementById(id);
const statusEl = $('status'), camStatus = $('camStatus');
const preview = $('preview'), shutter = $('shutter');
const voiceBtn = $('voiceBtn'), voiceIcon = $('voiceIcon'), voiceStatus = $('voiceStatus');
const signinOverlay = $('signin'), authMsg = $('authMsg');
const imageInput = $('imageInput'), fileInput = $('fileInput');

/* ---------- state ---------- */
let accessToken = null, tokenExpiry = 0, tokenClient = null, tokenResolvers = [];
let stream = null, mediaRecorder = null, recordedChunks = [];
let voiceStream = null, voiceRec = null, voiceChunks = [];
let camMode = null;            // 'video' | 'photo' | null
let lastMsg = 'Ready', processing = false, db = null;
let pzId = null; const dayCache = {};

/* ---------- mime helpers ---------- */
const pickMime = (cands) => cands.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
const VIDEO_MIME = pickMime(['video/mp4', 'video/mp4;codecs=h264', 'video/webm;codecs=vp9', 'video/webm']);
const AUDIO_MIME = pickMime(['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm']);
const videoExt = VIDEO_MIME.includes('mp4') ? 'mp4' : 'webm';
const audioExt = AUDIO_MIME.includes('mp4') ? 'm4a' : 'webm';

/* ---------- filenames ---------- */
const pad = (n) => String(n).padStart(2, '0');
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
const fname = (ext) => `ProjectZero_${stamp()}.${ext}`;
const localDay = (date) => { const o = date.getTimezoneOffset() * 60000; return new Date(date - o).toISOString().slice(0, 10); };

/* ---------- auth (Google Identity Services) ---------- */
function whenGIS(cb) {
  if (window.google && google.accounts && google.accounts.oauth2) cb();
  else setTimeout(() => whenGIS(cb), 120);
}
function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: WEB_CLIENT_ID,
    scope: SCOPE,
    callback: (resp) => {
      if (resp && resp.access_token) {
        accessToken = resp.access_token;
        tokenExpiry = Date.now() + ((resp.expires_in || 3600) * 1000) - 60000;
        tokenResolvers.forEach((r) => r.resolve(accessToken)); tokenResolvers = [];
        onSignedIn();
      } else {
        tokenResolvers.forEach((r) => r.reject(new Error('auth'))); tokenResolvers = [];
        authMsg.textContent = 'Sign in failed. Try again.';
      }
    },
    error_callback: () => { authMsg.textContent = 'Sign in cancelled.'; }
  });
}
function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    tokenResolvers.push({ resolve, reject });
    tokenClient.requestAccessToken({ prompt: prompt || '' });
  });
}
async function ensureToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;
  return requestToken('');
}
function onSignedIn() {
  signinOverlay.classList.remove('active');
  authMsg.textContent = '';
  processQueue();
}

/* ---------- Drive ---------- */
async function findOrCreateFolder(name, parentId, token) {
  const q = `mimeType='application/vnd.google-apps.folder' and name='${name}' and '${parentId}' in parents and trashed=false`;
  const fr = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`,
    { headers: { Authorization: 'Bearer ' + token } });
  if (!fr.ok) throw new Error('find ' + fr.status);
  const fd = await fr.json();
  if (fd.files && fd.files.length) return fd.files[0].id;
  const cr = await fetch('https://www.googleapis.com/drive/v3/files?fields=id',
    { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }) });
  if (!cr.ok) throw new Error('mkdir ' + cr.status);
  return (await cr.json()).id;
}
async function resolveDailyFolder(date, token) {
  const ds = localDay(date);
  if (dayCache[ds]) return dayCache[ds];
  if (!pzId) {
    const pb = await findOrCreateFolder('Personal Brand', 'root', token);
    pzId = await findOrCreateFolder('Project Zero', pb, token);
  }
  const id = await findOrCreateFolder(ds, pzId, token);
  dayCache[ds] = id;
  return id;
}
async function uploadToDrive(name, mime, blob, createdAt) {
  const token = await ensureToken();
  const folderId = await resolveDailyFolder(new Date(createdAt), token);
  const cr = await fetch('https://www.googleapis.com/drive/v3/files?fields=id',
    { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parents: [folderId] }) });
  if (!cr.ok) throw new Error('create ' + cr.status);
  const { id } = await cr.json();
  const ur = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`,
    { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': mime || 'application/octet-stream' }, body: blob });
  if (!ur.ok) throw new Error('media ' + ur.status);
  return id;
}

/* ---------- queue (IndexedDB) ---------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('projectzero', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('uploads', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const txDone = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
async function qAdd(item) { const t = db.transaction('uploads', 'readwrite'); t.objectStore('uploads').put(item); return txDone(t); }
async function qDel(id) { const t = db.transaction('uploads', 'readwrite'); t.objectStore('uploads').delete(id); return txDone(t); }
function qAll() {
  return new Promise((res) => {
    const out = []; const c = db.transaction('uploads').objectStore('uploads').openCursor();
    c.onsuccess = (e) => { const cur = e.target.result; if (cur) { out.push(cur.value); cur.continue(); } else res(out); };
    c.onerror = () => res(out);
  });
}
async function enqueue(blob, name, mime) {
  const item = { id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.round(performance.now())),
                 name, mime, blob, createdAt: Date.now() };
  await qAdd(item);
  flash('Saved');
  processQueue();
}
async function processQueue() {
  if (processing || !accessToken) { render(); return; }
  processing = true;
  try {
    const items = await qAll();
    for (const it of items) {
      try { setBusy(); await uploadToDrive(it.name, it.mime, it.blob, it.createdAt); await qDel(it.id); lastMsg = 'Uploaded ✓'; }
      catch (e) { lastMsg = 'Will retry'; }
      render();
    }
  } finally { processing = false; render(); }
}
function setBusy() { statusEl.textContent = 'Uploading…'; if (camMode) camStatus.textContent = 'Uploading…'; }
async function render() {
  const n = (await qAll()).length;
  const t = n > 0 ? `Uploading… (${n} pending)` : lastMsg;
  statusEl.textContent = t;
  if (camMode) camStatus.textContent = n > 0 ? `${n} pending` : lastMsg;
}
function flash(m) { lastMsg = m; render(); }

/* ---------- camera ---------- */
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
    preview.srcObject = stream;
  } catch (e) { camStatus.textContent = 'Allow camera + mic, then reopen'; }
}
function stopCamera() {
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  preview.srcObject = null;
}
function toggleVideo() {
  if (!stream) return;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop(); shutter.classList.remove('recording');
  } else {
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, VIDEO_MIME ? { mimeType: VIDEO_MIME } : undefined);
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => { const blob = new Blob(recordedChunks, { type: VIDEO_MIME || 'video/mp4' }); enqueue(blob, fname(videoExt), blob.type); };
    mediaRecorder.start();
    shutter.classList.add('recording');
  }
}
function takePhoto() {
  if (!preview.videoWidth) return;
  const c = document.createElement('canvas');
  c.width = preview.videoWidth; c.height = preview.videoHeight;
  c.getContext('2d').drawImage(preview, 0, 0, c.width, c.height);
  c.toBlob((b) => { if (b) enqueue(b, fname('jpg'), 'image/jpeg'); }, 'image/jpeg', 0.92);
}

/* ---------- voice ---------- */
async function toggleVoice() {
  if (voiceRec && voiceRec.state !== 'inactive') {
    voiceRec.stop(); voiceBtn.classList.remove('recording');
    voiceIcon.textContent = '🎙️'; voiceStatus.textContent = 'Saved';
    return;
  }
  try { voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { voiceStatus.textContent = 'Allow mic access'; return; }
  voiceChunks = [];
  voiceRec = new MediaRecorder(voiceStream, AUDIO_MIME ? { mimeType: AUDIO_MIME } : undefined);
  voiceRec.ondataavailable = (e) => { if (e.data && e.data.size) voiceChunks.push(e.data); };
  voiceRec.onstop = () => {
    const blob = new Blob(voiceChunks, { type: AUDIO_MIME || 'audio/mp4' });
    enqueue(blob, fname(audioExt), blob.type);
    if (voiceStream) { voiceStream.getTracks().forEach((t) => t.stop()); voiceStream = null; }
  };
  voiceRec.start();
  voiceBtn.classList.add('recording'); voiceIcon.textContent = '🔴'; voiceStatus.textContent = 'Recording…';
}

/* ---------- navigation ---------- */
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
}
function requireAuth() {
  if (!accessToken) { signinOverlay.classList.add('active'); return false; }
  return true;
}

/* ---------- wiring ---------- */
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
  if (!requireAuth()) return;
  const go = b.getAttribute('data-go');
  if (go === 'voice') { show('voice'); voiceStatus.textContent = 'Tap to record a voice note'; voiceIcon.textContent = '🎙️'; return; }
  camMode = go; show('camera'); camStatus.textContent = ''; startCamera();
}));
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (voiceRec && voiceRec.state !== 'inactive') voiceRec.stop();
  stopCamera(); camMode = null; show('home'); render();
}));
shutter.addEventListener('click', () => { camMode === 'video' ? toggleVideo() : takePhoto(); });
voiceBtn.addEventListener('click', toggleVoice);
$('pickImage').addEventListener('click', () => { if (requireAuth()) imageInput.click(); });
$('pickFile').addEventListener('click', () => { if (requireAuth()) fileInput.click(); });
$('uploadAll').addEventListener('click', () => { if (requireAuth()) { flash('Uploading…'); processQueue(); } });
imageInput.addEventListener('change', () => { [...imageInput.files].forEach((f) => enqueue(f, f.name || fname('jpg'), f.type || 'image/jpeg')); imageInput.value = ''; });
fileInput.addEventListener('change', () => { [...fileInput.files].forEach((f) => enqueue(f, f.name || fname('dat'), f.type || 'application/octet-stream')); fileInput.value = ''; });
$('signinBtn').addEventListener('click', () => { authMsg.textContent = ''; requestToken('').catch(() => {}); });

/* ---------- boot ---------- */
(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { db = await openDB(); } catch (e) {}
  await render();
  signinOverlay.classList.add('active');     // require sign-in to start
  whenGIS(initAuth);
})();
