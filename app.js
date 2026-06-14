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
let facing = 'user', camFlipping = false;
let curRid = null, curRecName = '', curRecMime = '';
let voiceStream = null, voiceRec = null, voiceChunks = [];
let camMode = null, lastMsg = 'Ready', processing = false, db = null, flashT = null;
let retryTimer = null, retryBackoff = 0;
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
    error_callback: (err) => { tokenResolvers.forEach((r) => r.reject(err || new Error('auth'))); tokenResolvers = []; }
  });
}
// never let a token request hang: it settles on callback, error_callback, or a 15s timeout
function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    let done = false;
    const entry = {
      resolve: (v) => { if (done) return; done = true; clearTimeout(to); resolve(v); },
      reject: (e) => { if (done) return; done = true; clearTimeout(to); reject(e); }
    };
    const to = setTimeout(() => entry.reject(new Error('token-timeout')), 15000);
    tokenResolvers.push(entry);
    try { tokenClient.requestAccessToken({ prompt: prompt || '' }); } catch (e) { entry.reject(e); }
  });
}
async function ensureToken() { return (accessToken && Date.now() < tokenExpiry) ? accessToken : requestToken(''); }
function onSignedIn() { render(); processQueue(); syncJournal(); loadPeopleFromDrive(); }
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
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('projectzero', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('uploads')) d.createObjectStore('uploads', { keyPath: 'id' });
      // crash-safe recording: video chunks streamed here during capture
      if (!d.objectStoreNames.contains('recparts')) { const s = d.createObjectStore('recparts', { keyPath: 'seq', autoIncrement: true }); s.createIndex('rid', 'rid', { unique: false }); }
      if (!d.objectStoreNames.contains('recmeta')) d.createObjectStore('recmeta', { keyPath: 'rid' });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const txDone = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
const qAdd = (item) => { const t = db.transaction('uploads', 'readwrite'); t.objectStore('uploads').put(item); return txDone(t); };
const qDel = (id) => { const t = db.transaction('uploads', 'readwrite'); t.objectStore('uploads').delete(id); return txDone(t); };
const qAll = () => new Promise((res) => { const out = []; const c = db.transaction('uploads').objectStore('uploads').openCursor(); c.onsuccess = (e) => { const cur = e.target.result; if (cur) { out.push(cur.value); cur.continue(); } else res(out); }; c.onerror = () => res(out); });

/* recording-part persistence (survives a crash / reload mid-record) */
const recMetaPut = (m) => { const t = db.transaction('recmeta', 'readwrite'); t.objectStore('recmeta').put(m); return txDone(t); };
const recMetaDel = (rid) => { const t = db.transaction('recmeta', 'readwrite'); t.objectStore('recmeta').delete(rid); return txDone(t); };
const recMetaAll = () => new Promise((res) => { const out = []; const c = db.transaction('recmeta').objectStore('recmeta').openCursor(); c.onsuccess = (e) => { const cur = e.target.result; if (cur) { out.push(cur.value); cur.continue(); } else res(out); }; c.onerror = () => res(out); });
const recPartAdd = (rid, blob) => { const t = db.transaction('recparts', 'readwrite'); t.objectStore('recparts').add({ rid, blob }); return txDone(t); };
const recPartsFor = (rid) => new Promise((res) => { const out = []; const c = db.transaction('recparts').objectStore('recparts').index('rid').openCursor(IDBKeyRange.only(rid)); c.onsuccess = (e) => { const cur = e.target.result; if (cur) { out.push(cur.value.blob); cur.continue(); } else res(out); }; c.onerror = () => res(out); });
const recPartsDel = (rid) => new Promise((res) => { const s = db.transaction('recparts', 'readwrite').objectStore('recparts'); const c = s.index('rid').openCursor(IDBKeyRange.only(rid)); c.onsuccess = (e) => { const cur = e.target.result; if (cur) { s.delete(cur.primaryKey); cur.continue(); } else res(); }; c.onerror = () => res(); });
// assemble persisted chunks for a recording into one blob, queue it for upload, then clear the parts
async function finalizeRecording(rid, name, mime) {
  if (!db) return;
  try { const parts = await recPartsFor(rid); if (parts.length) { const b = new Blob(parts, { type: mime }); if (b.size) await enqueue(b, name, mime); } } catch (e) {}
  try { await recPartsDel(rid); await recMetaDel(rid); } catch (e) {}
}
// on launch: recover any recording that was interrupted by a crash/reload
async function recoverRecordings() {
  if (!db) return;
  try {
    const metas = await recMetaAll();
    for (const m of metas) await finalizeRecording(m.rid, m.name, m.mime);
    if (metas.length) flash('Recovered ' + metas.length + ' clip' + (metas.length > 1 ? 's' : ''));
  } catch (e) {}
}
async function enqueue(blob, name, mime) {
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.round(performance.now());
  await qAdd({ id, name, mime, blob, createdAt: Date.now() });
  bumpCaptures(); updateMomentum();
  flash('Saved'); processQueue();
}
// exponential backoff: 5s, 10s, 20s, 40s, capped at 60s. reset to 0 on any success.
function scheduleRetry() {
  if (!accessToken) return;
  clearTimeout(retryTimer);
  retryBackoff = retryBackoff ? Math.min(retryBackoff * 2, 60000) : 5000;
  retryTimer = setTimeout(processQueue, retryBackoff);
}
async function processQueue() {
  if (processing || !accessToken || !db) { render(); return; }
  processing = true;
  let authFailed = false;
  try {
    const items = await qAll();
    let i = 0;
    for (const it of items) {
      i++;
      try {
        lastMsg = `Uploading ${i}/${items.length}…`; render();
        await uploadToDrive(it.name, it.mime, it.blob, it.createdAt);
        await qDel(it.id);
        retryBackoff = 0; lastMsg = 'Uploaded ✓';
      } catch (e) {
        // a real auth failure means the token is dead -> stop and ask the user to sign in
        if (/token|auth|\b401\b/i.test((e && e.message) || '')) { authFailed = true; break; }
        lastMsg = 'Will retry';   // network/transient -> backoff and retry
      }
      render();
    }
  } finally {
    processing = false;
    if (authFailed) { accessToken = null; tokenExpiry = 0; }
    const remaining = db ? (await qAll()).length : 0;
    if (remaining === 0) { clearTimeout(retryTimer); retryBackoff = 0; }
    render();
    if (remaining > 0 && accessToken) scheduleRetry();
  }
}

/* ---------- status rendering ---------- */
async function render() {
  if (!accessToken) { statusEl.textContent = 'Sign in'; statusEl.classList.add('signin'); statusEl.classList.remove('busy', 'spin'); }
  else {
    statusEl.classList.remove('signin');
    const n = db ? (await qAll()).length : 0;
    statusEl.textContent = processing ? lastMsg : (n > 0 ? `${n} pending` : lastMsg);
    statusEl.classList.toggle('busy', n > 0 || processing);
    statusEl.classList.toggle('spin', processing);
  }
  if (camMode) { const n = db ? (await qAll()).length : 0; setCam(n > 0 ? `${n} pending` : (lastMsg !== 'Ready' ? lastMsg : '')); }
}
function setCam(msg) { camStatus.textContent = msg; camStatus.classList.toggle('show', !!msg); }
function flash(m) { lastMsg = m; render(); clearTimeout(flashT); flashT = setTimeout(() => { if (lastMsg === m) { lastMsg = 'Ready'; render(); } }, 2200); }

/* ---------- camera ---------- */
function stopCameraStream() { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } }
async function startCamera() {
  stopCameraStream();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: true });
    preview.srcObject = stream;
    preview.classList.toggle('mirror', facing === 'user');
  } catch (e) { setCam('Allow camera + mic, then reopen'); }
}
function stopCamera() { stopCameraStream(); preview.srcObject = null; }
function isRecording() { return !!(mediaRecorder && mediaRecorder.state === 'recording'); }
function startVideoRecording() {
  if (!stream) return;
  curRid = uid(); curRecName = fname(videoExt); curRecMime = VIDEO_MIME || 'video/mp4';
  recordedChunks = [];
  if (db) recMetaPut({ rid: curRid, name: curRecName, mime: curRecMime, createdAt: Date.now() }).catch(() => {});
  mediaRecorder = new MediaRecorder(stream, VIDEO_MIME ? { mimeType: VIDEO_MIME } : undefined);
  const rid = curRid, name = curRecName, mime = curRecMime;   // bind this recording so a flip's new one can't clobber it
  mediaRecorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    if (db) recPartAdd(rid, e.data).catch(() => {}); else recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    if (db) finalizeRecording(rid, name, mime);
    else { const b = new Blob(recordedChunks, { type: mime }); if (b.size) enqueue(b, name, mime); }
  };
  mediaRecorder.start(3000);   // emit a chunk every 3s -> persisted to disk, low memory, crash-safe
  shutter.classList.add('recording');
}
function stopVideoRecording() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') { resolve(); return; }
    const prev = mediaRecorder.onstop;
    mediaRecorder.onstop = (ev) => { if (prev) prev(ev); resolve(); };
    mediaRecorder.stop(); shutter.classList.remove('recording');
  });
}
function toggleVideo() { isRecording() ? stopVideoRecording() : startVideoRecording(); }
async function flipCamera() {
  if (camFlipping) return; camFlipping = true;
  const wasRecording = isRecording();
  try {
    if (wasRecording) await stopVideoRecording();   // finalize the current clip first (no footage lost)
    facing = (facing === 'user') ? 'environment' : 'user';
    await startCamera();
    if (wasRecording && stream) { startVideoRecording(); setCam('Flipped — recording'); }
  } finally { camFlipping = false; }
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
const objGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
let goals = lsGet('goals_' + TODAY);   // [{t, done}]
let notes = lsGet('notes_' + TODAY);   // [{t, ts}]
let big = objGet('big_' + TODAY);      // {t, done} | null
let people = objGet('people') || [];   // [{id, name, tag, note, last, next, ts}]

function renderGoals() {
  goalsList.innerHTML = '';
  if (!goals.length) goalsList.innerHTML = '<li class="empty">No goals yet. Set the tone for today.</li>';
  goals.forEach((g, idx) => {
    const li = document.createElement('li'); li.className = 'item' + (g.done ? ' done' : '');
    li.innerHTML = '<button class="check"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg></button><span class="item-text"></span><button class="del">×</button>';
    li.querySelector('.item-text').textContent = g.t;
    li.querySelector('.check').onclick = () => { const nd = !goals[idx].done; goals[idx].done = nd; saveGoals(); if (nd) reward(34); };
    li.querySelector('.del').onclick = () => { goals.splice(idx, 1); saveGoals(); };
    goalsList.appendChild(li);
  });
  const done = goals.filter((g) => g.done).length;
  goalsProgress.textContent = `${done} / ${goals.length}`;
  goalsBar.style.width = goals.length ? (done / goals.length * 100) + '%' : '0%';
}
function saveGoals() { lsSet('goals_' + TODAY, goals); renderGoals(); scheduleJournal(); updateMomentum(); }

function renderNotes() {
  notesList.innerHTML = '';
  if (!notes.length) notesList.innerHTML = '<li class="empty">No notes yet.</li>';
  notes.forEach((n, idx) => {
    const li = document.createElement('li'); li.className = 'item';
    li.innerHTML = '<span class="item-text"></span><span class="note-time"></span><button class="del">×</button>';
    li.querySelector('.item-text').textContent = n.t;
    if (n.ts) li.querySelector('.note-time').textContent = new Date(n.ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    li.querySelector('.del').onclick = () => { notes.splice(idx, 1); saveNotes(); };
    notesList.appendChild(li);
  });
}
function saveNotes() { lsSet('notes_' + TODAY, notes); renderNotes(); scheduleJournal(); updateMomentum(); }

let journalTimer = null;
function scheduleJournal() { clearTimeout(journalTimer); journalTimer = setTimeout(syncJournal, 2500); }
async function syncJournal() {
  if (!accessToken) return;
  const L = ['PROJECT ZERO - ' + TODAY, ''];
  if (big && big.t) { L.push('THE ONE THING', (big.done ? '[x] ' : '[ ] ') + big.t, ''); }
  L.push('GOALS');
  goals.length ? goals.forEach((g) => L.push((g.done ? '[x] ' : '[ ] ') + g.t)) : L.push('(none)');
  L.push('', 'NOTES');
  notes.length ? notes.forEach((n) => L.push('• ' + n.t)) : L.push('(none)');
  const fm = focusToday();
  if (fm) L.push('', 'FOCUS', fm + ' minutes');
  L.push('', 'HABITS');
  HABITS.forEach((h) => L.push((habitsDone.includes(h) ? '[x] ' : '[ ] ') + h));
  const kh = khActive();
  if (kh) L.push('', 'KEYSTONE HABIT', (kh.log[TODAY] && kh.log[TODAY].hit ? '[x] ' : '[ ] ') + kh.anchor + ' -> ' + kh.name + ' (streak ' + khStreak(kh) + ')');
  if (reflect && (reflect.ans || reflect.note || reflect.mood)) {
    L.push('', 'REFLECTION', 'Did what goals required: ' + (reflect.ans || '-'));
    if (reflect.mood) L.push('Mental state: ' + reflect.mood + '/10');
    if (reflect.note) L.push('Journal: ' + reflect.note);
  }
  try { const token = await ensureToken(); const folderId = await resolveDailyFolder(new Date(), token); await upsertTextFile('Journal - ' + TODAY + '.txt', L.join('\n'), folderId, token); } catch (e) {}
}

/* ---------- reward ---------- */
function reward(n) {
  if (navigator.vibrate) { try { navigator.vibrate(28); } catch (e) {} }
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = $('confetti'); if (!c) return;
  const cols = ['#e0c282', '#c8a45c', '#f1eee7', '#b88a3e', '#d8b876', '#9c7430'];
  let h = '';
  for (let i = 0; i < (n || 40); i++) {
    const left = Math.random() * 100, dur = 0.65 + Math.random() * 0.5, del = Math.random() * 0.25;
    const sx = (Math.random() * 2 - 1) * 50;
    h += `<span style="left:${left}vw;background:${cols[i % cols.length]};animation-duration:${dur}s;animation-delay:${del}s;margin-left:${sx}px"></span>`;
  }
  c.innerHTML = h;
  clearTimeout(reward._t); reward._t = setTimeout(() => { c.innerHTML = ''; }, 1700);
}

/* ---------- the one thing ---------- */
function renderBig() {
  const view = $('btView'), form = $('btForm');
  if (big && big.t) {
    view.hidden = false; form.hidden = true;
    $('btText').textContent = big.t;
    view.classList.toggle('done', !!big.done);
  } else { view.hidden = true; form.hidden = false; }
}
function saveBig() { localStorage.setItem('big_' + TODAY, JSON.stringify(big)); renderBig(); scheduleJournal(); updateMomentum(); }

/* ---------- focus timer ---------- */
const RING_LEN = 628.3; // 2*pi*100
let fMin = 25, fLabel = '', fLeft = 0, fTotal = 0, fId = null, fPaused = false, fActive = false;
const fmtT = (s) => { s = Math.max(0, s); return Math.floor(s / 60) + ':' + pad(s % 60); };
function focusKey(ds) { return 'focus_' + ds; }
function focusSessions(ds) { return objGet(focusKey(ds)) || []; }
function logFocus(min, label) { if (min < 1) return; const a = focusSessions(TODAY); a.push({ min, label: label || '', ts: Date.now() }); localStorage.setItem(focusKey(TODAY), JSON.stringify(a)); }
function focusToday() { return focusSessions(TODAY).reduce((s, f) => s + f.min, 0); }
function focusTotalAll() { let n = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.indexOf('focus_') === 0) (objGet(k) || []).forEach((f) => n += f.min); } return n; }
function renderFocusToday() { const m = focusToday(); $('focusToday').textContent = m + ' min today'; }
function setFocusToggle(paused) {
  fPaused = paused;
  const b = $('focusToggle');
  b.querySelector('span').textContent = paused ? 'Resume' : 'Pause';
  b.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
  document.querySelector('.focus-ring').classList.toggle('paused', paused);
}
function updateRing() {
  $('focusTime').textContent = fmtT(fLeft);
  const frac = fTotal ? 1 - fLeft / fTotal : 0;
  $('ringFg').style.strokeDashoffset = (RING_LEN * frac).toFixed(1);
}
function startFocus(min, label) {
  fMin = min; fLabel = label || ''; fTotal = min * 60; fLeft = min * 60; fActive = true;
  $('focusTask').textContent = label ? label : (min + '-minute focus block');
  $('focusState').textContent = "Stay with it. One block, that's all.";
  document.querySelector('.focus-ring').classList.add('run');
  setFocusToggle(false);
  updateRing();
  show('focus');
  clearInterval(fId);
  fId = setInterval(() => { if (fPaused) return; fLeft--; updateRing(); if (fLeft <= 0) finishFocus(); }, 1000);
}
function finishFocus() {
  clearInterval(fId); fId = null; fLeft = 0; updateRing();
  if (fActive) { logFocus(fMin, fLabel); fActive = false; }
  reward(80);
  $('focusTime').textContent = '✓';
  $('focusState').textContent = `${fMin} minutes locked in. That's how it's built.`;
  $('focusToggle').querySelector('span').textContent = 'Done';
  $('focusToggle').querySelector('use').setAttribute('href', '#i-check');
  renderFocusToday(); updateMomentum();
}
function stopFocus(commit) {
  clearInterval(fId); fId = null;
  if (commit && fActive) { const el = Math.floor((fTotal - fLeft) / 60); if (el >= 1) logFocus(el, fLabel); }
  fActive = false;
  const r = document.querySelector('.focus-ring'); if (r) r.classList.remove('run', 'paused');
  renderFocusToday(); updateMomentum();
}

/* ---------- people CRM ---------- */
const TAGS = ['artist', 'client', 'collab', 'mentor', 'friend', 'fan'];
const AV = ['#ff6a45,#ff2e63', '#9b6bff,#6a5bff', '#2fd3a7,#1fa6c9', '#4f9bff,#5b6bff', '#ffb23d,#ff7a2f', '#ff4f87,#ff2e63'];
let editId = null, peopleTimer = null;
function avColor(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return AV[h % AV.length]; }
function initials(name) { const p = name.trim().split(/\s+/); return (((p[0] || '')[0] || '') + ((p[1] || '')[0] || '')).toUpperCase() || '?'; }
function isDue(p) { return p.next && p.next <= TODAY; }
function fuLabel(ds) { const diff = Math.round((new Date(ds + 'T00:00:00') - new Date(TODAY + 'T00:00:00')) / 86400000); if (diff === 0) return 'today'; if (diff === 1) return 'tomorrow'; if (diff === -1) return 'yesterday'; return diff > 0 ? `in ${diff}d` : `${-diff}d ago`; }
function savePeople() { localStorage.setItem('people', JSON.stringify(people)); renderPeople(); updatePeopleDot(); schedulePeopleSync(); }
function updatePeopleDot() { const d = $('peopleDot'); if (d) d.hidden = !people.some(isDue); }
function renderPeople() {
  const fu = $('followUps'), list = $('peopleList');
  const due = people.filter(isDue).sort((a, b) => a.next.localeCompare(b.next));
  if (due.length) {
    fu.hidden = false;
    fu.innerHTML = '<div class="fu-head"><svg viewBox="0 0 24 24"><use href="#i-bell"/></svg>Follow up</div>' +
      due.map((p) => `<div class="fu-item"><b>${esc(p.name)}</b><span class="fu-when">${fuLabel(p.next)}</span></div>`).join('');
  } else fu.hidden = true;
  if (!people.length) { list.innerHTML = '<p class="empty">No people yet. Tap the pencil to add someone in your corner.</p>'; return; }
  const sorted = people.slice().sort((a, b) => (isDue(b) - isDue(a)) || a.name.localeCompare(b.name));
  list.innerHTML = sorted.map((p) => {
    const cc = avColor(p.name).split(',');
    const sub = p.note ? esc(p.note) : (p.last ? 'Last talked ' + fuLabel(p.last) : 'No notes yet');
    return `<div class="person${isDue(p) ? ' due' : ''}" data-id="${p.id}">
      <span class="avatar" style="background:linear-gradient(135deg,${cc[0]},${cc[1]})">${esc(initials(p.name))}</span>
      <div class="person-main"><div class="person-name">${esc(p.name)}</div><div class="person-sub">${sub}</div></div>
      <span class="person-tag">${esc(p.tag || '')}</span></div>`;
  }).join('');
  list.querySelectorAll('.person').forEach((el) => { el.onclick = () => openPerson(el.dataset.id); });
}
function renderTagRow(sel) {
  $('pTags').innerHTML = TAGS.map((t) => `<button type="button" class="tag-opt${t === sel ? ' sel' : ''}" data-tag="${t}">${t}</button>`).join('');
  $('pTags').querySelectorAll('.tag-opt').forEach((b) => { b.onclick = () => { $('pTags').querySelectorAll('.tag-opt').forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); }; });
}
function selectedTag() { const s = $('pTags').querySelector('.tag-opt.sel'); return s ? s.dataset.tag : 'artist'; }
function openPerson(id) {
  editId = id || null;
  const p = id ? people.find((x) => x.id === id) : null;
  $('personTitle').textContent = p ? 'Edit person' : 'New person';
  $('pName').value = p ? p.name : '';
  $('pNote').value = p ? (p.note || '') : '';
  $('pLast').value = p ? (p.last || '') : '';
  $('pNext').value = p ? (p.next || '') : '';
  renderTagRow(p ? p.tag : 'artist');
  $('personDelete').hidden = !p;
  show('personEdit');
  if (!p) setTimeout(() => $('pName').focus(), 60);
}
async function openPeople() {
  show('people'); renderPeople();
  if (accessToken && !people.length) { await loadPeopleFromDrive(); }
}
function schedulePeopleSync() { clearTimeout(peopleTimer); peopleTimer = setTimeout(syncPeople, 1500); }
async function ensurePZ(token) { if (!pzId) { const pb = await findOrCreateFolder('Personal Brand', 'root', token); pzId = await findOrCreateFolder('Project Zero', pb, token); } return pzId; }
async function syncPeople() {
  if (!accessToken) return;
  try { const token = await ensureToken(); await ensurePZ(token); await upsertTextFile('People.json', JSON.stringify(people, null, 2), pzId, token); } catch (e) {}
}
async function loadPeopleFromDrive() {
  if (!accessToken || people.length) return;
  try {
    const token = await ensureToken(); await ensurePZ(token);
    const q = `name='People.json' and '${pzId}' in parents and trashed=false`;
    const fr = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, { headers: { Authorization: 'Bearer ' + token } });
    const f = ((await fr.json()).files || [])[0];
    if (!f) return;
    const cr = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, { headers: { Authorization: 'Bearer ' + token } });
    const arr = JSON.parse(await cr.text());
    if (Array.isArray(arr) && arr.length) { people = arr; localStorage.setItem('people', JSON.stringify(people)); renderPeople(); updatePeopleDot(); }
  } catch (e) {}
}

/* ---------- momentum ---------- */
const capKey = (ds) => 'cap_' + ds;
const captureCount = (ds) => +(localStorage.getItem(capKey(ds)) || 0);
function bumpCaptures() { localStorage.setItem(capKey(TODAY), captureCount(TODAY) + 1); }
const shift = (ds, days) => { const d = new Date(ds + 'T00:00:00'); d.setDate(d.getDate() + days); return localDay(d); };
function activeOn(ds) {
  const b = objGet('big_' + ds);
  return lsGet('goals_' + ds).length > 0 || lsGet('notes_' + ds).length > 0 || captureCount(ds) > 0
    || (objGet('focus_' + ds) || []).length > 0 || !!(b && b.t) || lsGet('habits_' + ds).length > 0 || khHitOn(ds);
}
function currentStreak() {
  let ds = TODAY; if (!activeOn(ds)) ds = shift(ds, -1);
  let s = 0; while (activeOn(ds)) { s++; ds = shift(ds, -1); } return s;
}
function allActiveDates() {
  const set = new Set();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i); let m;
    if ((m = k.match(/^goals_(\d{4}-\d{2}-\d{2})$/)) && lsGet(k).length) set.add(m[1]);
    else if ((m = k.match(/^notes_(\d{4}-\d{2}-\d{2})$/)) && lsGet(k).length) set.add(m[1]);
    else if ((m = k.match(/^cap_(\d{4}-\d{2}-\d{2})$/)) && +localStorage.getItem(k) > 0) set.add(m[1]);
    else if ((m = k.match(/^focus_(\d{4}-\d{2}-\d{2})$/)) && (objGet(k) || []).length) set.add(m[1]);
    else if ((m = k.match(/^habits_(\d{4}-\d{2}-\d{2})$/)) && lsGet(k).length) set.add(m[1]);
    else if ((m = k.match(/^big_(\d{4}-\d{2}-\d{2})$/)) && objGet(k) && objGet(k).t) set.add(m[1]);
  }
  khAllHitDates().forEach((ds) => set.add(ds));
  return set;
}
function longestStreak() {
  const dates = [...allActiveDates()].sort();
  let best = 0, run = 0, prev = null;
  for (const ds of dates) { run = (prev && shift(prev, 1) === ds) ? run + 1 : 1; best = Math.max(best, run); prev = ds; }
  return best;
}
function goalTotals() {
  let set = 0, done = 0;
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('goals_')) { const a = lsGet(k); set += a.length; done += a.filter((g) => g.done).length; } }
  return { set, done };
}
function capturesTotal() { let n = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('cap_')) n += +localStorage.getItem(k) || 0; } return n; }
function weekStats() { let set = 0, done = 0; for (let i = 0; i < 7; i++) { const a = lsGet('goals_' + shift(TODAY, -i)); set += a.length; done += a.filter((g) => g.done).length; } return { set, done }; }
function coachPrompt() {
  const open = goals.filter((g) => !g.done).length, s = currentStreak(), fm = focusToday();
  const trunc = (t) => t.length > 38 ? t.slice(0, 38) + '…' : t;
  if (!activeOn(TODAY)) return s > 0 ? `Don't break your ${s}-day streak. Name the one thing that matters today.` : `Start your streak. What's the one thing today?`;
  if (big && big.t && !big.done) return `Your one thing: "${trunc(big.t)}". Start a focus block.`;
  if (fm >= 50) return `${fm} minutes of deep focus today. That's a real day.`;
  if (goals.length && open === 0) return `All goals done. Capture a clip or call it a win.`;
  if (open > 0) return `${open} goal${open > 1 ? 's' : ''} open. Time-box the biggest one.`;
  if (fm > 0) return `${fm} min focused. Stack one more block.`;
  return `You showed up. Lock in one focus block.`;
}
function updateMomentum() { $('streakNum').textContent = currentStreak(); $('coachText').textContent = coachPrompt(); }
function openMomentum() {
  show('momentum');
  const s = currentStreak(), best = longestStreak(), gt = goalTotals(), wk = weekStats();
  $('moStreak').textContent = s;
  $('moBest').textContent = `best ${best} day${best === 1 ? '' : 's'}`;
  $('moCoach').textContent = coachPrompt();
  $('moWeek').textContent = `${wk.done} / ${wk.set}`;
  $('moWeekBar').style.width = wk.set ? (wk.done / wk.set * 100) + '%' : '0%';
  $('moWeekText').textContent = wk.set ? `${wk.done} of ${wk.set} goals done this week` : 'No goals set this week yet.';
  $('stDays').textContent = allActiveDates().size;
  $('stFocus').textContent = focusTotalAll();
  $('stGoals').textContent = gt.done;
  $('stClips').textContent = capturesTotal();
  let cells = '';
  for (let i = 34; i >= 0; i--) { const ds = shift(TODAY, -i); cells += `<span class="cell${activeOn(ds) ? ' on' : ''}${ds === TODAY ? ' today' : ''}"></span>`; }
  $('moGrid').innerHTML = cells;
}

/* ---------- history ---------- */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function dateFmt(ds) { const d = new Date(ds + 'T00:00:00'); return isNaN(d) ? ds : d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }
function localHistoryDays() {
  const map = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const mg = k && k.match(/^goals_(\d{4}-\d{2}-\d{2})$/);
    const mn = k && k.match(/^notes_(\d{4}-\d{2}-\d{2})$/);
    const mb = k && k.match(/^big_(\d{4}-\d{2}-\d{2})$/);
    const mf = k && k.match(/^focus_(\d{4}-\d{2}-\d{2})$/);
    if (mg) (map[mg[1]] = map[mg[1]] || {}).goals = lsGet(k);
    if (mn) (map[mn[1]] = map[mn[1]] || {}).notes = lsGet(k);
    if (mb) (map[mb[1]] = map[mb[1]] || {}).big = objGet(k);
    if (mf) (map[mf[1]] = map[mf[1]] || {}).focus = (objGet(k) || []).reduce((s, f) => s + f.min, 0);
  }
  return Object.keys(map).map((date) => ({ date, big: map[date].big || null, goals: map[date].goals || [], notes: map[date].notes || [], focus: map[date].focus || 0 }));
}
function parseJournal(txt) {
  const goals = [], notes = []; let sec = '', big = null, focus = 0;
  txt.split('\n').forEach((line) => {
    const l = line.trim();
    if (l === 'THE ONE THING') { sec = 'b'; return; }
    if (l === 'GOALS') { sec = 'g'; return; }
    if (l === 'NOTES') { sec = 'n'; return; }
    if (l === 'FOCUS') { sec = 'f'; return; }
    if (l === 'HABITS') { sec = 'h'; return; }
    if (l === 'REFLECTION') { sec = 'r'; return; }
    if (sec === 'h' || sec === 'r') return;
    if (!l || l === '(none)' || l.startsWith('PROJECT ZERO')) return;
    if (sec === 'b') big = { t: l.replace(/^\[[ x]\]\s*/, ''), done: l.startsWith('[x]') };
    else if (sec === 'g') goals.push({ t: l.replace(/^\[[ x]\]\s*/, ''), done: l.startsWith('[x]') });
    else if (sec === 'n') notes.push({ t: l.replace(/^•\s*/, '') });
    else if (sec === 'f') { const m = l.match(/(\d+)/); if (m) focus = +m[1]; }
  });
  return { big, goals, notes, focus };
}
async function loadDriveHistory() {
  const token = await ensureToken();
  if (!pzId) { const pb = await findOrCreateFolder('Personal Brand', 'root', token); pzId = await findOrCreateFolder('Project Zero', pb, token); }
  const q = `'${pzId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const fr = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&orderBy=name desc&pageSize=120`, { headers: { Authorization: 'Bearer ' + token } });
  const folders = ((await fr.json()).files || []).filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.name));
  const out = [];
  for (const f of folders) {
    const jq = `name contains 'Journal' and '${f.id}' in parents and trashed=false`;
    const jr = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(jq)}&fields=files(id)`, { headers: { Authorization: 'Bearer ' + token } });
    const jf = ((await jr.json()).files || [])[0];
    let big = null, goals = [], notes = [], focus = 0;
    if (jf) { try { const cr = await fetch(`https://www.googleapis.com/drive/v3/files/${jf.id}?alt=media`, { headers: { Authorization: 'Bearer ' + token } }); ({ big, goals, notes, focus } = parseJournal(await cr.text())); } catch (e) {} }
    out.push({ date: f.name, big, goals, notes, focus });
  }
  return out;
}
function paintHistory(days, hint) {
  $('historyHint').textContent = hint || '';
  days = days.slice().sort((a, b) => b.date.localeCompare(a.date));
  const el = $('historyList');
  if (!days.length) { el.innerHTML = '<p class="empty">No days yet. Set some goals today.</p>'; return; }
  el.innerHTML = days.map((d) => {
    const bg = d.big && d.big.t ? `<div class="day-sub">The one thing</div><div class="h-item${d.big.done ? ' done' : ''}"><span class="h-mark ${d.big.done ? 'ok' : 'todo'}">${d.big.done ? '✓' : '○'}</span><span>${esc(d.big.t)}</span></div>` : '';
    const g = d.goals.length ? d.goals.map((x) => `<div class="h-item${x.done ? ' done' : ''}"><span class="h-mark ${x.done ? 'ok' : 'todo'}">${x.done ? '✓' : '○'}</span><span>${esc(x.t)}</span></div>`).join('') : '<div class="day-empty">No goals</div>';
    const n = d.notes.length ? d.notes.map((x) => `<div class="h-item"><span class="h-mark note">•</span><span>${esc(x.t)}</span></div>`).join('') : '<div class="day-empty">No notes</div>';
    const f = d.focus ? `<div class="day-focus"><svg viewBox="0 0 24 24"><use href="#i-timer"/></svg>${d.focus} min focused</div>` : '';
    return `<div class="day-card"><div class="day-date">${dateFmt(d.date)}</div>${bg}<div class="day-sub">Goals</div>${g}<div class="day-sub">Notes</div>${n}${f}</div>`;
  }).join('');
}
async function openHistory() {
  show('history');
  const local = localHistoryDays();
  const today = { date: TODAY, big: objGet('big_' + TODAY), goals, notes, focus: focusToday() };
  const merged = local.filter((d) => d.date !== TODAY).concat([today]);
  paintHistory(merged, accessToken ? 'Syncing from Drive…' : 'On this device');
  if (!accessToken) return;
  try {
    const drive = await loadDriveHistory();
    const byDate = {}; merged.forEach((d) => { byDate[d.date] = d; });
    drive.forEach((d) => { if (d.date !== TODAY) byDate[d.date] = d; });
    paintHistory(Object.values(byDate), 'Synced from Drive');
  } catch (e) {}
}

/* ---------- framework: principles, habits, act-now, reflection ---------- */
const PRINCIPLES = [
  ['Действия стоят больше слов.', 'Псевдо-friends taught you this. Watch what people do, not what they say.'],
  ['Growth happens in isolation.', 'You wrote it three times. Less crowd, more work.'],
  ['You are half the average of the 4 people you talk to most.', 'Choose them on purpose.'],
  ['Cold analysis is the secret to understanding people.', 'Emotion and excitement cloud it. Think with your head, not your heart.'],
  ["Attract, don't chase.", 'Law of detachment. Focus on inputs, let the rest come.'],
  ['Action or no action are the only two real variables.', 'Failure and success are just flavors of action. The only question: did you act?'],
  ['The less you speak, the more powerful you look.', 'Stay quiet about your progress. Let results speak. Unreachable = powerful.'],
  ['Obstacles are for you, not against you.', 'Every wall is reps.'],
  ['You are the chosen one.', 'Act like your dream version would, right now.'],
  ["Don't make empty promises.", 'Always deliver on your words. This is your whole reputation.'],
  ['Be consistent.', 'Train your willpower and resistance. Boring beats intense.'],
  ['Wide circle of acquaintances, small circle of friends.', "Don't try to befriend everyone."],
  ['At this stage, girls are a distraction.', "The right one comes when it's time. If one doesn't value you, thousands would."],
  ['Be grateful to your grandmother.', 'She funds this. None of it runs without her. Fix how you talk to her on the phone.'],
  ["Don't reward good actions with bad ones.", 'A good action is its own reward.'],
  ['You become whoever you want to impress.', 'So aim high.'],
  ['Use dark motivation.', 'Make the ones who underestimated you regret it.'],
  ['Do the thing you fear most.', "That's where the growth is hiding."],
  ["Don't half-ass it.", 'Do it once, right, so you never have to come back to it.'],
  ['Focus on ONE thing.', 'Close the side projects. Pick the one business that pays.'],
  ['One thing at a time.', 'No multitasking. The switching cost is bigger than it feels.'],
  ['Do the outreach.', 'The reps you skip are the reps that build you. The one task that makes the money.'],
];
const HABITS = [
  '4 hours of deep work',
  'Stayed quiet about my progress',
  'Low tone, slow speech, posture, said no',
  'Stretched for growth',
  '15 min before sleep: tracks + visualize the dream',
  'Meditated',
  'Journaled',
  'No sugar / gluten / lactose',
  'Sleeping 8h',
];
const DEFAULT_TASKS = [
  'Yacht with Lyosha (Tue)',
  'Grab справка from ТЦК (while in Shostka)',
  'Find uni admission docs + decide where to apply',
  'Beat Bot: continue or close. Decide.',
  'Venu AI: sell hard or flip for $300-500',
  'Maxim: finish the work + take the bigger offer',
  'Close side projects. Focus on ONE.',
  "Ulya's birthday gift",
  'Book the cut with Dino',
  'Finish 3 Hormozi books',
  'Buy grooming + growth supplements',
];

function dayOfYear() { const d = new Date(); const s = new Date(d.getFullYear(), 0, 0); return Math.floor((d - s) / 86400000); }

/* principle of the day */
let principleOff = +(localStorage.getItem('principleOff') || 0);
function principleIdx() { const n = PRINCIPLES.length; return ((dayOfYear() + principleOff) % n + n) % n; }
function renderPrinciple() { const p = PRINCIPLES[principleIdx()]; $('principleQuote').textContent = p[0]; $('principleSub').textContent = p[1]; }
function renderPrinciplesScreen() {
  const cur = principleIdx();
  $('principlesList').innerHTML = PRINCIPLES.map((p, i) =>
    `<div class="principle-item${i === cur ? ' today-p' : ''}">${i === cur ? '<span class="pi-tag">Today</span>' : ''}<div class="pi-q">${esc(p[0])}</div><div class="pi-s">${esc(p[1])}</div></div>`
  ).join('');
}

/* daily habits — done-state stored by text, resets each day with the per-day key */
let habitsDone = lsGet('habits_' + TODAY);
function saveHabits() { lsSet('habits_' + TODAY, habitsDone); renderHabits(); scheduleJournal(); updateMomentum(); }
function renderHabits() {
  const wrap = $('habitsList'); wrap.innerHTML = '';
  HABITS.forEach((h) => {
    const done = habitsDone.includes(h);
    const li = document.createElement('li'); li.className = 'item' + (done ? ' done' : '');
    li.innerHTML = '<button class="check"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg></button><span class="item-text"></span>';
    li.querySelector('.item-text').textContent = h;
    li.querySelector('.check').onclick = () => {
      if (habitsDone.includes(h)) habitsDone = habitsDone.filter((x) => x !== h);
      else { habitsDone.push(h); reward(28); }
      saveHabits();
    };
    wrap.appendChild(li);
  });
  const done = HABITS.filter((h) => habitsDone.includes(h)).length;
  $('habitsProgress').textContent = `${done} / ${HABITS.length}`;
  $('habitsBar').style.width = (done / HABITS.length * 100) + '%';
}

/* ---------- keystone habit engine (the framework) ---------- */
// structured, persistent habits governed by the framework: ONE active at a time,
// floor/ceiling, per-habit streak, and an advancement gate that locks adding the next.
let khabits = (function () { const a = objGet('khabits'); return Array.isArray(a) ? a : []; })();
function khSave() { localStorage.setItem('khabits', JSON.stringify(khabits)); }
if (!khabits.length) {
  khabits = [{ id: uid(), name: 'Pushups', anchor: 'After I step out of the shower', floor: 2, createdAt: TODAY, status: 'active', log: {}, auto: { fires: null, pull: null, askedOn: '' } }];
  khSave();
}
function khActive() { return khabits.find((h) => h.status === 'active') || null; }
function khHitOn(ds) { return khabits.some((h) => h.log && h.log[ds] && h.log[ds].hit); }
function khAllHitDates() { const s = new Set(); khabits.forEach((h) => { if (h.log) for (const ds in h.log) if (h.log[ds] && h.log[ds].hit) s.add(ds); }); return s; }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }
function khStreak(h) { let ds = TODAY; if (!(h.log[ds] && h.log[ds].hit)) ds = shift(ds, -1); let s = 0; while (h.log[ds] && h.log[ds].hit) { s++; ds = shift(ds, -1); } return s; }
function khHitsInLast(h, n) { let c = 0; for (let i = 0; i < n; i++) { const ds = shift(TODAY, -i); if (h.log[ds] && h.log[ds].hit) c++; } return c; }
function khMissedYesterday(h) { const y = shift(TODAY, -1); return daysBetween(h.createdAt, y) >= 0 && !(h.log[y] && h.log[y].hit); }
function khAvgCount(h) { const cs = []; for (const ds in h.log) { const c = h.log[ds] && h.log[ds].count; if (typeof c === 'number' && c > 0) cs.push(c); } return cs.length ? cs.reduce((s, c) => s + c, 0) / cs.length : null; }
function khSignals(h) {
  const age = daysBetween(h.createdAt, TODAY);
  const sustained = age >= 14 && khHitsInLast(h, 14) >= 12;
  const automatic = !!(h.auto && h.auto.fires === true);
  const pull = !!(h.auto && h.auto.pull === true);
  const avg = khAvgCount(h);
  const ceiling = avg != null && avg >= h.floor * 2;
  return { age, sustained, automatic, pull, ceiling, all: sustained && automatic && pull && ceiling };
}
function khVote(h, n) {
  const had = h.log[TODAY] && h.log[TODAY].hit;
  const count = (typeof n === 'number' && n > 0) ? n : ((h.log[TODAY] && h.log[TODAY].count) || h.floor);
  h.log[TODAY] = { hit: true, count }; khSave();
  if (!had) reward(34);
  renderKeystone(); updateMomentum(); scheduleJournal();
}
function khUnvote(h) { if (h.log[TODAY]) { delete h.log[TODAY]; khSave(); renderKeystone(); updateMomentum(); scheduleJournal(); } }
function khSetAuto(h, key, val) { h.auto = h.auto || {}; h.auto[key] = val; h.auto.askedOn = TODAY; khSave(); renderKeystone(); }
function khRaiseFloor(h) { h.floor += 3; khSave(); flash('Floor raised to ' + h.floor); renderKeystone(); }
function khAddHabit(name, anchor) { const cur = khActive(); if (cur) cur.status = 'installed'; khabits.push({ id: uid(), name, anchor, floor: 2, createdAt: TODAY, status: 'active', log: {}, auto: { fires: null, pull: null, askedOn: '' } }); khSave(); flash('New keystone habit. One at a time.'); renderKeystone(); updateMomentum(); }
function khSig(label, on) { return `<span class="kh-sig${on ? ' on' : ''}"><i></i>${esc(label)}</span>`; }
function renderKeystone() {
  const wrap = $('khBody'); if (!wrap) return;
  const h = khActive();
  if (!h) { wrap.innerHTML = '<p class="empty">No active keystone habit.</p>'; if ($('khStreak')) $('khStreak').textContent = '0'; return; }
  const sig = khSignals(h), streak = khStreak(h), doneToday = !!(h.log[TODAY] && h.log[TODAY].hit);
  if ($('khStreak')) $('khStreak').textContent = streak;
  const askAuto = sig.age >= 3 && h.auto.askedOn !== TODAY && (!h.auto.askedOn || daysBetween(h.auto.askedOn, TODAY) >= 3);
  let html = '';
  html += `<div class="kh-rep"><div class="kh-anchor">${esc(h.anchor)}</div><div class="kh-action"><span>${esc(h.name)}</span><span class="kh-floor">floor ${h.floor}, no cap</span></div></div>`;
  html += `<div class="kh-vote-row"><button class="kh-vote${doneToday ? ' done' : ''}" id="khVoteBtn"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg><span>${doneToday ? "Done. that's him" : 'Mark it'}</span></button><input id="khCount" class="kh-count" type="number" inputmode="numeric" min="0" placeholder="${h.floor}" value="${doneToday ? (h.log[TODAY].count || '') : ''}" aria-label="how many" /></div>`;
  if (!doneToday && khMissedYesterday(h)) html += `<div class="kh-warn">Missed yesterday. Never miss twice. Do the ${h.floor} now.</div>`;
  if (askAuto) html += `<div class="kh-auto"><div class="kh-auto-q">Fire on its own, or force it?</div><div class="yn-row"><button class="yn-btn yes" data-a="fires:1">On its own</button><button class="yn-btn no" data-a="fires:0">Forced it</button></div><div class="kh-auto-q">Would skipping it bug you?</div><div class="yn-row"><button class="yn-btn yes" data-a="pull:1">Yeah</button><button class="yn-btn no" data-a="pull:0">Not really</button></div></div>`;
  html += `<div class="kh-gate"><div class="kh-gate-head">Advancement gate</div><div class="kh-signals">${khSig('2 weeks solid', sig.sustained)}${khSig('Fires itself', sig.automatic)}${khSig('Skipping bugs you', sig.pull)}${khSig('Past the floor', sig.ceiling)}</div>`;
  if (sig.all) html += `<div class="kh-earned">Installed. Pick ONE move:<div class="kh-earned-btns"><button id="khRaise" class="save-btn">Raise the floor</button><button id="khAddOpen" class="yn-btn">Add one habit</button></div></div>`;
  else html += `<div class="kh-locked">One at a time. Adding the next is locked until this is installed. The lock is the discipline.</div>`;
  html += `</div>`;
  html += `<form id="khAddForm" class="kh-add" hidden><input id="khName" placeholder="New habit (e.g. read 1 page)" maxlength="60" autocomplete="off" /><input id="khAnchor" placeholder="After I… (anchor)" maxlength="80" autocomplete="off" /><button type="submit" class="add-btn" aria-label="Add">+</button></form>`;
  wrap.innerHTML = html;
  $('khVoteBtn').onclick = () => { doneToday ? khUnvote(h) : khVote(h, parseInt($('khCount').value, 10)); };
  const cEl = $('khCount'); if (cEl) cEl.onchange = () => { if (h.log[TODAY] && h.log[TODAY].hit) khVote(h, parseInt(cEl.value, 10)); };
  wrap.querySelectorAll('.kh-auto .yn-btn').forEach((b) => { b.onclick = () => { const p = b.dataset.a.split(':'); khSetAuto(h, p[0], p[1] === '1'); }; });
  if ($('khRaise')) $('khRaise').onclick = () => khRaiseFloor(h);
  if ($('khAddOpen')) $('khAddOpen').onclick = () => { $('khAddForm').hidden = false; $('khName').focus(); };
  if ($('khAddForm')) $('khAddForm').onsubmit = (e) => { e.preventDefault(); const n = $('khName').value.trim(), a = $('khAnchor').value.trim(); if (!n || !a) return; khAddHabit(n, a); };
}

/* act-now tasks — persistent backlog, survives midnight (unlike goals) */
let tasks = objGet('tasks');
if (!Array.isArray(tasks)) { tasks = DEFAULT_TASKS.map((t) => ({ id: uid(), t, done: false })); localStorage.setItem('tasks', JSON.stringify(tasks)); }
function saveTasks() { localStorage.setItem('tasks', JSON.stringify(tasks)); renderTasks(); }
function renderTasks() {
  const wrap = $('tasksList'); wrap.innerHTML = '';
  if (!tasks.length) wrap.innerHTML = '<li class="empty">Nothing queued. Add what needs doing.</li>';
  tasks.forEach((t, idx) => {
    const li = document.createElement('li'); li.className = 'item' + (t.done ? ' done' : '');
    li.innerHTML = '<button class="check"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg></button><span class="item-text"></span><button class="del">×</button>';
    li.querySelector('.item-text').textContent = t.t;
    li.querySelector('.check').onclick = () => { const nd = !tasks[idx].done; tasks[idx].done = nd; saveTasks(); if (nd) reward(40); };
    li.querySelector('.del').onclick = () => { tasks.splice(idx, 1); saveTasks(); };
    wrap.appendChild(li);
  });
  const done = tasks.filter((t) => t.done).length;
  $('tasksProgress').textContent = `${done} / ${tasks.length}`;
}

/* evening reflection + journal — per day */
const JOURNAL_PROMPTS = [
  'What actually moved today, and what stalled?',
  'Where did you act like the future you, and where like the ghost?',
  'What did you avoid today, and why?',
  'What are you proud of today, even something small?',
  'What drained you, and what gave you energy?',
  'If today repeated for a year, where does it take you?',
  'What is the one thing that matters most tomorrow?',
  'Who did you become a little more of today?',
];
let journalPromptOff = +(localStorage.getItem('journalPromptOff') || 0);
let reflect = objGet('reflect_' + TODAY) || { ans: null, note: '', mood: null };
function saveReflect() { localStorage.setItem('reflect_' + TODAY, JSON.stringify(reflect)); renderReflect(); scheduleJournal(); }
function renderJournalPrompt() { const el = $('journalPrompt'); if (!el) return; const n = JOURNAL_PROMPTS.length; el.textContent = JOURNAL_PROMPTS[((dayOfYear() + journalPromptOff) % n + n) % n]; }
function renderMood() {
  const row = $('moodRow'); if (!row) return;
  let h = '';
  for (let i = 1; i <= 10; i++) h += `<button type="button" class="mood-dot${reflect.mood === i ? ' sel' : ''}" data-m="${i}">${i}</button>`;
  row.innerHTML = h;
  row.querySelectorAll('.mood-dot').forEach((b) => { b.onclick = () => { const m = +b.dataset.m; reflect.mood = (reflect.mood === m ? null : m); saveReflect(); if (reflect.mood) reward(24); }; });
}
function renderReflect() {
  $('reflectYes').classList.toggle('on', reflect.ans === 'yes');
  $('reflectNo').classList.toggle('on', reflect.ans === 'no');
  if ($('reflectNote') && $('reflectNote').value !== (reflect.note || '')) $('reflectNote').value = reflect.note || '';
  renderMood();
  renderJournalPrompt();
}
function dayHandoff() {
  const L = ['My day — ' + TODAY];
  if (big && big.t) L.push('The one thing: ' + big.t + (big.done ? ' (done)' : ' (not yet)'));
  if (goals.length) L.push('Goals: ' + goals.filter((g) => g.done).length + '/' + goals.length);
  const fm = focusToday(); if (fm) L.push('Focus: ' + fm + ' min');
  const kh = khActive(); if (kh) L.push('Keystone (' + kh.name + '): ' + ((kh.log[TODAY] && kh.log[TODAY].hit) ? 'done, streak ' + khStreak(kh) : 'not yet'));
  if (reflect.ans) L.push('Did what my goals required: ' + reflect.ans);
  if (reflect.mood) L.push('Mental state: ' + reflect.mood + '/10');
  if (reflect.note) L.push('', 'Journal:', reflect.note);
  return L.join('\n');
}
async function toFutureSelf() {
  const text = dayHandoff();
  try { await navigator.clipboard.writeText(text); flash('Copied. Paste it to Future Me.'); }
  catch (e) { window.prompt('Copy this, paste it to Future Me:', text); }
}

/* ---------- navigation ---------- */
function show(id) { document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active')); $(id).classList.add('active'); }

/* ---------- wiring ---------- */
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
  if (!requireAuth()) return;
  const go = b.getAttribute('data-go');
  if (go === 'voice') { show('voice'); voiceStatus.textContent = 'Tap to record a voice note'; voicePulse.classList.remove('on'); return; }
  camMode = go; facing = 'user'; show('camera'); setCam(''); startCamera(); render();
}));
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => {
  if ($('focus').classList.contains('active')) stopFocus(true);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (voiceRec && voiceRec.state !== 'inactive') voiceRec.stop();
  shutter.classList.remove('recording'); voiceBtn.classList.remove('recording'); voicePulse.classList.remove('on');
  stopCamera(); camMode = null; show('home'); render();
}));
shutter.addEventListener('click', () => { camMode === 'video' ? toggleVideo() : takePhoto(); });
$('flipBtn').addEventListener('click', flipCamera);
voiceBtn.addEventListener('click', toggleVoice);
$('pickImage').addEventListener('click', () => { if (requireAuth()) imageInput.click(); });
$('pickFile').addEventListener('click', () => { if (requireAuth()) fileInput.click(); });
$('uploadAll').addEventListener('click', () => { if (requireAuth()) { retryBackoff = 0; clearTimeout(retryTimer); flash('Uploading…'); processQueue(); } });
imageInput.addEventListener('change', () => { [...imageInput.files].forEach((f) => enqueue(f, f.name || fname('jpg'), f.type || 'image/jpeg')); imageInput.value = ''; });
fileInput.addEventListener('change', () => { [...fileInput.files].forEach((f) => enqueue(f, f.name || fname('dat'), f.type || 'application/octet-stream')); fileInput.value = ''; });
statusEl.addEventListener('click', () => { retryBackoff = 0; clearTimeout(retryTimer); accessToken ? processQueue() : requestToken('').catch(() => {}); });
// resume stuck uploads when the network returns or the app comes back to the foreground
window.addEventListener('online', () => { retryBackoff = 0; clearTimeout(retryTimer); processQueue(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { retryBackoff = 0; processQueue(); } });
$('historyBtn').addEventListener('click', openHistory);
$('historyLink').addEventListener('click', openHistory);
$('momentumStrip').addEventListener('click', openMomentum);
goalForm.addEventListener('submit', (e) => { e.preventDefault(); const v = goalInput.value.trim(); if (!v) return; goals.push({ t: v, done: false }); goalInput.value = ''; saveGoals(); });
noteForm.addEventListener('submit', (e) => { e.preventDefault(); const v = noteInput.value.trim(); if (!v) return; notes.push({ t: v, ts: Date.now() }); noteInput.value = ''; saveNotes(); });

/* framework */
$('principleMore').addEventListener('click', () => { principleOff = (principleOff + 1) % PRINCIPLES.length; localStorage.setItem('principleOff', principleOff); renderPrinciple(); });
$('principleOpen').addEventListener('click', () => { renderPrinciplesScreen(); show('principles'); });
$('taskForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('taskInput').value.trim(); if (!v) return; tasks.push({ id: uid(), t: v, done: false }); $('taskInput').value = ''; saveTasks(); });
$('reflectYes').addEventListener('click', () => { reflect.ans = reflect.ans === 'yes' ? null : 'yes'; saveReflect(); if (reflect.ans === 'yes') reward(50); });
$('reflectNo').addEventListener('click', () => { reflect.ans = reflect.ans === 'no' ? null : 'no'; saveReflect(); });
$('reflectNote').addEventListener('input', (e) => { reflect.note = e.target.value; localStorage.setItem('reflect_' + TODAY, JSON.stringify(reflect)); scheduleJournal(); });
$('journalAnother').addEventListener('click', () => { journalPromptOff = (journalPromptOff + 1) % JOURNAL_PROMPTS.length; localStorage.setItem('journalPromptOff', journalPromptOff); renderJournalPrompt(); });
$('toFutureSelf').addEventListener('click', toFutureSelf);

/* the one thing */
$('btForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('btInput').value.trim(); if (!v) return; big = { t: v, done: false }; $('btInput').value = ''; saveBig(); });
$('btCheck').addEventListener('click', () => { if (!big) return; big.done = !big.done; saveBig(); if (big.done) reward(60); });
$('btEdit').addEventListener('click', () => { if (!big) return; $('btInput').value = big.t; big = null; renderBig(); localStorage.removeItem('big_' + TODAY); setTimeout(() => $('btInput').focus(), 40); });
$('btFocus').addEventListener('click', () => { startFocus(25, big ? big.t : ''); });

/* focus */
document.querySelectorAll('.fp').forEach((b) => b.addEventListener('click', () => startFocus(+b.dataset.min, big ? big.t : '')));
$('focusToggle').addEventListener('click', () => { if (!fActive) { stopFocus(false); show('home'); render(); return; } setFocusToggle(!fPaused); });
$('focusDone').addEventListener('click', () => { stopFocus(true); show('home'); render(); });

/* people */
$('peopleBtn').addEventListener('click', openPeople);
$('addPersonBtn').addEventListener('click', () => openPerson(null));
$('personCancel').addEventListener('click', () => { show('people'); renderPeople(); });
$('personDelete').addEventListener('click', () => { if (editId && confirm('Delete this person?')) { people = people.filter((x) => x.id !== editId); savePeople(); show('people'); } });
$('personForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('pName').value.trim(); if (!name) { $('pName').focus(); return; }
  const data = { name, tag: selectedTag(), note: $('pNote').value.trim(), last: $('pLast').value, next: $('pNext').value };
  if (editId) { Object.assign(people.find((x) => x.id === editId), data); }
  else { people.push(Object.assign({ id: uid(), ts: Date.now() }, data)); }
  savePeople(); show('people');
});

/* ---------- boot ---------- */
(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist(); } catch (e) {} }
  try { db = await openDB(); } catch (e) {}
  recoverRecordings();   // re-queue any clip interrupted by a crash/reload
  renderGoals(); renderNotes(); renderBig(); renderFocusToday(); renderPeople(); updatePeopleDot();
  renderPrinciple(); renderHabits(); renderKeystone(); renderTasks(); renderReflect(); updateMomentum();
  await render();
  whenGIS(initAuth);
})();
