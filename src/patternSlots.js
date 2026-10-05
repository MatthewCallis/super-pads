/** SX/A banks have twelve independent pattern slots and twelve sample pads. */
const BANKS = 'ABCDEFGHIJ'.split('');
/** Ascending drum-rack notes fill the bottom pad row first, matching the requested C1 layout. */
const DRUM_PAD_ORDER = [9, 10, 11, 12, 5, 6, 7, 8, 1, 2, 3, 4];

/** Display DAW-style octaves (C1 = 36); MIDI numbers remain the source of truth. */
function noteName(note) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[note % 12]}${Math.floor(note / 12) - 2}`;
}

/** Resolve the native SX filename. Each bank's pad 12 occupies index zero, followed by pads 1–11. */
function patternFilename(label) {
  if (!/^[A-J](?:[1-9]|1[0-2])$/.test(label)) throw new Error(`Invalid pattern slot: ${label}`);
  // SX uses this rotated file order, unlike its sample filenames: A12=PTN00000, B12=PTN00012.
  const index = BANKS.indexOf(label[0]) * 12 + Number(label.slice(1)) % 12;
  return `PTN${String(index).padStart(5, '0')}.BIN`;
}

/** Create a complete, ordered matrix; bytes and summaries are added only for occupied slots. */
function emptyPatternSlots() {
  return Object.fromEntries(BANKS.flatMap((bank) => Array.from({ length: 12 }, (_, i) => {
    const label = `${bank}${i + 1}`;
    return [label, { label, filename: patternFilename(label) }];
  })));
}

/**
 * Suggest a lossless map in ascending MIDI pitch order. C1–B1 retain their drum-rack pad positions.
 * The caller supplies the starting bank from the import destination or the user's explicit group choice.
 * Other notes fill remaining positions, spilling into subsequent banks for more than twelve pitches.
 */
function suggestNoteMap(notes, bank, layout = 'drum') {
  if (!BANKS.includes(bank)) throw new Error('Select a sample bank A–J.');
  const pitches = [...new Set(notes)].sort((a, b) => a - b);
  const order = layout === 'drum' ? DRUM_PAD_ORDER : Array.from({ length: 12 }, (_, i) => i + 1);
  const map = {};
  const used = new Set();
  if (layout === 'drum') {
    for (const note of pitches) {
      if (note >= 36 && note < 48) {
        map[note] = `${bank}${order[note - 36]}`;
        used.add(map[note]);
      }
    }
  }
  const candidates = BANKS.map((_, i) => BANKS[(BANKS.indexOf(bank) + i) % BANKS.length])
    .flatMap((letter) => order.map((pad) => `${letter}${pad}`)).filter((pad) => !used.has(pad));
  for (const note of pitches) {
    if (map[note]) continue;
    const pad = candidates.shift();
    if (!pad) throw new Error('The MIDI uses more than 120 distinct notes.');
    map[note] = pad;
  }
  return map;
}

/** Require a complete one-to-one map so MIDI export can reconstruct each imported pitch. */
function validateNoteMap(notes, map) {
  const assigned = new Set();
  for (const note of notes) {
    if (!Number.isInteger(note) || note < 0 || note > 127) throw new Error('MIDI notes must be integers from 0 to 127.');
    const pad = map[note];
    if (!/^[A-J](?:[1-9]|1[0-2])$/.test(pad || '')) throw new Error(`Assign a sample pad to ${noteName(note)} (${note}).`);
    if (assigned.has(pad)) throw new Error(`${pad} is assigned more than once. Choose a unique pad for every note.`);
    assigned.add(pad);
  }
}

module.exports = { BANKS, DRUM_PAD_ORDER, noteName, patternFilename, emptyPatternSlots, suggestNoteMap, validateNoteMap };
