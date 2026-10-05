const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inspectMidi, inspectPattern, midiToPattern, patternToMidi } = require('../src/patternMetadata');

/** Native SX footer: marker 0x8c, bars at byte 9, and the default 4/4 meter code. */
function footer(bars) {
  const bytes = Buffer.alloc(16);
  bytes[1] = 140;
  bytes[9] = bars;
  return bytes;
}

test('hardware-recorded SX timing uses following delays and big-endian lengths', async () => {
  // Last hit is at beat 7; interpreting delays before hits incorrectly moves it to beat 8.
  const bytes = Buffer.concat([
    Buffer.from('90470000787c0083f04700007567007d904700007576006d604700007b78006630490000777f002b604800007f7f004c', 'hex'),
    footer(2),
  ]);
  const summary = await inspectPattern(bytes);
  assert.equal(summary.bars, 2);
  assert.deepEqual(summary.notes.map(({ pad, time, length }) => ({ pad, time, ticks: length * 96 })), [
    { pad: 'C1', time: 0, ticks: 131 },
    { pad: 'C1', time: 1.5, ticks: 125 },
    { pad: 'C1', time: 4, ticks: 109 },
    { pad: 'C1', time: 5.5, ticks: 102 },
    { pad: 'C3', time: 6.5, ticks: 43 },
    { pad: 'C2', time: 7, ticks: 76 },
  ]);
});

test('all 120 native sample addresses export and import without crossing banks', async () => {
  const bankStarts = [47, 59, 71, 83, 95, 47, 59, 71, 83, 95];
  const records = [];
  const labels = [];
  const toMidi = {};
  const toPads = {};
  for (let bank = 0; bank < 10; bank++) {
    for (let pad = 1; pad <= 12; pad++) {
      const label = `${String.fromCharCode(65 + bank)}${pad}`;
      const pitch = labels.length;
      labels.push(label);
      toMidi[label] = pitch;
      toPads[pitch] = label;
      let selector = 0;
      if (bank >= 5) selector = 1;
      // Real recordings use both forms of bit 6 for the same sample address.
      if (pad % 2 === 0) selector += 64;
      records.push(Buffer.from([96, bankStarts[bank] + pad - 1, selector, 0, 100, 64, 0, 17]));
    }
  }
  const native = Buffer.concat([...records, footer(30)]);
  const summary = await inspectPattern(native);
  assert.deepEqual(summary.usedPads, labels);
  const midi = await patternToMidi(native, { noteMap: toMidi });
  const restored = await midiToPattern(midi, toPads);
  assert.deepEqual((await inspectPattern(restored)).notes, summary.notes);
  assert.equal(restored[restored.length - 7], 30);
  // Verify emitted fields independently of the app's reader; bit 6 is unnecessary for imported MIDI hits.
  for (let index = 0; index < 120; index++) {
    const offset = index * 8;
    assert.equal(restored[offset], 96);
    assert.equal(restored[offset + 1], records[index][1]);
    assert.equal(restored[offset + 2], records[index][2] & 1);
    assert.equal(restored.readUInt16BE(offset + 6), 17);
  }
});

test('a late first hit and silent footer bars survive MIDI conversion', async () => {
  const native = Buffer.concat([
    Buffer.from([240, 128, 0, 0, 0, 0, 0, 255]),
    Buffer.from([144, 55, 1, 0, 90, 64, 0, 24]),
    footer(4),
  ]);
  const midi = await patternToMidi(native, { noteMap: { F9: 36 } });
  assert.equal((await inspectMidi(midi)).bars, 4);
  const restored = await midiToPattern(midi, { 36: 'F9' });
  assert.equal(restored[1], 128);
  assert.equal(restored[0], 240);
  assert.equal(restored[restored.length - 7], 4);
  assert.deepEqual((await inspectPattern(restored)).notes, [
    { pad: 'F9', time: 2.5, length: 0.25, velocity: 90 },
  ]);
});

test('invalid native SX addresses and footer lengths cannot silently lose notes', async () => {
  for (const [address, selector] of [[115, 0], [106, 2], [46, 1]]) {
    const invalid = Buffer.concat([Buffer.from([96, address, selector, 0, 100, 64, 0, 8]), footer(1)]);
    await assert.rejects(inspectPattern(invalid), /unknown sample pad address/);
    await assert.rejects(patternToMidi(invalid, { noteMap: {} }), /unknown sample pad address/);
  }
  for (const bars of [0, 65]) {
    await assert.rejects(inspectPattern(footer(bars)), /SX pattern bars/);
  }
});
