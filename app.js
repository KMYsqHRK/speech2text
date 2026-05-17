// ---- State ----
let whisperWorker = null;
let pendingChunks = new Map();
let mediaStream = null;
let audioContext = null;
let analyser = null;
let scriptProcessor = null;
let isRunning = false;

let chunkDuration = 5000;
let volumeThreshold = 10;

const OVERLAP_SEC = 0.1;
let pcmBuffer = [];
let overlapBuffer = new Float32Array(0);
let chunkTimer = null;

let processingQueue = [];
let isProcessing = false;

let statProcessed = 0;
let statSkipped = 0;
let chunkSlots = [];
let slotId = 0;

let fullTranscript = '';
let lastWords = [];

// ---- Model ----
window.loadModel = () => {
  const modelId = document.getElementById('modelSelect').value;
  const loadBtn = document.getElementById('loadBtn');
  const progressWrap = document.getElementById('progressWrap');
  const progressBar = document.getElementById('progressBar');
  const progressLabel = document.getElementById('progressLabel');
  loadBtn.disabled = true;
  progressWrap.style.display = 'block';
  document.getElementById('modelStatus').textContent = 'ロード中...';
  clearError();

  if (whisperWorker) { whisperWorker.terminate(); whisperWorker = null; }
  whisperWorker = new Worker('./worker.js', { type: 'module' });

  whisperWorker.onmessage = ({ data: msg }) => {
    if (msg.type === 'progress') {
      const p = msg.payload;
      if (p.status === 'downloading') {
        const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
        progressBar.style.width = pct + '%';
        const mb = (p.loaded / 1024 / 1024).toFixed(1);
        const tot = p.total ? (p.total / 1024 / 1024).toFixed(1) : '?';
        progressLabel.textContent = `${mb} / ${tot} MB (${pct}%)`;
      } else if (p.status === 'loading') {
        progressLabel.textContent = '初期化中...';
        progressBar.style.width = '100%';
      }
    } else if (msg.type === 'ready') {
      document.getElementById('modelStatus').textContent = '✓ ロード済み';
      progressLabel.textContent = '完了';
      document.getElementById('startBtn').disabled = false;
      loadBtn.textContent = '再ロード';
      loadBtn.disabled = false;
    } else if (msg.type === 'error') {
      showError('モデルロード失敗: ' + msg.message);
      document.getElementById('modelStatus').textContent = 'エラー';
      loadBtn.disabled = false;
      progressWrap.style.display = 'none';
    } else if (msg.type === 'result') {
      const resolve = pendingChunks.get(msg.id);
      if (resolve) { resolve(msg.text); pendingChunks.delete(msg.id); }
    }
  };

  whisperWorker.postMessage({ type: 'load', modelId });
};

// ---- Params ----
window.updateParams = () => {
  chunkDuration = parseInt(document.getElementById('chunkSlider').value) * 1000;
  volumeThreshold = parseInt(document.getElementById('threshSlider').value);
  document.getElementById('chunkVal').textContent = (chunkDuration / 1000) + ' 秒';
  document.getElementById('threshVal').textContent = volumeThreshold;
  document.getElementById('threshMarker').style.left = volumeThreshold + '%';
};

// ---- Volume meter ----
function startVolumeMeter() {
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  audioContext.createMediaStreamSource(mediaStream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  function tick() {
    if (!isRunning) return;
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const pct = Math.min(100, Math.round(avg * 100 / 128));
    document.getElementById('volBar').style.width = pct + '%';
    document.getElementById('volBar').style.background = pct >= volumeThreshold ? 'var(--green)' : 'var(--border)';
    document.getElementById('volVal').textContent = pct;
    requestAnimationFrame(tick);
  }
  tick();
}

// ---- RMS ----
function computeRMS(float32) {
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  return Math.round(Math.sqrt(sum / float32.length) * 100 / 0.3 * 10) / 10;
}

// ---- Stream control (Whisper mode) ----
async function startStream() {
  clearError();
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    showError('マイクにアクセスできません: ' + e.message);
    return;
  }

  isRunning = true;
  statProcessed = 0; statSkipped = 0; slotId = 0;
  pcmBuffer = []; overlapBuffer = new Float32Array(0); lastWords = [];
  chunkSlots = [];
  renderTimeline();
  updateStats();

  audioContext = new AudioContext();
  startVolumeMeter();

  const source = audioContext.createMediaStreamSource(mediaStream);
  scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  scriptProcessor.onaudioprocess = (e) => {
    if (!isRunning) return;
    pcmBuffer.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);

  chunkTimer = setInterval(sealChunk, chunkDuration);

  document.getElementById('startBtn').textContent = '⏹ 停止';
  document.getElementById('startBtn').classList.add('running');
  setStatus('live', '録音中（gap なし・オーバーラップ）— チャンクを順次処理');
}

function stopStream() {
  isRunning = false;
  clearInterval(chunkTimer);
  if (pcmBuffer.length > 0) sealChunk();
  if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
  document.getElementById('volBar').style.width = '0%';
  document.getElementById('volVal').textContent = '-';
  document.getElementById('startBtn').textContent = '▶ 開始';
  document.getElementById('startBtn').classList.remove('running');
  setStatus('ready', '停止済み');
}

// ---- リサンプリング（ネイティブ SR → 16kHz） ----
function resampleTo16k(src, fromSR) {
  if (fromSR === 16000) return src;
  const ratio = fromSR / 16000;
  const outLen = Math.round(src.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, src.length - 1);
    out[i] = src[lo] * (1 - (pos - lo)) + src[hi] * (pos - lo);
  }
  return out;
}

// ---- チャンク封印 ----
function sealChunk() {
  if (pcmBuffer.length === 0) return;
  const nativeSR = audioContext ? audioContext.sampleRate : 48000;
  const overlapNative = Math.round(OVERLAP_SEC * nativeSR);

  const totalLen = pcmBuffer.reduce((n, a) => n + a.length, 0);
  const merged = new Float32Array(totalLen);
  let off = 0;
  for (const chunk of pcmBuffer) { merged.set(chunk, off); off += chunk.length; }
  pcmBuffer = [];

  const withOverlap = new Float32Array(overlapBuffer.length + merged.length);
  withOverlap.set(overlapBuffer);
  withOverlap.set(merged, overlapBuffer.length);
  overlapBuffer = withOverlap.slice(-overlapNative);

  const float32 = resampleTo16k(withOverlap, nativeSR);
  const id = slotId++;
  chunkSlots.push({ id, state: 'queued' });
  renderTimeline();
  processingQueue.push({ float32, id });
  updateStats();
  if (!isProcessing) drainQueue();
}

// ---- Queue drain ----
async function drainQueue() {
  if (processingQueue.length === 0) {
    isProcessing = false;
    document.getElementById('queueBar').classList.remove('active');
    if (isRunning) setStatus('live', '録音中（gap なし・オーバーラップ）— チャンクを順次処理');
    else setStatus('ready', '停止済み');
    return;
  }
  isProcessing = true;
  const { float32, id } = processingQueue.shift();
  updateStats();
  document.getElementById('queueBar').classList.add('active');
  document.getElementById('queueLabel').textContent = `Whisper処理中... (残り ${processingQueue.length} 件)`;
  setStatus('processing', `文字起こし処理中 — キュー残り ${processingQueue.length}`);
  await processChunk(float32, id);
  drainQueue();
}

async function processChunk(float32, id) {
  try {
    const vol = computeRMS(float32);
    if (vol < volumeThreshold) {
      statSkipped++;
      setSlotState(id, 'skipped');
      updateStats();
      return;
    }

    const raw = await new Promise((resolve) => {
      pendingChunks.set(id, resolve);
      whisperWorker.postMessage({ type: 'transcribe', id, float32 }, [float32.buffer]);
    });

    const trimmed = raw.trim();
    if (!trimmed || isHallucination(trimmed)) {
      statSkipped++;
      setSlotState(id, 'done');
      updateStats();
      return;
    }

    const text = removeOverlapPrefix(trimmed);
    appendText(text);
    lastWords = trimmed.replace(/[\s　]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(-6);

    statProcessed++;
    setSlotState(id, 'done');
    updateStats();
  } catch (e) {
    console.warn('chunk error:', e);
    setSlotState(id, 'skipped');
  }
}

// ---- ハルシネーション検出 ----
function isHallucination(text) {
  const clean = text.replace(/[\s　。、！？,.!?]/g, '');
  if (clean.length === 0) return true;
  // 同一文字のみ
  if (new Set(clean).size === 1 && clean.length > 3) return true;
  // 同一 n-gram（2〜8文字）が3回以上連続して現れる
  for (let n = 2; n <= 8; n++) {
    for (let i = 0; i <= clean.length - n * 3; i++) {
      const pat = clean.slice(i, i + n);
      let count = 1, pos = i + n;
      while (pos + n <= clean.length && clean.slice(pos, pos + n) === pat) {
        count++; pos += n;
      }
      if (count >= 3) return true;
    }
  }
  return false;
}

// ---- オーバーラップ重複除去 ----
function removeOverlapPrefix(text) {
  if (lastWords.length === 0) return text;
  const words = text.replace(/[\s　]/g, ' ').trim().split(/\s+/).filter(Boolean);
  for (let len = Math.min(6, lastWords.length, words.length); len >= 1; len--) {
    if (lastWords.slice(-len).join('') === words.slice(0, len).join('')) {
      const kept = words.slice(len);
      if (kept.length === 0) return '';
      const skipTo = text.indexOf(kept[0]);
      return skipTo >= 0 ? text.slice(skipTo).trim() : kept.join('');
    }
  }
  return text;
}

// ---- Timeline ----
function setSlotState(id, state) {
  const slot = chunkSlots.find(s => s.id === id);
  if (slot) { slot.state = state; renderTimeline(); }
}

function renderTimeline() {
  const el = document.getElementById('timeline');
  const visible = chunkSlots.slice(-40);
  el.innerHTML = visible.map(s =>
    `<div class="chunk-slot ${s.state}" title="${s.state}"></div>`
  ).join('');
  el.innerHTML += `<div class="chunk-slot recording" title="録音中"></div>`;
}

// ---- Transcript ----
function appendText(text) {
  if (!text) return;
  document.getElementById('placeholder').style.display = 'none';
  fullTranscript += (fullTranscript ? '\n' : '') + text;
  document.getElementById('transcriptText').textContent = fullTranscript;
  document.getElementById('charCount').textContent = fullTranscript.length + ' 文字';
  document.getElementById('copyBtn').disabled = false;
  document.getElementById('clearBtn').disabled = false;
  const area = document.getElementById('transcriptArea');
  area.scrollTop = area.scrollHeight;
}

function setStatus(type, text) {
  document.getElementById('statusDot').className = 'dot ' + type;
  document.getElementById('statusText').textContent = text;
}

function updateStats() {
  document.getElementById('statProcessed').textContent = statProcessed;
  document.getElementById('statSkipped').textContent = statSkipped;
  document.getElementById('statQueue').textContent = processingQueue.length;
}

window.copyText = () => {
  if (!fullTranscript) return;
  navigator.clipboard.writeText(fullTranscript).then(() => {
    const btn = document.getElementById('copyBtn');
    btn.textContent = '✓ コピー済み';
    setTimeout(() => btn.textContent = 'コピー', 1500);
  });
};

window.clearText = () => {
  fullTranscript = '';
  lastWords = [];
  document.getElementById('transcriptText').textContent = '';
  document.getElementById('placeholder').style.display = 'block';
  document.getElementById('charCount').textContent = '0 文字';
  document.getElementById('copyBtn').disabled = true;
  document.getElementById('clearBtn').disabled = true;
};

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg; el.style.display = 'block';
}
function clearError() {
  document.getElementById('errorMsg').style.display = 'none';
}

// ---- Mode switch ----
function getMode() {
  return document.querySelector('input[name=mode]:checked').value;
}

window.onModeChange = () => {
  const isLocal = getMode() === 'local';
  document.getElementById('whisperCard').style.display = isLocal ? '' : 'none';
  document.getElementById('paramsCard').style.display = isLocal ? '' : 'none';
  const startBtn = document.getElementById('startBtn');
  if (!isLocal) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      showError('Web Speech API はこのブラウザで利用できません（Chrome を使用してください）');
      document.querySelector('input[name=mode][value=local]').checked = true;
      window.onModeChange();
      return;
    }
    startBtn.disabled = false;
  } else {
    startBtn.disabled = (document.getElementById('modelStatus').textContent !== '✓ ロード済み');
  }
  clearError();
};

// ---- Web Speech API ----
let recognition = null;

function startWebSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = 'ja-JP';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) {
        const text = r[0].transcript.trim();
        if (text) appendText(text);
        document.getElementById('interimArea').classList.remove('active');
        document.getElementById('interimText').textContent = '';
      } else {
        interim += r[0].transcript;
      }
    }
    if (interim) {
      document.getElementById('interimArea').classList.add('active');
      document.getElementById('interimText').textContent = interim;
    }
  };

  recognition.onend = () => {
    if (isRunning) recognition.start();
  };

  recognition.onerror = (e) => {
    if (e.error === 'no-speech') return;
    if (e.error === 'not-allowed') {
      showError('マイクへのアクセスが拒否されました');
    } else if (e.error === 'network') {
      showError('network エラー: Web Speech API は file:// では動作しません。python -m http.server 8080 などでローカルサーバーを起動し、http://localhost:8080 から開いてください。');
    } else {
      showError('Web Speech エラー: ' + e.error);
    }
  };

  recognition.start();
  isRunning = true;
  document.getElementById('startBtn').textContent = '⏹ 停止';
  document.getElementById('startBtn').classList.add('running');
  setStatus('live', 'Web Speech API — 認識中（Google サーバー）');
  document.getElementById('footer').textContent = 'Web Speech API — powered by Google';
}

function stopWebSpeech() {
  isRunning = false;
  if (recognition) { recognition.stop(); recognition = null; }
  document.getElementById('interimArea').classList.remove('active');
  document.getElementById('interimText').textContent = '';
  document.getElementById('startBtn').textContent = '▶ 開始';
  document.getElementById('startBtn').classList.remove('running');
  setStatus('ready', '停止済み');
}

// ---- Toggle ----
window.toggleStream = () => {
  if (getMode() === 'webspeech') {
    isRunning ? stopWebSpeech() : startWebSpeech();
  } else {
    isRunning ? stopStream() : startStream();
  }
};

updateParams();
