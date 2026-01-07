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
   4. ピーク検出
============================================================ */
function detectPeaks(energies, thresholdFactor = 1.3) {
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

async function estimateBPMHighPrecision(audioBuffer, frameSize = 1024) {
  const filtered = await lowpassFilter(audioBuffer);
  const { energies } = getEnergySeries(filtered, frameSize);
  const peaks = detectPeaks(energies, 1.3);
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
   6. 自動オフセット推定（ピーク vs 理想拍）
============================================================ */
function estimateOffsetSec(peaks, bpm, frameSize, sampleRate) {
  const diffs = [];

  for (let i = 0; i < peaks.length; i++) {
    const frameIndex = peaks[i];
    const time = (frameIndex * frameSize) / sampleRate; // 秒
    const beat = (time * bpm) / 60;                     // 拍

    const idealBeat = Math.round(beat);                 // 理想の整数拍
    const diffBeat = beat - idealBeat;                  // 拍単位のズレ
    const diffSec = diffBeat * (60 / bpm);              // 秒に戻す

    // 極端な外れ値は無視（プロが「ここは使わない」と判断する領域）
    if (Math.abs(diffSec) < 0.15) {
      diffs.push(diffSec);
    }
  }

  const offset = avg(diffs);
  return offset || 0;
}

/* ============================================================
   7. 曲構造のざっくり解析（イントロ / 本編 / アウトロ）
============================================================ */
function analyzeStructure(energies, times) {
  const totalDur = times[times.length - 1] || 0;
  const totalAvg = avg(energies);

  // 簡易：前方・中央・後方のエネルギーを見る
  const thirds = Math.floor(energies.length / 3);
  const introAvg = avg(energies.slice(0, thirds));
  const middleAvg = avg(energies.slice(thirds, thirds * 2));
  const outroAvg = avg(energies.slice(thirds * 2));

  // イントロ：エネルギーが低い & 全体の 5〜20% あたり
  let introEndSec = totalDur * 0.05;
  if (introAvg < totalAvg * 0.7) {
    introEndSec = totalDur * 0.15;
  }

  // アウトロ：エネルギーが低い & 最後の 10〜20%
  let outroStartSec = totalDur * 0.85;
  if (outroAvg < totalAvg * 0.7) {
    outroStartSec = totalDur * 0.8;
  }

  return {
    totalDur,
    introEndSec,
    outroStartSec
  };
}

/* ============================================================
   8. レーン選択（人間工学ベース）
============================================================ */
function chooseLane() {
  const r = Math.random();
  // 中指レーン（1,2）を多めに、薬指レーン（0,3）を控えめに
  if (r < 0.35) return 1;  // 左中指
  if (r < 0.70) return 2;  // 右中指
  if (r < 0.85) return 0;  // 左薬指
  return 3;                // 右薬指
}

/* ============================================================
   9. ノーツ生成（自動オフセット＋構造＋重複禁止＋ロング間隔）
============================================================ */
function generateNotes(peaks, bpm, frameSize, sampleRate, offsetSec, structure, energies, times) {
  const allNotes = [];
  let lastBeat = -999;
  let lastLongEnd = -999;

  const secPerBeat = 60 / bpm;

  // 全体エネルギー平均
  const globalAvgEnergy = avg(energies);

  for (let i = 0; i < peaks.length; i++) {
    const frameIndex = peaks[i];
    const rawTime = (frameIndex * frameSize) / sampleRate; // 秒
    const time = rawTime - offsetSec;                      // オフセット補正後の時間

    if (time < 0) continue; // 曲頭より前は無視

    const beat = time / secPerBeat;

    // イントロ・アウトロは基本スキップ（プロが「置かない」と判断する領域）
    if (time < structure.introEndSec) continue;
    if (time > structure.outroStartSec) continue;

    // ノーツ詰まり防止
    if (beat - lastBeat < 0.25) continue;

    const lane = chooseLane();

    // ロングノーツの途中・終端 ±0.20 を禁止
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

    // ロングノーツ同士の間隔確保（0.8 beat 以上）
    const canLong = (beat - lastLongEnd >= 0.8);

    // エネルギーに応じて「ここは使わない」を判断（低エネルギーはスキップ or tap のみ）
    const energy = energies[i] || 0;
    const energyRatio = energy / (globalAvgEnergy || 1);

    // 極端に低いエネルギー → スキップ（静かな部分）
    if (energyRatio < 0.4) continue;

    lastBeat = beat;

    // ロングノーツ生成（20%）ただし条件付き
    let isLong = false;
    if (canLong && energyRatio > 0.8) {
      // 盛り上がっているところだけロング候補
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
   10. メイン解析処理（全部入り）
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

    status.textContent = "エネルギー解析中...";
    const { energies, times } = getEnergySeries(audioBuffer, frameSize);

    status.textContent = "ピーク検出中...";
    const peaks = detectPeaks(energies, 1.3);

    status.textContent = "曲構造解析中...";
    const structure = analyzeStructure(energies, times);

    status.textContent = "オフセット自動推定中...";
    const offsetSec = estimateOffsetSec(peaks, bpm, frameSize, sampleRate);

    status.textContent = "ノーツ生成中...";
    const patterns = generateNotes(
      peaks,
      bpm,
      frameSize,
      sampleRate,
      offsetSec,
      structure,
      energies,
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