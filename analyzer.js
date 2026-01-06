// ===============================
//  高品質 譜面自動生成エンジン
// ===============================

function generateChart(audioData, bpm) {

  const notes = [];
  const beats = detectBeats(audioData, bpm); 
  // ↑ あなたの既存のビート検出関数を使う

  let lastBeat = -999;

  for (let beat of beats) {

    // -------------------------------
    // ① ノーツ間隔を広げる（詰まり防止）
    // -------------------------------
    if (beat - lastBeat < 0.25) continue; 
    // BPM176 なら 0.25beat ≒ 0.085秒 → これで詰まり防止

    lastBeat = beat;

    // -------------------------------
    // ② 4レーン均等化
    // -------------------------------
    const lane = Math.floor(Math.random() * 4); 
    // 0〜3 の4レーン

    // -------------------------------
    // ③ ロングノーツ生成（20%）
    // -------------------------------
    const isLong = Math.random() < 0.20;

    if (isLong) {
      const lengthBeat = 1 + Math.random() * 2; 
      // 1〜3拍のロング

      notes.push({
        lane: lane,
        beat: beat,
        endBeat: beat + lengthBeat,
        type: "long"
      });

    } else {
      notes.push({
        lane: lane,
        beat: beat,
        type: "tap"
      });
    }
  }

  return {
    bpm: bpm,
    patterns: {
      easy: notes.filter((_, i) => i % 2 === 0),  // Easy は半分
      hard: notes                                 // Hard は全部
    }
  };
}