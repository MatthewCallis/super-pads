const fs = require('node:fs');
const path = require('node:path');
const { inspectPattern } = require('./patternMetadata');
const { emptyPatternSlots } = require('./patternSlots');

const PATTERN_DIRECTORY = 'ROLAND/SP-404SX/PTN';

/**
 * Read all SX slots without hiding the card for one damaged pattern. Missing files represent empty slots.
 * Saved names, note maps and tempo belong only to identical bytes; sampler edits invalidate that metadata.
 */
async function readPatterns(root) {
  const patterns = emptyPatternSlots();
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(root, 'super-pads.json'), 'utf8')).patterns || {}; }
  catch { /* Optional editor metadata must never prevent reading the sampler's authoritative files. */ }
  for (const slot of Object.values(patterns)) {
    const file = path.join(root, PATTERN_DIRECTORY, slot.filename);
    if (!fs.existsSync(file)) continue;
    try {
      const bytes = fs.readFileSync(file);
      // Some cards retain zero-byte files for vacant pattern slots.
      if (!bytes.length) continue;
      slot.bytes = Array.from(bytes);
      slot.summary = await inspectPattern(bytes);
      const previous = saved[slot.label];
      if (Array.isArray(previous?.bytes) && bytes.equals(Buffer.from(previous.bytes))) {
        slot.name = previous.name;
        slot.noteMap = previous.noteMap;
        slot.bpm = previous.bpm;
      }
    } catch (error) { slot.error = error.message; }
  }
  return patterns;
}

module.exports = { readPatterns, PATTERN_DIRECTORY };
