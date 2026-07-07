/**
 * Taiwan Voice Recorder — 後端伺服器
 * 功能:
 *   1. 提供錄音腳本 API (/api/scripts)
 *   2. 接收 WebM/Opus 錄音上傳 (/api/upload)
 *   3. 以 ffmpeg 轉檔為 WAV PCM16 Mono 24000Hz
 *   4. 儲存 original/ processed/ 並附加 metadata.csv
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway 部署時將 Volume 掛載點設為 /data,並設定環境變數 DATA_DIR=/data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ORIGINAL_DIR = path.join(DATA_DIR, 'original');
const PROCESSED_DIR = path.join(DATA_DIR, 'processed');
const METADATA_CSV = path.join(DATA_DIR, 'metadata.csv');
const CSV_HEADER = 'filename,emotion,text,speaker,age,source,createdAt,notes\n';

// 確保目錄與 CSV 檔頭存在
for (const dir of [DATA_DIR, ORIGINAL_DIR, PROCESSED_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(METADATA_CSV)) {
  fs.writeFileSync(METADATA_CSV, '\uFEFF' + CSV_HEADER, 'utf8'); // BOM 讓 Excel 正確顯示中文
}

// 上傳暫存至 original/,以時間戳＋腳本ID命名
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ORIGINAL_DIR),
  filename: (req, _file, cb) => {
    const scriptId = sanitize(req.query.scriptId || 'UNK');
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    cb(null, `${ts}_${scriptId}.webm`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---- API:取得錄音腳本(優先讀 Volume 內上傳的版本)----
const SCRIPTS_FILE = path.join(DATA_DIR, 'scripts.json');
app.get('/api/scripts', (_req, res) => {
  try {
    const file = fs.existsSync(SCRIPTS_FILE) ? SCRIPTS_FILE : path.join(__dirname, 'scripts.json');
    res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: '無法讀取腳本:' + err.message });
  }
});

// ---- API:上傳腳本檔(PDF / Word / TXT / JSON)----
// 每行一句,格式:「情緒|句子」或「情緒,句子」,情緒可用中英文;無標記視為 neutral
const scriptUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const EMO_MAP = {
  happy: 'happy', '開心': 'happy', '快樂': 'happy', '高興': 'happy',
  sad: 'sad', '難過': 'sad', '傷心': 'sad', '悲傷': 'sad',
  angry: 'angry', '生氣': 'angry', '憤怒': 'angry',
  fear: 'fear', '害怕': 'fear', '恐懼': 'fear', '緊張': 'fear',
  surprise: 'surprise', '驚訝': 'surprise', '驚喜': 'surprise',
  neutral: 'neutral', '中性': 'neutral', '平靜': 'neutral',
};

function parseScriptLines(text) {
  const scripts = [];
  for (let raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.length < 2) continue;
    let emotion = 'neutral', sentence = line;
    // 嘗試以第一個分隔符切出情緒標記,支援 [happy] 開心| happy, 等寫法
    const m = line.match(/^[\[【(（]?\s*([A-Za-z]{3,10}|[\u4e00-\u9fff]{2,3})\s*[\]】)）]?\s*[|,，:：\t]\s*(.+)$/);
    if (m) {
      const key = m[1].toLowerCase();
      if (EMO_MAP[key] || EMO_MAP[m[1]]) {
        emotion = EMO_MAP[key] || EMO_MAP[m[1]];
        sentence = m[2].trim();
      }
    }
    scripts.push({ id: 'U' + String(scripts.length + 1).padStart(3, '0'), emotion, text: sentence });
  }
  return scripts;
}

app.post('/api/scripts/upload', scriptUpload.single('file'), async (req, res) => {
  const required = process.env.EXPORT_TOKEN;
  if (required && req.body.token !== required) {
    return res.status(403).json({ error: '無效的管理 token' });
  }
  if (!req.file) return res.status(400).json({ error: '未收到檔案' });

  const name = (req.file.originalname || '').toLowerCase();
  let text = '';
  try {
    if (name.endsWith('.pdf')) {
      const pdfParse = require('pdf-parse');
      text = (await pdfParse(req.file.buffer)).text;
    } else if (name.endsWith('.docx')) {
      const mammoth = require('mammoth');
      text = (await mammoth.extractRawText({ buffer: req.file.buffer })).value;
    } else if (name.endsWith('.json')) {
      const data = JSON.parse(req.file.buffer.toString('utf8'));
      if (!Array.isArray(data.scripts)) throw new Error('JSON 需含 scripts 陣列');
      fs.writeFileSync(SCRIPTS_FILE, JSON.stringify(data, null, 2), 'utf8');
      return res.json({ ok: true, count: data.scripts.length, source: data.source || '' });
    } else {
      text = req.file.buffer.toString('utf8'); // txt / csv
    }
  } catch (err) {
    return res.status(400).json({ error: '檔案解析失敗:' + err.message });
  }

  const scripts = parseScriptLines(text);
  if (!scripts.length) return res.status(400).json({ error: '檔案中找不到可用的腳本句子' });

  const source = req.body.source || 'VIA-SEL-custom';
  fs.writeFileSync(SCRIPTS_FILE, JSON.stringify({ source, scripts }, null, 2), 'utf8');
  res.json({ ok: true, count: scripts.length, source, preview: scripts.slice(0, 3) });
});

// ---- API:已上傳錄音清單(供中途試聽與管理)----
function checkToken(req, res) {
  const required = process.env.EXPORT_TOKEN;
  if (required && (req.query.token || req.body?.token) !== required) {
    res.status(403).json({ error: '無效的 token' });
    return false;
  }
  return true;
}

function parseCsvLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

app.get('/api/recordings', (req, res) => {
  if (!checkToken(req, res)) return;
  const lines = fs.readFileSync(METADATA_CSV, 'utf8').replace(/^\uFEFF/, '').trim().split('\n');
  const rows = lines.slice(1).filter(Boolean).map(l => {
    const [filename, emotion, text, speaker, age, source, createdAt, notes] = parseCsvLine(l);
    return { filename, emotion, text, speaker, age, source, createdAt, notes };
  });
  res.json({ total: rows.length, recordings: rows.reverse() }); // 最新在前
});

// ---- API:串流播放單一音檔(processed WAV 或 original WebM)----
app.get('/api/audio/:filename', (req, res) => {
  if (!checkToken(req, res)) return;
  const name = path.basename(req.params.filename); // 防路徑跳脫
  let filePath = null;
  if (name.endsWith('.wav')) filePath = path.join(PROCESSED_DIR, name);
  else if (name.endsWith('.webm')) filePath = path.join(ORIGINAL_DIR, name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: '找不到音檔' });
  res.sendFile(filePath);
});

// ---- API:匯出整包資料集(zip)----
// format = all(預設)| wav | mp3 | webm;若設定 EXPORT_TOKEN 需帶 ?token=xxx
app.get('/api/export', async (req, res) => {
  const required = process.env.EXPORT_TOKEN;
  if (required && req.query.token !== required) {
    return res.status(403).json({ error: '無效的 token' });
  }
  const format = (req.query.format || 'all').toLowerCase();
  const archiver = require('archiver');
  const ts = new Date().toISOString().slice(0, 10);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => res.status(500).end(err.message));

  if (format === 'mp3') {
    // 即時將 processed/ 的 WAV 轉為 MP3(128kbps)
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mp3-'));
    const wavs = fs.readdirSync(PROCESSED_DIR).filter(f => f.endsWith('.wav'));
    try {
      for (const f of wavs) {
        const mp3Path = path.join(tmpDir, f.replace(/\.wav$/, '.mp3'));
        await new Promise((resolve, reject) => {
          execFile('ffmpeg', ['-y', '-i', path.join(PROCESSED_DIR, f), '-c:a', 'libmp3lame', '-b:a', '128k', mp3Path],
            err => err ? reject(err) : resolve());
        });
      }
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return res.status(500).json({ error: 'MP3 轉檔失敗:' + err.message });
    }
    res.attachment(`sel-dataset-mp3-${ts}.zip`);
    archive.pipe(res);
    archive.directory(tmpDir, 'mp3');
    archive.file(METADATA_CSV, { name: 'metadata.csv' });
    archive.on('end', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
  } else if (format === 'wav') {
    res.attachment(`sel-dataset-wav-${ts}.zip`);
    archive.pipe(res);
    archive.directory(PROCESSED_DIR, 'processed');
    archive.file(METADATA_CSV, { name: 'metadata.csv' });
  } else if (format === 'webm') {
    res.attachment(`sel-dataset-webm-${ts}.zip`);
    archive.pipe(res);
    archive.directory(ORIGINAL_DIR, 'original');
    archive.file(METADATA_CSV, { name: 'metadata.csv' });
  } else {
    res.attachment(`sel-dataset-${ts}.zip`);
    archive.pipe(res);
    archive.directory(ORIGINAL_DIR, 'original');
    archive.directory(PROCESSED_DIR, 'processed');
    archive.file(METADATA_CSV, { name: 'metadata.csv' });
  }
  archive.finalize();
});

// ---- API:目前已收集數量 ----
app.get('/api/stats', (_req, res) => {
  const lines = fs.readFileSync(METADATA_CSV, 'utf8').trim().split('\n');
  res.json({ total: Math.max(0, lines.length - 1) });
});

// ---- API:上傳錄音 ----
app.post('/api/upload', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到音檔' });

  const meta = {
    emotion: req.body.emotion || '',
    text: req.body.text || '',
    speaker: req.body.speaker || '',
    age: req.body.age || '',
    source: req.body.source || 'VIA-SEL-v1',
    notes: req.body.notes || '',
  };

  const originalPath = req.file.path;
  const wavName = path.basename(originalPath, '.webm') + '.wav';
  const processedPath = path.join(PROCESSED_DIR, wavName);

  // ffmpeg 轉檔:WAV / PCM signed 16-bit LE / 單聲道 / 24000 Hz
  const args = [
    '-y',
    '-i', originalPath,
    '-ac', '1',
    '-ar', '24000',
    '-c:a', 'pcm_s16le',
    processedPath,
  ];

  execFile('ffmpeg', args, (err, _stdout, stderr) => {
    if (err) {
      console.error('[ffmpeg 錯誤]', stderr);
      return res.status(500).json({ error: 'ffmpeg 轉檔失敗', detail: stderr.slice(-500) });
    }

    const row = [
      wavName,
      meta.emotion,
      meta.text,
      meta.speaker,
      meta.age,
      meta.source,
      new Date().toISOString(),
      meta.notes,
    ].map(csvEscape).join(',') + '\n';

    fs.appendFileSync(METADATA_CSV, row, 'utf8');

    res.json({
      ok: true,
      original: path.basename(originalPath),
      processed: wavName,
    });
  });
});

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sanitize(s) {
  return String(s).replace(/[^\w-]/g, '').slice(0, 32);
}

app.listen(PORT, () => {
  console.log(`Taiwan Voice Recorder 已啟動:http://localhost:${PORT}`);
  console.log(`資料儲存於:${DATA_DIR}`);
});
