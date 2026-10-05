const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const loadDataTools = require('../src/dataTools');
const { decodePads, encodePads } = require('../src/padMetadata');
const { patternToMidi, midiToPattern, inspectPattern } = require('../src/patternMetadata');
const runWorker = require('../src/runWorker');
const { createCard } = require('./helpers');

/** Hand-authored OEM default record keeps the compatibility check independent of the new encoder. */
function defaultMetadata() {
  const record = Buffer.from('000002000000020000000200000002007f00000100010200000004b0000004b0', 'hex');
  return Buffer.concat(Array.from({ length: 120 }, () => record));
}

/** SX pattern crossing into banks G and J, with a long silent gap and a complete two-bar duration. */
function patternBytes() {
  const footer = Buffer.alloc(16);
  footer[1] = 140;
  footer[9] = 2;
  return Buffer.concat([
    Buffer.from([255, 47, 0, 0, 99, 64, 0, 96]),
    Buffer.from([225, 128, 0, 0, 0, 0, 0, 0]),
    Buffer.from([96, 59, 1, 0, 79, 64, 0, 48]),
    Buffer.from([192, 106, 65, 0, 127, 64, 0, 24]),
    footer,
  ]);
}

test('v5 pad parser preserves OEM bytes and tenths-of-BPM settings', async () => {
  const data = defaultMetadata();
  const pads = await decodePads(data);
  assert.equal(pads[0].label, 'A1');
  assert.equal(pads[119].label, 'J12');
  assert.deepEqual(await encodePads(pads), data);
  Object.assign(pads[119], { volume: 42, channels: 'Mono', userTempo: 123.4, tempoMode: 'User', reverse: true });
  const output = await encodePads(pads);
  const last = (await decodePads(output))[119];
  assert.equal(output.readUInt32BE(119 * 32 + 28), 1234);
  assert.equal(last.userTempo, 123.4);
  assert.equal(last.channels, 'Mono');
  assert.equal(last.tempoMode, 'User');
  assert.equal(last.reverse, true);
});

test('v5 field validation rejects damaged flags, volume, tempo mode and wrapping offsets', async () => {
  for (const [offset, value, message] of [[17, 2, /invalid lofi/], [16, 128, /Volume/], [23, 3, /Tempo Mode/]]) {
    const data = defaultMetadata();
    data[offset] = value;
    await assert.rejects(decodePads(data), message);
  }
  const pads = await decodePads(defaultMetadata());
  pads[0].originalSampleEnd = 0x100000000;
  await assert.rejects(encodePads(pads), /sample offsets/);
  pads[0].originalSampleEnd = 512;
  pads[0].userTempo = Infinity;
  await assert.rejects(encodePads(pads), /Tempo/);
});

test('real Node workers parse, save and reject metadata without replacing previous bytes', async (t) => {
  const card = await createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const { pads } = await runWorker('parsePads', card);
  pads[0].volume = 53;
  await runWorker('encodePads', { ...card, file: 'PAD_INFO.BIN', pads });
  assert.equal((await runWorker('parsePads', card)).pads[0].volume, 53);
  const file = path.join(card.directory, 'PAD_INFO.BIN');
  const before = fs.readFileSync(file);
  pads[0].volume = 128;
  await assert.rejects(runWorker('encodePads', { ...card, file: 'PAD_INFO.BIN', pads }), /Volume/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('SX MIDI round-trip preserves native bank mapping, following delays and big-endian note durations', async () => {
  const { AudioMIDI } = await loadDataTools();
  const original = patternBytes();
  const midiBytes = await patternToMidi(original, { noteMap: { A1: 36, G1: 42, J12: 46 }, ppq: 480, bpm: 123.4 });
  assert.equal(midiBytes.subarray(0, 4).toString(), 'MThd');
  const midi = new AudioMIDI(midiBytes);
  midi.parse();
  assert.equal(midi.timeDivision, 480);
  const events = midi.chunks.flatMap((chunk) => chunk.events);
  const notes = events.filter((event) => event.type === 0x90 && event.data.velocity > 0);
  assert.deepEqual(notes.map((event) => event.data.note), [36, 42, 46]);
  assert.deepEqual(notes.map((event) => event.data.length), [480, 240, 120]);
  assert.ok(events.some((event) => event.metaType === 0x51));
  const restored = await midiToPattern(midiBytes, { 36: 'A1', 42: 'G1', 46: 'J12' });
  assert.deepEqual((await inspectPattern(restored)).notes, [
    { pad: 'A1', time: 0, length: 1, velocity: 99 },
    { pad: 'G1', time: 5, length: 0.5, velocity: 79 },
    { pad: 'J12', time: 6, length: 0.25, velocity: 127 },
  ]);
  assert.equal(restored[restored.length - 7], 2);
});

test('pattern worker returns owned output bytes and reports incomplete maps and malformed input', async () => {
  const original = patternBytes();
  const midi = await runWorker('convertPattern', {
    direction: 'midi', buffer: original, options: { noteMap: { A1: 36, G1: 42, J12: 46 } },
  });
  assert.ok(midi.buffer instanceof ArrayBuffer);
  assert.equal(Buffer.from(midi.buffer).subarray(0, 4).toString(), 'MThd');
  const restored = await runWorker('convertPattern', {
    direction: 'pattern', buffer: midi.buffer, options: { noteMap: { 36: 'A1', 42: 'G1', 46: 'J12' } },
  });
  assert.deepEqual((await inspectPattern(restored.buffer)).usedPads, ['A1', 'G1', 'J12']);
  await assert.rejects(patternToMidi(original, { noteMap: { A1: 36 } }), /No MIDI note mapping for G1/);
  await assert.rejects(midiToPattern(midi.buffer, { 36: 'A1' }), /mapping|mapped/i);
  await assert.rejects(runWorker('convertPattern', { direction: 'midi', buffer: Buffer.alloc(17), options: { noteMap: {} } }), /complete/);
  await assert.rejects(runWorker('convertPattern', { direction: 'other' }), /direction/);
});
