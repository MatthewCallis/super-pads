const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { AudioWAV } = require('@uttori/audio-wave');
const WaveformData = require('waveform-data');
const { createCard } = require('./helpers');

/** Run a browser worker's message contract with real Node dependencies and filesystem I/O. */
function runWorker(name, data) {
  return new Promise((resolve, reject) => {
    const filename = path.join(__dirname, '..', 'src', 'workers', `${name}.js`);
    const context = {
      require: createRequire(filename), Buffer, console, onmessage: null,
      // Browser workers clone messages into the receiver's realm, including object prototypes.
      postMessage: (message) => resolve(structuredClone(message)),
    };
    try {
      vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
      context.onmessage({ data });
    } catch (error) {
      reject(error);
    }
  });
}

test('released audio libraries round-trip all 120 pads and saved state', async (t) => {
  const card = createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const parsed = await runWorker('parsePads', card);
  assert.equal(parsed.pads.length, 120);
  assert.equal(parsed.pads[0].label, 'A1');
  assert.equal(parsed.pads[119].label, 'J12');
  parsed.pads[0].volume = 42;
  parsed.pads[0].userTempo = 123.4;
  parsed.pads[0].channels = 'Mono';
  const encoded = await runWorker('encodePads', { ...card, file: 'PAD_INFO.BIN', pads: parsed.pads });
  assert.equal(encoded.success, true);
  const reread = await runWorker('parsePads', card);
  assert.equal(reread.pads[0].volume, 42);
  assert.equal(reread.pads[0].userTempo, 123.4);
  assert.equal(reread.pads[0].channels, 'Mono');

  const state = { currentPad: 'A1', pads: reread.pads };
  assert.equal((await runWorker('saveState', { ...card, state })).success, true);
  const restored = await runWorker('loadState', card);
  assert.deepEqual(restored.state, state);
});

test('waveform worker produces 8-bit peaks from transferred PCM channels', async () => {
  const samples = new Float32Array(256);
  samples.fill(0.5, 0, 128);
  samples.fill(-0.5, 128);
  const result = await runWorker('renderAudioWaveform', { channels: [samples.buffer], sampleRate: 44100 });
  const waveform = WaveformData.create(result.buffer);
  assert.equal(waveform.length, 2);
  assert.equal(waveform.sample_rate, 44100);
  assert.equal(waveform.bits, 8);
  assert.deepEqual(waveform.channel(0).min_array(), [63, -64]);
  assert.deepEqual(waveform.channel(0).max_array(), [63, -64]);
});

for (const [channels, expectedChannels] of [['Mono', 1], ['Stereo', 2]]) {
  test(`bundled FFmpeg converts ${channels} audio to SP-404SX WAV`, { timeout: 20000 }, async (t) => {
    const card = createCard();
    t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
    const pad = { label: 'B3', filename: 'B0000003.WAV', channels };
    const result = await runWorker('encodeFile', { ...card, pad });
    assert.equal(result.success, true);
    const output = fs.readFileSync(path.join(card.directory, pad.filename));
    const { chunks } = AudioWAV.fromFile(output);
    const format = chunks.find((chunk) => chunk.type === 'format').value;
    assert.equal(format.sampleRate, 44100);
    assert.equal(format.channels, expectedChannels);
    assert.equal(format.bitsPerSample, 16);
    assert.equal(format.audioFormatValue, 1);
    assert.equal(chunks.find((chunk) => chunk.type === 'roland').value.sampleIndex, 14);
    assert.equal(output.indexOf(Buffer.from('data')) + 8, 512);
    assert.equal(output.readUInt32LE(4), output.length - 8);
    assert.equal(result.size, output.length);
    const removed = await runWorker('removeFile', { file: path.join(card.directory, pad.filename), pad });
    assert.equal(removed.success, true);
    assert.equal(fs.existsSync(path.join(card.directory, pad.filename)), false);
  });
}
