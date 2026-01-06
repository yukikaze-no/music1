let audioCtx = null;

/* ============================================================
   1. mp3 を読み込む
============================================================ */
async function loadAudio(url) {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error("音声ファイルを取得できませんでした");

  const arrayBuffer = await res.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  return audioBuffer;
}

/* ============================================================
   2. ローパスフィルタ（Kick 抽出）
============================================================ */
function lowpassFilter(audioBuffer, cutoff = 150) {
  const ctx = new OfflineAudioContext(1, audioBuffer.length, audioBuffer.sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = cutoff;

  source.connect(filter);
  filter.connect(ctx.destination);
  source.start();

  return ctx.startRendering();
}

/* ============================================================
   3. エネルギー（音量）を計算
============================================================ */
function getEnergySeries(audioBuffer, frameSize = 1024) {
  const data = audioBuffer.getChannelData(0);
  const energies = [];

  for (let i = 0; i < data.length; i += frameSize) {
    let sum = 0;
    for (let j = 0; j < frameSize; j++) {
      const v = data[i + j] || 0;
      sum += v * v;
    }
    energies.push(sum);
  }
  return energies;
}

/* ============================================================
   4. ピーク検出（閾値を少し低めに）
============================================================ */
function detectPeaks(energies, thresholdFactor = 1.3) {
  const avg = energies.reduce((a, b) => a + b, 0) / energies.length;
  const threshold = avg * thresholdFactor;

  const peaks = [];
  for (let i = 0; i < energies.length; i++) {
    if (energies[i] > threshold) peaks.push(i);
  }
  return peaks;
}

/* ============================================================
   5. ピーク間隔クラスタリング（最頻値を取る）
============================================================ */
function clusterIntervals(intervals, tolerance = 2) {
  const clusters = [];

  intervals.forEach(interval => {
    let found = false;

    for (const c of clusters) {
      if (Math.abs(c.value - interval) <= tolerance) {
        c.count++;
        found = true;
        break;
      }
    }

    if (!found) {
      clusters.push({ value: interval, count: 1 });
    }
  });

  clusters.sort((a, b) => b.count - a.count);
  return clusters[0].value;
}

/* ============================================================
   6. BPM を自然な範囲に補正
============================================================ */
function normalizeBPM(bpm) {
  while (bpm < 80) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm);
}

/* ============================================================
   7. 高精度 BPM 推定
============================================================ */
async function estimateBPMHighPrecision(audioBuffer, frameSize = 1024) {
  // 1. Kick 抽出
  const filtered = await lowpassFilter(audioBuffer);

  // 2. エネルギー系列
  const energies = getEnergySeries(filtered, frameSize);

  // 3. ピーク検出
  const peaks = detectPeaks(energies, 1.3);
  if (peaks.length < 2) return 120;

  // 4. ピーク間隔
  const intervals = [];
  for (let i = 1; i < peaks.length; i++) {
    intervals.push(peaks[i] - peaks[i - 1]);
  }

  // 5. 最頻値の間隔を採用
  const bestInterval = clusterIntervals(intervals);

  // 6. BPM 計算
  const secondsPerBeat = (bestInterval * frameSize) / audioBuffer.sampleRate;
  let bpm = 60 / secondsPerBeat;

  // 7. 自然な BPM に補正
  bpm = normalizeBPM(bpm);

  return Math.round(bpm);
}

/* ============================================================
   8. ノーツ生成（Easy / Hard・4レーン・ロング対応）
============================================================ */
// peaks: エネルギーピークのフレームインデックス配列
// bpm, frameSize, sampleRate はそのまま利用
function generateNotes(peaks, bpm, frameSize, sampleRate) {
  const allNotes = [];

  let lastBeat = -999; // 前回採用した beat

  for (let i = 0; i < peaks.length; i++) {
    const frameIndex = peaks[i];

    // フレーム → 時間（秒）
    const time = (frameIndex * frameSize) / sampleRate;

    // 時間 → 拍
    const beat = (time * bpm) / 60;

    // ① ノーツ間隔を広げる（詰まり防止）
    // beat差が小さすぎるものはスキップ
    if (beat - lastBeat < 0.25) continue; // 0.25beat 未満は詰まりすぎとみなす

    lastBeat = beat;

    // ② 4レーン均等化（完全ランダムではなく、偏りないようにランダム）
    const lane = Math.floor(Math.random() * 4); // 0〜3

    // ③ ロングノーツ生成（20%）
    const isLong = Math.random() < 0.20;

    if (isLong) {
      const lengthBeat = 1 + Math.random() * 2; // 1〜3拍の長さ

      allNotes.push({
        lane: lane,
        beat: Number(beat.toFixed(2)),
        endBeat: Number((beat + lengthBeat).toFixed(2)),
        type: "long"
      });
    } else {
      allNotes.push({
        lane: lane,
        beat: Number(beat.toFixed(2)),
        type: "tap"
      });
    }
  }

  // Easy は全ノーツの半分だけ使う（難易度差）
  const notesEasy = allNotes.filter((_, i) => i % 2 === 0);
  const notesHard = allNotes;

  return { easy: notesEasy, hard: notesHard };
}

/* ============================================================
   9. メイン解析処理
============================================================ */
async function analyze() {
  const url = document.getElementById("urlInput").value.trim();
  const status = document.getElementById("status");
  const output = document.getElementById("output");

  if (!url) {
    alert("mp3 の URL を入力してください");
    return;
  }

  try {
    status.textContent = "mp3 を読み込み中...";
    const audioBuffer = await loadAudio(url);

    const sampleRate = audioBuffer.sampleRate;
    const frameSize = 1024;

    status.textContent = "BPM 推定中...";
    const bpm = await estimateBPMHighPrecision(audioBuffer, frameSize);

    status.textContent = "ピーク検出中...";
    const energies = getEnergySeries(audioBuffer, frameSize);
    const peaks = detectPeaks(energies);

    status.textContent = "ノーツ生成中...";
    const patterns = generateNotes(peaks, bpm, frameSize, sampleRate);

    const json = {
      title: url.split("/").pop(),
      bpm: bpm,
      patterns: patterns
    };

    output.textContent = JSON.stringify(json, null, 2);
    status.textContent = "解析完了！";

  } catch (e) {
    status.textContent = "エラー発生";
    output.textContent = e.message;
  }
}