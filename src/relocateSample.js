const fs = require('node:fs');
const { writeNew } = require('./fileStorage');

/**
 * Stage an existing WAV without re-encoding audio or changing trim offsets. Patch only its Roland pad index.
 * The caller validates slot identity and payload bounds and owns cleanup if reading or staging fails.
 */
function relocateSample(source, destination, label) {
  const wave = fs.readFileSync(source);
  if (wave.toString('ascii', 0, 4) !== 'RIFF' || wave.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${label}: cannot move a non-WAVE sample.`);
  }
  for (let offset = 12; offset + 8 <= wave.length;) {
    const length = wave.readUInt32LE(offset + 4);
    if (offset + 8 + length > wave.length) throw new Error(`${label}: truncated WAV chunk.`);
    if (wave.toString('ascii', offset, offset + 4) === 'RLND') {
      // Other device chunks and WAVs without RLND remain intact; adding padding would invalidate trims.
      if (length >= 13 && wave.toString('ascii', offset + 8, offset + 16) === 'roifspsx') {
        wave[offset + 20] = (label.charCodeAt(0) - 65) * 12 + Number(label.slice(1)) - 1;
      }
    }
    offset += 8 + length + length % 2;
  }
  writeNew(destination, wave);
}

module.exports = relocateSample;
