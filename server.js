// =============================================================
//  Vibe Coding · C/S 단계 데모
//  1:20 프롬프트/자료 공유 커뮤니케이션 도구
//  "자료의 진실은 서버가 가진다" — 모두가 같은 서버 상태를 본다
// =============================================================

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const STUDENT_COUNT = 20;                       // 1 ~ 20번
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'state.json');
const UPLOAD_ROOT = path.join(ROOT, 'uploads');   // 학생 제출물: 1_이름/
const MATERIAL_ROOT = path.join(ROOT, 'materials'); // 강사 배포 자료

// ---------- 디렉터리 보장 ----------
function ensure(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
ensure(path.join(ROOT, 'data'));
ensure(UPLOAD_ROOT);
ensure(MATERIAL_ROOT);

// ---------- 상태 ----------
//  state.students[number] = { number, name, dir, prompts:[{id,text,ts}], files:[{id,original,stored,ts}] }
//  state.materials = [{ id, kind:'text'|'file', text?, original?, stored?, ts }]
let state;

function freshState() {
  const students = {};
  for (let i = 1; i <= STUDENT_COUNT; i++) {
    students[i] = { number: i, name: '', dir: '', prompts: [], files: [] };
  }
  return { students, materials: [], updatedAt: Date.now() };
}

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      const base = freshState();
      // 기존 데이터를 슬롯에 병합 (구조 안정성 확보)
      if (raw.students) {
        for (let i = 1; i <= STUDENT_COUNT; i++) {
          if (raw.students[i]) base.students[i] = { ...base.students[i], ...raw.students[i] };
        }
      }
      base.materials = Array.isArray(raw.materials) ? raw.materials : [];
      state = base;
      return;
    }
  } catch (e) {
    console.error('상태 파일 읽기 실패, 새로 시작합니다:', e.message);
  }
  state = freshState();
}

let saveTimer = null;
function saveState() {
  state.updatedAt = Date.now();
  // 짧은 디바운스(연속 호출 묶기)
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); }
    catch (e) { console.error('상태 저장 실패:', e.message); }
  }, 50);
}

loadState();

// ---------- 폴더 이름 유틸 ----------
function sanitizeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '')   // 파일시스템 금지문자 제거
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}
// 폴더명 형식: 1_홍길동  (영점 없는 번호 + 이름)
function folderName(number, name) {
  const n = sanitizeName(name);
  return n ? `${number}_${n}` : `${number}_미지정`;
}
// 번호에 대한 폴더를 현재 이름에 맞춰 생성/이름변경하고 경로 반환
function ensureStudentDir(number) {
  const s = state.students[number];
  if (!s) return null;
  const wanted = folderName(number, s.name);
  const wantedPath = path.join(UPLOAD_ROOT, wanted);
  // 기존 폴더(같은 번호로 시작)가 있고 이름이 바뀌었으면 rename
  if (s.dir && s.dir !== wanted) {
    const oldPath = path.join(UPLOAD_ROOT, s.dir);
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

// =============================================================
//  미들웨어
// =============================================================
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT, 'public')));

// 학생 파일 업로드: FormData에 number 필드를 파일보다 먼저 넣어야 함
const studentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const number = parseInt(req.body.number, 10);
    const dir = ensureStudentDir(number);
    if (!dir) return cb(new Error('잘못된 학생 번호'));
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = Buffer.from(file.originalname, 'latin1').toString('utf8'); // 한글 파일명 복원
    const stamp = Date.now().toString(36);
    cb(null, `${stamp}__${sanitizeName(safe).replace(/\s/g, '_') || 'file'}`);
  }
});
const studentUpload = multer({ storage: studentStorage, limits: { fileSize: 200 * 1024 * 1024 } });

const materialStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MATERIAL_ROOT),
  filename: (req, file, cb) => {
    const safe = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const stamp = Date.now().toString(36);
    cb(null, `${stamp}__${sanitizeName(safe).replace(/\s/g, '_') || 'material'}`);
  }
});
const materialUpload = multer({ storage: materialStorage, limits: { fileSize: 200 * 1024 * 1024 } });

function origName(file) {
  return Buffer.from(file.originalname, 'latin1').toString('utf8');
}

// =============================================================
//  API
// =============================================================

// 전체 상태 (1초 폴링)
app.get('/api/state', (req, res) => res.json(state));

// 이름 설정/수정 — 학생 입장 시 & 강사 편집 모두 사용
app.post('/api/name', (req, res) => {
  const number = parseInt(req.body.number, 10);
  const name = sanitizeName(req.body.name);
  const s = state.students[number];
  if (!s) return res.status(400).json({ error: '번호는 1~20만 가능합니다.' });
  s.name = name;
  if (name) ensureStudentDir(number); // 명단이 정해지면 폴더 미리 생성
  saveState();
  res.json({ ok: true, student: s });
});

// 학생 프롬프트(텍스트) 제출
app.post('/api/student/prompt', (req, res) => {
  const number = parseInt(req.body.number, 10);
  const text = String(req.body.text || '').trim();
  const s = state.students[number];
  if (!s) return res.status(400).json({ error: '잘못된 번호' });
  if (!text) return res.status(400).json({ error: '내용이 비어 있습니다.' });
  s.prompts.push({ id: newId(), text, ts: Date.now() });
  saveState();
  res.json({ ok: true });
});

// 학생 파일 제출
app.post('/api/student/file', studentUpload.single('file'), (req, res) => {
  const number = parseInt(req.body.number, 10);
  const s = state.students[number];
  if (!s) return res.status(400).json({ error: '잘못된 번호' });
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  s.files.push({ id: newId(), original: origName(req.file), stored: req.file.filename, ts: Date.now() });
  saveState();
  res.json({ ok: true });
});

// 강사 배포 자료 — 텍스트 프롬프트
app.post('/api/host/material/text', (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: '내용이 비어 있습니다.' });
  state.materials.push({ id: newId(), kind: 'text', text, ts: Date.now() });
  saveState();
  res.json({ ok: true });
});

// 강사 배포 자료 — 파일
app.post('/api/host/material/file', materialUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  state.materials.push({ id: newId(), kind: 'file', original: origName(req.file), stored: req.file.filename, ts: Date.now() });
  saveState();
  res.json({ ok: true });
});

// 강사 배포 자료 다운로드
app.get('/api/material/:id', (req, res) => {
  const m = state.materials.find(x => x.id === req.params.id && x.kind === 'file');
  if (!m) return res.status(404).send('자료를 찾을 수 없습니다.');
  res.download(path.join(MATERIAL_ROOT, m.stored), m.original);
});

// 학생 제출 파일 다운로드 (강사용)
app.get('/api/student/:number/file/:id', (req, res) => {
  const number = parseInt(req.params.number, 10);
  const s = state.students[number];
  if (!s) return res.status(404).send('학생 없음');
  const f = s.files.find(x => x.id === req.params.id);
  if (!f) return res.status(404).send('파일 없음');
  res.download(path.join(UPLOAD_ROOT, s.dir, f.stored), f.original);
});

// 초기화 — 모든 상태 + 서버 폴더 내용 삭제
app.post('/api/reset', (req, res) => {
  try {
    fs.rmSync(UPLOAD_ROOT, { recursive: true, force: true });
    fs.rmSync(MATERIAL_ROOT, { recursive: true, force: true });
    ensure(UPLOAD_ROOT);
    ensure(MATERIAL_ROOT);
    state = freshState();
    saveState();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '초기화 실패: ' + e.message });
  }
});

// 접속 안내 (루트 / host / number 분기는 클라이언트에서)
app.listen(PORT, () => {
  console.log('============================================');
  console.log(' Vibe Coding · C/S 프롬프트 공유 도구');
  console.log(` 강사 화면 : http://localhost:${PORT}/?host=1`);
  console.log(` 학생 화면 : http://<내IP>:${PORT}/?number=1  (1~20)`);
  console.log('============================================');
});
