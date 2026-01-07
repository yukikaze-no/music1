let audioCtx = null;

/* ============================================================
   1. mp3 を読み込む（AudioContext 停止問題を完全回避）
============================================================ */
async function loadAudio(url) {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  // ★ ブラウザの自動再生制限対策
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error("音声ファイルを取得できませんでした: " + res.status);

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
   4. ピーク検出
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
   5. ピーク間隔クラスタリング
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
   6. BPM 補正
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
  const filtered = await lowpassFilter(audioBuffer);
  const energies = getEnergySeries(filtered, frameSize);
  const peaks = detectPeaks(energies, 1.3);

  if (peaks.length < 2) return 120;

  const intervals = [];
  for (let i = 1; i < peaks.length; i++) {
    intervals.push(peaks[i] - peaks[i - 1]);
  }

  const bestInterval = clusterIntervals(intervals);
  const secondsPerBeat = (bestInterval * frameSize) / audioBuffer.sampleRate;
  let bpm = 60 / secondsPerBeat;

  return normalizeBPM(bpm);
}

/* ============================================================
   8. レーン選択（人間工学ベース）
============================================================ */
function chooseLane() {
  const r = Math.random();

  // Easy-friendly distribution:
  // 中指レーン（1,2）を多めに → 押しやすい
  // 薬指レーン（0,3）を少なめに → 負荷軽減
  if (r < 0.35) return 1;  // 左中指
  if (r < 0.70) return 2;  // 右中指
  if (r < 0.85) return 0;  // 左薬指
  return 3;                // 右薬指
}

/* ============================================================
   9. ノーツ生成（重複禁止・ロング間隔確保）
============================================================ */
function generateNotes(peaks, bpm, frameSize, sampleRate) {
  const allNotes = [];
  let lastBeat = -999;
  let lastLongEnd = -999;

  for (let i = 0; i < peaks.length; i++) {
    const frameIndex = peaks[i];
    const time = (frameIndex * frameSize) / sampleRate;
    const beat = (time * bpm) / 60;

    // ノーツ詰まり防止
    if (beat - lastBeat < 0.25) continue;

    const lane = chooseLane();

    // ★ ロングノーツの途中・終端 ±0.20 を禁止
    let conflict = false;
    for (const n of allNotes) {
      if (n.lane === lane && n.type === "long") {
        if (beat >= n.beat - 0.20 && beat <= n.endBeat + 0.20) {
          conflict = true;
          break;
        }
      }
    }
    if (conflict) continue;

    // ★ ロングノーツ同士の間隔確保（0.8 beat 以上）
    if (beat - lastLongEnd < 0.8) {
      // ロング禁止 → tap のみ許可
      allNotes.push({
        lane,
        beat: Number(beat.toFixed(2)),
        type: "tap"
      });
      lastBeat = beat;
      continue;
    }

    lastBeat = beat;

    // ロングノーツ生成（20%）
    const isLong = Math.random() < 0.20;

    if (isLong) {
      const lengthBeat = 1 + Math.random() * 2;
      const endBeat = beat + lengthBeat;

      allNotes.push({
        lane,
        beat: Number(beat.toFixed(2)),
        endBeat: Number(endBeat.toFixed(2)),
        type: "long"
      });

      lastLongEnd = endBeat;
    } else {
      allNotes.push({
        lane,
        beat: Number(beat.toFixed(2)),
        type: "tap"
      });
    }
  }

  return {
    easy: allNotes.filter((_, i) => i % 2 === 0),
    hard: allNotes
  };
}

/* ============================================================
   10. メイン解析処理
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
      bpm,
      patterns
    };

    output.textContent = JSON.stringify(json, null, 2);
    status.textContent = "解析完了！";

  } catch (e) {
    status.textContent = "エラー発生";
    output.textContent = e.message;
  }
}