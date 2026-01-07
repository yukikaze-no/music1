let audioCtx = null;

/* ============================================================
   0. ユーティリティ
============================================================ */
function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/* ============================================================
   1. mp3 を読み込む（AudioContext 停止問題を完全回避）
============================================================ */
async function loadAudio(url) {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

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
   2. フィルタ（Kick / Snare 抽出）
============================================================ */
function filteredBuffer(audioBuffer, type = "lowpass", freqLow = 40, freqHigh = 150) {
  const ctx = new OfflineAudioContext(1, audioBuffer.length, audioBuffer.sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;

  const filter = ctx.createBiquadFilter();
  filter.type = type;
  if (type === "lowpass") {
    filter.frequency.value = freqHigh;
  } else if (type === "bandpass") {
    filter.frequency.value = (freqLow + freqHigh) / 2;
    filter.Q.value = (freqHigh - freqLow) / filter.frequency.value;
  }

  source.connect(filter);
  filter.connect(ctx.destination);
  source.start();

  return ctx.startRendering();
}

/* ============================================================
   3. エネルギー（音量）を計算（frameSize=512）
============================================================ */
function getEnergySeries(audioBuffer, frameSize = 512) {
  const data = audioBuffer.getChannelData(0);
  const energies = [];
  const times = [];

  for (let i = 0; i < data.length; i += frameSize) {
    let sum = 0;
    for (let j = 0; j < frameSize; j++) {
      const v = data[i + j] || 0;
      sum += v * v;
    }
    energies.push(sum);
    times.push(i / audioBuffer.sampleRate);
  }
  return { energies, times };
}

/* ============================================================
   4. ピーク検出（かなり緩め）
============================================================ */
function detectPeaks(energies, thresholdFactor = 1.05) {
  const avgEnergy = avg(energies);
  const threshold = avgEnergy * thresholdFactor;

  const peaks = [];
  for (let i = 1; i < energies.length - 1; i++) {
    if (energies[i] > threshold && energies[i] >= energies[i - 1] && energies[i] >= energies[i + 1]) {
      peaks.push(i);
    }
  }
  return peaks;
}

/* ============================================================
   5. ピーク間隔クラスタリング → BPM 推定
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
    if (!found) clusters.push({ value: interval, count: 1 });
  });
  clusters.sort((a, b) => b.count - a.count);
  return clusters.length ? clusters[0].value : null;
}

function normalizeBPM(bpm) {
  while (bpm < 80) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm);
}

async function estimateBPMHighPrecision(audioBuffer, frameSize = 512) {
  // Kick + Snare 両方を見る
  const kickBuf = await filteredBuffer(audioBuffer, "lowpass", 40, 150);
  const snareBuf = await filteredBuffer(audioBuffer, "bandpass", 150, 800);

  const { energies: kickE } = getEnergySeries(kickBuf, frameSize);
  const { energies: snareE } = getEnergySeries(snareBuf, frameSize);

  const energies = kickE.map((v, i) => v + (snareE[i] || 0));

  const peaks = detectPeaks(energies, 1.05);
  if (peaks.length < 2) return 120;

  const intervals = [];
  for (let i = 1; i < peaks.length; i++) {
    intervals.push(peaks[i] - peaks[i - 1]);
  }

  const bestInterval = clusterIntervals(intervals);
  if (!bestInterval) return 120;

  const secondsPerBeat = (bestInterval * frameSize) / audioBuffer.sampleRate;
  let bpm = 60 / secondsPerBeat;
  return normalizeBPM(bpm);
}

/* ============================================================
   6. 自動オフセット推定（＋安全なデフォルト）
============================================================ */
function estimateOffsetSec(peaks, bpm, frameSize, sampleRate) {
  const diffs = [];
  const secPerBeat = 60 / bpm;

  for (let i = 0; i < peaks.length; i++) {
    const frameIndex = peaks[i];
    const time = (frameIndex * frameSize) / sampleRate;
    const beat = time / secPerBeat;

    const idealBeat = Math.round(beat);
    const diffBeat = beat - idealBeat;
    const diffSec = diffBeat * secPerBeat;

    if (Math.abs(diffSec) < 0.12) {
      diffs.push(diffSec);
    }
  }

  let offset = avg(diffs);

  if (!isFinite(offset) || diffs.length < 5) {
    offset = 0.04; // 40ms 遅らせる
  }

  return offset;
}

/* ============================================================
   7. 曲構造のざっくり解析（イントロ / アウトロ）
============================================================ */
function analyzeStructure(energies, times) {
  const totalDurSec = times[times.length - 1] || 0;
  const totalAvg = avg(energies);

  const thirds = Math.floor(energies.length / 3);
  const introAvg = avg(energies.slice(0, thirds));
  const outroAvg = avg(energies.slice(thirds * 2));

  let introEndSec = totalDurSec * 0.05;
  if (introAvg < totalAvg * 0.7) {
    introEndSec = totalDurSec * 0.10;
  }

  let outroStartSec = totalDurSec * 0.9;
  if (outroAvg < totalAvg * 0.7) {
    outroStartSec = totalDurSec * 0.85;
  }

  return {
    totalDurSec,
    introEndSec,
    outroStartSec
  };
}

/* ============================================================
   8. レーン選択（人間工学ベース）
============================================================ */
function chooseLane() {
  const r = Math.random();
  if (r < 0.35) return 1;  // 左中指
  if (r < 0.70) return 2;  // 右中指
  if (r < 0.85) return 0;  // 左薬指
  return 3;                // 右薬指
}

/* ============================================================
   9. 拍グリッド fallback 生成（ピークが少ない曲用）
============================================================ */
function generateBeatGridPeaks(bpm, totalDurSec, frameSize, sampleRate) {
  const secPerBeat = 60 / bpm;
  const peaks = [];

  for (let t = 0; t < totalDurSec; t += secPerBeat) {
    const frameIndex = Math.floor((t * sampleRate) / frameSize);
    peaks.push(frameIndex);
  }

  return peaks;
}

/* ============================================================
   10. ノーツ生成（ピーク＋グリッド併用）
============================================================ */
function generateNotes(peaks, bpm, frameSize, sampleRate, offsetSec, structure, energies, times) {
  const allNotes = [];
  let lastBeat = -999;
  let lastLongEnd = -999;

  const secPerBeat = 60 / bpm;
  const globalAvgEnergy = avg(energies);

  for (let i = 0; i < peaks.length; i++) {
    const frameIndex = peaks[i];
    const rawTime = (frameIndex * frameSize) / sampleRate;
    const time = rawTime - offsetSec;

    if (time < 0) continue;

    const beat = time / secPerBeat;

    if (time < structure.introEndSec) continue;
    if (time > structure.outroStartSec) continue;

    if (beat - lastBeat < 0.20) continue;

    const lane = chooseLane();

    let conflict = false;
    for (const n of allNotes) {
      if (n.lane === lane && n.type === "long") {
        if (beat >= n.beat - 0.15 && beat <= n.endBeat + 0.15) {
          conflict = true;
          break;
        }
      }
    }
    if (conflict) continue;

    const canLong = (beat - lastLongEnd >= 0.5);

    const energy = energies[i] || 0;
    const energyRatio = energy / (globalAvgEnergy || 1);

    if (energyRatio < 0.15) continue;

    lastBeat = beat;

    let isLong = false;
    if (canLong && energyRatio > 0.7) {
      isLong = Math.random() < 0.20;
    }

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
   11. メイン解析処理
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
    const frameSize = 512;

    status.textContent = "BPM 推定中...";
    const bpm = await estimateBPMHighPrecision(audioBuffer, frameSize);

    status.textContent = "エネルギー解析中...";
    const { energies, times } = getEnergySeries(audioBuffer, frameSize);

    status.textContent = "ピーク検出中...";
    // Kick + Snare 合成エネルギーでピークを取る
    const kickBuf = await filteredBuffer(audioBuffer, "lowpass", 40, 150);
    const snareBuf = await filteredBuffer(audioBuffer, "bandpass", 150, 800);
    const { energies: kickE } = getEnergySeries(kickBuf, frameSize);
    const { energies: snareE } = getEnergySeries(snareBuf, frameSize);
    const combinedE = kickE.map((v, i) => v + (snareE[i] || 0));

    let peaks = detectPeaks(combinedE, 1.05);

    const structure = analyzeStructure(energies, times);

    status.textContent = "オフセット自動推定中...";
    let offsetSec = 0.0;
    if (peaks.length >= 4) {
      offsetSec = estimateOffsetSec(peaks, bpm, frameSize, sampleRate);
    } else {
      offsetSec = 0.04;
    }

    // ピークが少なすぎる場合は BPM グリッドで補完
    if (peaks.length < 8) {
      const gridPeaks = generateBeatGridPeaks(bpm, structure.totalDurSec, frameSize, sampleRate);
      peaks = gridPeaks;
    }

    status.textContent = "ノーツ生成中...";
    const patterns = generateNotes(
      peaks,
      bpm,
      frameSize,
      sampleRate,
      offsetSec,
      structure,
      combinedE,
      times
    );

    const json = {
      title: url.split("/").pop(),
      bpm,
      offsetSec,
      structure,
      patterns
    };

    output.textContent = JSON.stringify(json, null, 2);
    status.textContent = "解析完了！";

  } catch (e) {
    status.textContent = "エラー発生";
    output.textContent = e.message;
  }
}