// =============================================================
//  Vibe Coding · C/S 단계 데모
//  1:N 프롬프트/자료 공유 — 강의별(방) 분리 + 강사가 인원 설정 + 1:1 답변
//  URL 끝 경로 = 강의명(방).  예: /lao2024?host=1 , /lao2024?number=1
//  "자료의 진실은 서버가 가진다" — 모두가 같은 서버 상태를 본다
//  ⚠ Render 무료 플랜은 재배포/슬립 시 저장 자료가 초기화됩니다(임시 디스크).
// =============================================================

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const MAX_STUDENTS = 40;                           // 인원 상한
const ROOT = process.env.DATA_DIR || __dirname;    // (유료 전환 시 DATA_DIR로 영속화 가능)
const DATA_FILE = path.join(ROOT, 'data', 'state.json');
const UPLOAD_ROOT = path.join(ROOT, 'uploads');     // uploads/<room>/<n>_이름/
const MATERIAL_ROOT = path.join(ROOT, 'materials'); // materials/<room>/

// ---------- 디렉터리 보장 ----------
function ensure(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
ensure(path.join(ROOT, 'data'));
ensure(UPLOAD_ROOT);
ensure(MATERIAL_ROOT);

// =============================================================
//  방(강의) 상태
//  rooms[roomId] = { configured, studentCount, students:{n:{number,name,dir,prompts,files,replies}}, materials:[], updatedAt }
//  student.replies = [{ id, text, re(답한 프롬프트 id|null), ts }]  ← 강사가 그 학생에게만 보낸 답변
// =============================================================
let rooms = {};

function freshRoom() {
  return { configured: false, studentCount: 0, students: {}, materials: [], updatedAt: Date.now() };
}
function newStudent(i) {
  return { number: i, name: '', dir: '', prompts: [], files: [], replies: [] };
}
function ensureSlots(room) {
  for (let i = 1; i <= room.studentCount; i++) {
    if (!room.students[i]) room.students[i] = newStudent(i);
    if (!Array.isArray(room.students[i].replies)) room.students[i].replies = [];
  }
}
function getRoom(roomId) {
  if (!rooms[roomId]) rooms[roomId] = freshRoom();
  return rooms[roomId];
}

// 강의명(방 id) 정규화: 영문소문자/숫자/_/- 만 허용
function sanitizeRoom(r) {
  return String(r || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'default';
}

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (raw && raw.rooms && typeof raw.rooms === 'object') {
        rooms = {};
        for (const [rid, r] of Object.entries(raw.rooms)) {
          const room = freshRoom();
          room.configured = !!r.configured;
          room.studentCount = Math.min(MAX_STUDENTS, Math.max(0, parseInt(r.studentCount, 10) || 0));
          room.materials = Array.isArray(r.materials) ? r.materials : [];
          if (r.students) {
            for (let i = 1; i <= room.studentCount; i++) {
              if (r.students[i]) room.students[i] = { ...newStudent(i), ...r.students[i] };
            }
          }
          ensureSlots(room);
          rooms[rid] = room;
        }
        return;
      }
    }
  } catch (e) {
    console.error('상태 파일 읽기 실패, 새로 시작합니다:', e.message);
  }
  rooms = {};
}

let saveTimer = null;
function saveState() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify({ rooms }, null, 2)); }
    catch (e) { console.error('상태 저장 실패:', e.message); }
  }, 50);
}
function touch(room) { room.updatedAt = Date.now(); saveState(); }

loadState();

// ---------- 폴더 이름 유틸 ----------
function sanitizeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}
function folderName(number, name) {
  const n = sanitizeName(name);
  return n ? `${number}_${n}` : `${number}_미지정`;
}
function roomUploadDir(roomId) { const d = path.join(UPLOAD_ROOT, roomId); ensure(d); return d; }
function roomMaterialDir(roomId) { const d = path.join(MATERIAL_ROOT, roomId); ensure(d); return d; }

// 학생 폴더를 현재 이름에 맞춰 생성/이름변경하고 경로 반환
function ensureStudentDir(roomId, number) {
  const room = getRoom(roomId);
  const s = room.students[number];
  if (!s) return null;
  const base = roomUploadDir(roomId);
  const wanted = folderName(number, s.name);
  const wantedPath = path.join(base, wanted);
  if (s.dir && s.dir !== wanted) {
    const oldPath = path.join(base, s.dir);
    if (fs.existsSync(oldPath)) {
      try { if (!fs.existsSync(wantedPath)) fs.renameSync(oldPath, wantedPath); }
      catch (e) { console.error('폴더 이름변경 실패:', e.message); }
    }
  }
  ensure(wantedPath);
  s.dir = wanted;
  return wantedPath;
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function origName(file) { return Buffer.from(file.originalname, 'latin1').toString('utf8'); }

// =============================================================
//  미들웨어
// =============================================================
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT, 'public')));

// 학생 파일 업로드 (FormData에 number를 파일보다 먼저)
const studentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const roomId = sanitizeRoom(req.params.room);
    const number = parseInt(req.body.number, 10);
    const dir = ensureStudentDir(roomId, number);
    if (!dir) return cb(new Error('잘못된 학생 번호'));
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, `${Date.now().toString(36)}__${sanitizeName(safe).replace(/\s/g, '_') || 'file'}`);
  }
});
const studentUpload = multer({ storage: studentStorage, limits: { fileSize: 200 * 1024 * 1024 } });

const materialStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, roomMaterialDir(sanitizeRoom(req.params.room))),
  filename: (req, file, cb) => {
    const safe = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, `${Date.now().toString(36)}__${sanitizeName(safe).replace(/\s/g, '_') || 'material'}`);
  }
});
const materialUpload = multer({ storage: materialStorage, limits: { fileSize: 200 * 1024 * 1024 } });

// =============================================================
//  API  (모든 경로에 :room 포함)
// =============================================================

// 전체 상태 (1초 폴링)
app.get('/api/:room/state', (req, res) => {
  const room = getRoom(sanitizeRoom(req.params.room));
  res.json(room);
});

// 강사: 수강생 수 설정 (최초 입장 시) — 늘리기 가능 / 줄이기 불가
app.post('/api/:room/host/config', (req, res) => {
  const room = getRoom(sanitizeRoom(req.params.room));
  let n = parseInt(req.body.studentCount, 10);
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: '인원 수를 1 이상으로 입력하세요.' });
  if (n > MAX_STUDENTS) return res.status(400).json({ error: `최대 ${MAX_STUDENTS}명까지 가능합니다.` });
  if (room.configured && n < room.studentCount)
    return res.status(400).json({ error: '제출물 보호를 위해 인원은 줄일 수 없습니다.' });
  room.studentCount = n;
  room.configured = true;
  ensureSlots(room);
  touch(room);
  res.json({ ok: true });
});

// 이름 설정/수정
app.post('/api/:room/name', (req, res) => {
  const roomId = sanitizeRoom(req.params.room);
  const room = getRoom(roomId);
  const number = parseInt(req.body.number, 10);
  const name = sanitizeName(req.body.name);
  const s = room.students[number];
  if (!room.configured) return res.status(409).json({ error: '강사가 아직 수업을 시작하지 않았습니다.' });
  if (!s) return res.status(400).json({ error: `번호는 1~${room.studentCount}만 가능합니다.` });
  s.name = name;
  if (name) ensureStudentDir(roomId, number);
  touch(room);
  res.json({ ok: true, student: s });
});

// 학생 프롬프트(텍스트) 제출
app.post('/api/:room/student/prompt', (req, res) => {
  const room = getRoom(sanitizeRoom(req.params.room));
  const number = parseInt(req.body.number, 10);
  const text = String(req.body.text || '').trim();
  const s = room.students[number];
  if (!s) return res.status(400).json({ error: '잘못된 번호' });
  if (!text) return res.status(400).json({ error: '내용이 비어 있습니다.' });
  s.prompts.push({ id: newId(), text, ts: Date.now() });
  touch(room);
  res.json({ ok: true });
});

// 학생 파일 제출
app.post('/api/:room/student/file', studentUpload.single('file'), (req, res) => {
  const room = getRoom(sanitizeRoom(req.params.room));
  const number = parseInt(req.body.number, 10);
  const s = room.students[number];
  if (!s) return res.status(400).json({ error: '잘못된 번호' });
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  s.files.push({ id: newId(), original: origName(req.file), stored: req.file.filename, ts: Date.now() });
  touch(room);
  res.json({ ok: true });
});

// 강사: 특정 학생에게 1:1 답변 (그 학생 화면에만 표시)
app.post('/api/:room/host/reply', (req, res) => {
  const room = getRoom(sanitizeRoom(req.params.room));
  const number = parseInt(req.body.number, 10);
  const text = String(req.body.text || '').trim();
  const re = req.body.re ? String(req.body.re) : null;   // 답한 프롬프트 id (선택)
  const s = room.students[number];
  if (!s) return res.status(400).json({ error: '잘못된 번호' });
  if (!text) return res.status(400).json({ error: '답변이 비어 있습니다.' });
  if (!Array.isArray(s.replies)) s.replies = [];
  s.replies.push({ id: newId(), text, re, ts: Date.now() });
  touch(room);
  res.json({ ok: true });
});

// 강사: 보낸 답변 삭제(취소)
app.post('/api/:room/host/reply/delete', (req, res) => {
  const room = getRoom(sanitizeRoom(req.params.room));
  const number = parseInt(req.body.number, 10);
  const s = room.students[number];
  if (!s || !Array.isArray(s.replies)) return res.status(400).json({ error: '잘못된 번호' });
  s.replies = s.replies.filter(r => r.id !== req.body.id);
  touch(room);
  res.json({ ok: true });
});

// 강사 배포 자료 — 텍스트
app.post('/api/:room/host/material/text', (req, res) => {
  const room = getRoom(sanitizeRoom(req.params.room));
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: '내용이 비어 있습니다.' });
  room.materials.push({ id: newId(), kind: 'text', text, ts: Date.now() });
  touch(room);
  res.json({ ok: true });
});

// 강사 배포 자료 — 파일
app.post('/api/:room/host/material/file', materialUpload.single('file'), (req, res) => {
  const room = getRoom(sanitizeRoom(req.params.room));
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  room.materials.push({ id: newId(), kind: 'file', original: origName(req.file), stored: req.file.filename, ts: Date.now() });
  touch(room);
  res.json({ ok: true });
});

// 강사 배포 자료 다운로드
app.get('/api/:room/material/:id', (req, res) => {
  const roomId = sanitizeRoom(req.params.room);
  const room = getRoom(roomId);
  const m = room.materials.find(x => x.id === req.params.id && x.kind === 'file');
  if (!m) return res.status(404).send('자료를 찾을 수 없습니다.');
  res.download(path.join(roomMaterialDir(roomId), m.stored), m.original);
});

// 학생 제출 파일 다운로드 (강사용)
app.get('/api/:room/student/:number/file/:id', (req, res) => {
  const roomId = sanitizeRoom(req.params.room);
  const room = getRoom(roomId);
  const s = room.students[parseInt(req.params.number, 10)];
  if (!s) return res.status(404).send('학생 없음');
  const f = s.files.find(x => x.id === req.params.id);
  if (!f) return res.status(404).send('파일 없음');
  res.download(path.join(roomUploadDir(roomId), s.dir, f.stored), f.original);
});

// 초기화 — 이 방의 제출물/자료/이름/답변만 삭제 (인원 설정은 유지, 다른 방 영향 없음)
app.post('/api/:room/reset', (req, res) => {
  try {
    const roomId = sanitizeRoom(req.params.room);
    const room = getRoom(roomId);
    fs.rmSync(roomUploadDir(roomId), { recursive: true, force: true });
    fs.rmSync(roomMaterialDir(roomId), { recursive: true, force: true });
    roomUploadDir(roomId); roomMaterialDir(roomId);
    const count = room.studentCount, configured = room.configured;
    rooms[roomId] = freshRoom();
    rooms[roomId].studentCount = count;
    rooms[roomId].configured = configured;
    ensureSlots(rooms[roomId]);
    touch(rooms[roomId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '초기화 실패: ' + e.message });
  }
});

// 그 외 모든 경로(/lao2024 등)는 앱 화면(index.html)을 돌려줌
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('============================================');
  console.log(' Vibe Coding · C/S 프롬프트 공유 도구 (다중 방 + 1:1 답변)');
  console.log(` 강사 화면 : http://localhost:${PORT}/<강의명>?host=1`);
  console.log(` 학생 화면 : http://<내IP>:${PORT}/<강의명>?number=1`);
  console.log('   예) /lao2024?host=1 , /lao2024?number=1');
  console.log('============================================');
});
