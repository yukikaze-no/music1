let audioCtx = null;

/* ============================================================
   0. Utility
============================================================ */
function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

/* ============================================================
   1. Load Audio
============================================================ */
async function loadAudio(url) {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error("音声ファイルを取得できませんでした");

  const arrayBuffer = await res.arrayBuffer();
  return await audioCtx.decodeAudioData(arrayBuffer);
}

/* ============================================================
   2. Filter (Kick / Snare)
============================================================ */
function filteredBuffer(audioBuffer, type = "lowpass", low = 40, high = 150) {
  const ctx = new OfflineAudioContext(1, audioBuffer.length, audioBuffer.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;

  const filter = ctx.createBiquadFilter();
  filter.type = type;

  if (type === "lowpass") {
    filter.frequency.value = high;
  } else if (type === "bandpass") {
    filter.frequency.value = (low + high) / 2;
    filter.Q.value = (high - low) / filter.frequency.value;
  }

  src.connect(filter);
  filter.connect(ctx.destination);
  src.start();

  return ctx.startRendering();
}

/* ============================================================
   3. Energy Series (frameSize = 512)
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
   4. Peak Detection
============================================================ */
function detectPeaks(energies, thresholdFactor = 1.05) {
  const base = avg(energies);
  const th = base * thresholdFactor;

  const peaks = [];
  for (let i = 1; i < energies.length - 1; i++) {
    if (energies[i] > th && energies[i] >= energies[i - 1] && energies[i] >= energies[i + 1]) {
      peaks.push(i);
    }
  }
  return peaks;
}

/* ============================================================
   5. BPM Estimation
============================================================ */
function clusterIntervals(intervals, tol = 2) {
  const clusters = [];
  intervals.forEach(v => {
    let found = false;
    for (const c of clusters) {
      if (Math.abs(c.value - v) <= tol) {
        c.count++;
        found = true;
        break;
      }
    }
    if (!found) clusters.push({ value: v, count: 1 });
  });
  clusters.sort((a, b) => b.count - a.count);
  return clusters[0]?.value || null;
}

function normalizeBPM(bpm) {
  while (bpm < 80) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm);
}

async function estimateBPM(audioBuffer, frameSize = 512) {
  const kick = await filteredBuffer(audioBuffer, "lowpass", 40, 150);
  const snare = await filteredBuffer(audioBuffer, "bandpass", 150, 800);

  const { energies: kE } = getEnergySeries(kick, frameSize);
  const { energies: sE } = getEnergySeries(snare, frameSize);

  const energies = kE.map((v, i) => v + (sE[i] || 0));
  const peaks = detectPeaks(energies, 1.05);

  if (peaks.length < 2) return 120;

  const intervals = [];
  for (let i = 1; i < peaks.length; i++) {
    intervals.push(peaks[i] - peaks[i - 1]);
  }

  const best = clusterIntervals(intervals);
  if (!best) return 120;

  const secPerBeat = (best * frameSize) / audioBuffer.sampleRate;
  return normalizeBPM(60 / secPerBeat);
}

/* ============================================================
   6. Auto Offset
============================================================ */
function estimateOffset(peaks, bpm, frameSize, sampleRate) {
  const secPerBeat = 60 / bpm;
  const diffs = [];

  for (const p of peaks) {
    const t = (p * frameSize) / sampleRate;
    const beat = t / secPerBeat;
    const ideal = Math.round(beat);
    const diffSec = (beat - ideal) * secPerBeat;

    if (Math.abs(diffSec) < 0.12) diffs.push(diffSec);
  }

  if (diffs.length < 5) return 0.04;
  const o = avg(diffs);
  return Math.abs(o) < 0.002 ? 0.04 : o;
}

/* ============================================================
   7. Structure (Intro / Outro)
============================================================ */
function analyzeStructure(energies, times) {
  const total = times[times.length - 1] || 0;
  const avgE = avg(energies);

  const third = Math.floor(energies.length / 3);
  const introAvg = avg(energies.slice(0, third));
  const outroAvg = avg(energies.slice(third * 2));

  let introEnd = total * 0.05;
  if (introAvg < avgE * 0.7) introEnd = total * 0.10;

  let outroStart = total * 0.9;
  if (outroAvg < avgE * 0.7) outroStart = total * 0.85;

  return { totalDurSec: total, introEndSec: introEnd, outroStartSec: outroStart };
}

/* ============================================================
   8. Lane Selection (0–3: playable, 4: internal)
============================================================ */
function chooseLane() {
  const r = Math.random();
  if (r < 0.35) return 1; // 左中指
  if (r < 0.70) return 2; // 右中指
  if (r < 0.85) return 0; // 左薬指
  return 3;               // 右薬指
}

/* ============================================================
   9. Beat Grid (always used)
============================================================ */
function generateBeatGrid(bpm, totalSec, frameSize, sampleRate) {
  const secPerBeat = 60 / bpm;
  const peaks = [];
  for (let t = 0; t < totalSec; t += secPerBeat) {
    peaks.push(Math.floor((t * sampleRate) / frameSize));
  }
  return peaks;
}

/* ============================================================
   10. Note Generation (with internal markers)
============================================================ */
function generateNotes(peaks, bpm, frameSize, sampleRate, offsetSec, structure, energies, times) {
  const all = [];
  let lastBeat = -999;
  let lastLongEnd = -999;

  const secPerBeat = 60 / bpm;
  const avgE = avg(energies) || 1;

  for (const p of peaks) {
    const rawTime = (p * frameSize) / sampleRate;
    const time = rawTime - offsetSec;
    if (time < 0) continue;

    const beat = time / secPerBeat;

    if (time < structure.introEndSec) continue;
    if (time > structure.outroStartSec) continue;

    if (beat - lastBeat < 0.125) continue;

    const lane = chooseLane();

    let conflict = false;
    for (const n of all) {
      if (n.lane === lane && n.type === "long") {
        if (beat >= n.beat - 0.15 && beat <= n.endBeat + 0.15) {
          conflict = true;
          break;
        }
      }
    }
    if (conflict) continue;

    const canLong = beat - lastLongEnd >= 0.5;

    const energy = energies[p] || 0;
    const ratio = energy / avgE;

    if (ratio < 0.05) continue;

    lastBeat = beat;

    let isLong = false;
    if (canLong && ratio > 0.7) {
      isLong = Math.random() < 0.20;
    }

    if (isLong) {
      const len = 1 + Math.random() * 2;
      const endBeat = beat + len;

      all.push({
        lane,
        beat: Number(beat.toFixed(2)),
        endBeat: Number(endBeat.toFixed(2)),
        type: "long"
      });

      lastLongEnd = endBeat;
    } else {
      all.push({
        lane,
        beat: Number(beat.toFixed(2)),
        type: "tap"
      });
    }
  }

  // ★ 内部マーカー（5番レーン = lane:4）
  const totalBeats = structure.totalDurSec / secPerBeat;

  all.push({
    lane: 4,
    beat: 0,
    type: "marker"
  });

  all.push({
    lane: 4,
    beat: Number(totalBeats.toFixed(2)),
    type: "marker"
  });

  return {
    easy: all.filter(n => n.lane !== 4).filter((_, i) => i % 2 === 0),
    hard: all.filter(n => n.lane !== 4),
    internalMarkers: all.filter(n => n.lane === 4)
  };
}

/* ============================================================
   11. Main
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
    const bpm = await estimateBPM(audioBuffer, frameSize);

    status.textContent = "エネルギー解析中...";
    const { energies, times } = getEnergySeries(audioBuffer, frameSize);

    status.textContent = "ピーク検出中...";
    const kick = await filteredBuffer(audioBuffer, "lowpass", 40, 150);
    const snare = await filteredBuffer(audioBuffer, "bandpass", 150, 800);
    const { energies: kE } = getEnergySeries(kick, frameSize);
    const { energies: sE } = getEnergySeries(snare, frameSize);
    const combined = kE.map((v, i) => v + (sE[i] || 0));

    let peaks = detectPeaks(combined, 1.05);

    status.textContent = "曲構造解析中...";
    const structure = analyzeStructure(combined, times);

    status.textContent = "オフセット推定中...";
    let offsetSec = peaks.length >= 4
      ? estimateOffset(peaks, bpm, frameSize, sampleRate)
      : 0.04;

    const grid = generateBeatGrid(bpm, structure.totalDurSec, frameSize, sampleRate);
    peaks = [...peaks, ...grid].sort((a, b) => a - b);

    status.textContent = "ノーツ生成中...";
    const patterns = generateNotes(
      peaks,
      bpm,
      frameSize,
      sampleRate,
      offsetSec,
      structure,
      combined,
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