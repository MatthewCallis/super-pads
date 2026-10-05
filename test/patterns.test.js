const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createCard } = require('./helpers');
const runWorker = require('../src/runWorker');
const writeCard = require('../src/writeCard');
const { inspectMidi, inspectPattern, midiToPattern, patternToMidi } = require('../src/patternMetadata');
const { readPatterns, PATTERN_DIRECTORY } = require('../src/readPatterns');
const { emptyPatternSlots, suggestNoteMap, validateNoteMap, patternFilename, noteName } = require('../src/patternSlots');

const midiBytes = fs.readFileSync(path.join(__dirname, '..', 'pattern-test', 'future-bap.mid'));
const requestedMap = { 36: 'F9', 37: 'F10', 38: 'F11', 39: 'F12', 40: 'F5', 41: 'F6', 42: 'F7', 43: 'F8' };

/** Compare actual musical events, independent of MIDI track wrappers and native timing placeholders. */
function musicalNotes(summary) {
  return summary.notes.map(({ note, time, length, velocity }) => ({ note, time, length, velocity }));
}

test('future-bap imports with the exact requested F mapping and survives a musical MIDI round-trip', async () => {
  const original = await inspectMidi(midiBytes);
  assert.equal(original.notes.length, 131);
  assert.equal(original.bars, 4);
  assert.equal(noteName(36), 'C1');
  assert.deepEqual(suggestNoteMap(original.pitches, 'F'), requestedMap);
  const bytes = await midiToPattern(midiBytes, requestedMap);
  assert.deepEqual(bytes, fs.readFileSync(path.join(__dirname, '..', 'pattern-test', 'future-bap.bin')));
  // Check hardware fields directly: a symmetric library round-trip can hide an invalid native format.
  const addresses = { 36: 55, 37: 56, 38: 57, 39: 58, 40: 51, 41: 52, 42: 53, 43: 54 };
  const nativeHits = [];
  let time = 0;
  for (let offset = 0; offset < bytes.length - 16; offset += 8) {
    if (bytes[offset + 1] !== 128) {
      nativeHits.push({ time, address: bytes[offset + 1], bank: bytes[offset + 2],
        length: bytes.readUInt16BE(offset + 6), velocity: bytes[offset + 4] });
    }
    time += bytes[offset];
  }
  assert.deepEqual(nativeHits, original.notes.map((note) => ({
    time: Math.round(note.time * 96), address: addresses[note.note], bank: 1,
    length: Math.round((note.time + note.length) * 96) - Math.round(note.time * 96), velocity: note.velocity,
  })));
  assert.equal(time, 4 * 4 * 96);
  assert.equal(bytes[bytes.length - 7], 4);
  const summary = await inspectPattern(bytes);
  assert.equal(summary.bars, 4);
  assert.equal(summary.notes.length, 131);
  assert.deepEqual(new Set(summary.usedPads), new Set(Object.values(requestedMap)));
  const inverse = Object.fromEntries(Object.entries(requestedMap).map(([note, pad]) => [pad, Number(note)]));
  const restored = await inspectMidi(await patternToMidi(bytes, { noteMap: inverse }));
  assert.deepEqual(musicalNotes(restored), musicalNotes(original));
  assert.equal(restored.bars, 4);
});

test('automatic mapping preserves gaps, handles other pitches and banks, and blocks duplicate assignments', () => {
  assert.deepEqual(suggestNoteMap([36, 43], 'C'), { 36: 'C9', 43: 'C8' });
  assert.deepEqual(suggestNoteMap([60, 72], 'B', 'ascending'), { 60: 'B1', 72: 'B2' });
  const pitches = Array.from({ length: 20 }, (_, i) => i + 30);
  const map = suggestNoteMap(pitches, 'F');
  validateNoteMap(pitches, map);
  assert.equal(new Set(Object.values(map)).size, 20);
  assert.ok(Object.values(map).some((pad) => pad.startsWith('G')));
  assert.throws(() => validateNoteMap([36, 37], { 36: 'F9', 37: 'F9' }), /more than once/);
  assert.throws(() => validateNoteMap([36, 37], { 36: 'F9' }), /Assign/);
  assert.throws(() => suggestNoteMap(Array.from({ length: 121 }, (_, i) => i), 'F'), /120/);
});

test('SX file identities include rotated pad 12 without aliasing any of the 120 slots', () => {
  const slots = Object.values(emptyPatternSlots());
  assert.equal(slots.length, 120);
  assert.equal(new Set(slots.map((slot) => slot.filename)).size, 120);
  assert.equal(patternFilename('A12'), 'PTN00000.BIN');
  assert.equal(patternFilename('A1'), 'PTN00001.BIN');
  assert.equal(patternFilename('F1'), 'PTN00061.BIN');
  assert.equal(patternFilename('J11'), 'PTN00119.BIN');
  assert.throws(() => patternFilename('../A1'), /Invalid/);
});

test('card writes persist native bytes and mapping metadata, and sampler edits invalidate saved names/maps', async (t) => {
  const card = await createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const { pads, patterns } = await runWorker('parsePads', card);
  assert.equal(Object.keys(patterns).length, 120);
  const bytes = await midiToPattern(midiBytes, requestedMap);
  Object.assign(patterns.F1, { bytes: Array.from(bytes), name: 'Future Bap', noteMap: requestedMap, bpm: 94, dirty: true });
  const state = { pads: Object.fromEntries(pads.map((pad) => [pad.label, pad])), patterns };
  const result = await writeCard({ root: card.root, state });
  assert.equal(result.patterns.F1.dirty, undefined);
  assert.equal(state.patterns.F1.dirty, true);
  const file = path.join(card.root, PATTERN_DIRECTORY, patterns.F1.filename);
  assert.deepEqual(fs.readFileSync(file), bytes);
  let read = await readPatterns(card.root);
  assert.equal(read.F1.name, 'Future Bap');
  assert.deepEqual(read.F1.noteMap, requestedMap);
  assert.equal(read.F1.bpm, 94);
  const changed = Buffer.from(bytes);
  changed[4] = 99;
  fs.writeFileSync(file, changed);
  read = await readPatterns(card.root);
  assert.equal(read.F1.name, undefined);
  assert.equal(read.F1.noteMap, undefined);
  assert.equal(read.F1.summary.notes[0].velocity, 99);
  fs.writeFileSync(path.join(card.root, PATTERN_DIRECTORY, patterns.F2.filename), Buffer.alloc(17));
  assert.match((await runWorker('parsePads', card)).patterns.F2.error, /complete/);
});

test('a commit failure rolls back replaced patterns together with sample metadata and retains pending edits', async (t) => {
  const card = await createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const directory = path.join(card.root, PATTERN_DIRECTORY);
  fs.mkdirSync(directory);
  const original = await midiToPattern(midiBytes, requestedMap);
  const file = path.join(directory, patternFilename('F1'));
  fs.writeFileSync(file, original);
  const { pads, patterns } = await runWorker('parsePads', card);
  const changed = Array.from(original);
  changed[4] = 66;
  Object.assign(patterns.F1, { bytes: changed, dirty: true });
  pads[0].volume = 50;
  const state = { pads: Object.fromEntries(pads.map((pad) => [pad.label, pad])), patterns };
  const info = path.join(card.directory, 'PAD_INFO.BIN');
  const previousMetadata = fs.readFileSync(info);
  const rename = fs.renameSync;
  let failed = false;
  const mock = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === info && !failed) { failed = true; throw new Error('Injected pattern commit failure'); }
    return rename(source, destination);
  });
  await assert.rejects(writeCard({ root: card.root, state }), /pattern commit failure/);
  mock.mock.restore();
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(fs.readFileSync(info), previousMetadata);
  assert.equal(patterns.F1.dirty, true);
  patterns.F1.remove = true;
  const saved = await writeCard({ root: card.root, state });
  assert.equal(fs.existsSync(file), false);
  assert.equal(saved.patterns.F1.bytes, undefined);
});
