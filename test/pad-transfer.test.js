const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createCard } = require('./helpers');
const { decodePads } = require('../src/padMetadata');
const { canDragPad, transferPads } = require('../src/padTransfer');
const writeCard = require('../src/writeCard');

/** Load a complete fixture snapshot with the same file-presence information as the renderer's worker. */
function snapshot(card) {
  const pads = decodePads(fs.readFileSync(path.join(card.directory, 'PAD_INFO.BIN')));
  for (const pad of pads) pad.samplePresent = fs.existsSync(path.join(card.directory, pad.filename));
  return { pads: Object.fromEntries(pads.map((pad) => [pad.label, pad])) };
}

/** Queue an import; the existing card bytes stay unchanged until writeCard commits. */
function importPad(state, label, file) {
  Object.assign(state.pads[label], { convert: true, externalFile: file, avaliable: false, channels: 'Stereo' });
}

/** Compare the entire relocated WAV, allowing only the destination's Roland sample index to differ. */
function expectedWave(original, sampleIndex) {
  const wave = Buffer.from(original);
  wave[wave.indexOf('RLND') + 20] = sampleIndex;
  return wave;
}

test('cross-bank swaps preserve both WAVs and settings, changing only their Roland identities', async (t) => {
  const card = createCard();
  const other = createCard({ seconds: 0.2 });
  t.after(() => {
    fs.rmSync(card.root, { recursive: true, force: true });
    fs.rmSync(other.root, { recursive: true, force: true });
  });
  let state = snapshot(card);
  importPad(state, 'A1', card.file);
  importPad(state, 'J12', other.file);
  await writeCard({ root: card.root, state });
  state = snapshot(card);
  Object.assign(state.pads.A1, { volume: 37, userSampleStart: 712, reverse: true, targetChannels: undefined });
  Object.assign(state.pads.J12, { volume: 58, loop: true });
  const a = fs.readFileSync(path.join(card.directory, state.pads.A1.filename));
  const j = fs.readFileSync(path.join(card.directory, state.pads.J12.filename));
  assert.equal(transferPads(state.pads, 'A1', 'J12'), true);
  assert.equal(state.pads.J12.volume, 37);
  assert.equal(state.pads.A1.volume, 58);
  assert.equal(state.pads.J12.sourceFilename, 'A0000001.WAV');
  assert.deepEqual(fs.readFileSync(path.join(card.directory, state.pads.A1.filename)), a);
  const { pads } = await writeCard({ root: card.root, state });
  assert.deepEqual(fs.readFileSync(path.join(card.directory, 'J0000012.WAV')), expectedWave(a, 119));
  assert.deepEqual(fs.readFileSync(path.join(card.directory, 'A0000001.WAV')), expectedWave(j, 0));
  const moved = pads.find((pad) => pad.label === 'J12');
  assert.equal(moved.userSampleStart, 712);
  assert.equal(moved.reverse, true);
  assert.equal(moved.volume, 37);
  assert.equal(moved.sourceFilename, undefined);
  assert.equal(moved.relocated, undefined);
});

test('repeated moves retain the original disk source and commit empty intermediate slots', async (t) => {
  const card = createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  let state = snapshot(card);
  importPad(state, 'A10', card.file);
  await writeCard({ root: card.root, state });
  state = snapshot(card);
  const before = fs.readFileSync(path.join(card.directory, state.pads.A10.filename));
  transferPads(state.pads, 'A10', 'C4');
  transferPads(state.pads, 'C4', 'J12');
  assert.equal(canDragPad(state.pads.A10), false);
  assert.equal(canDragPad(state.pads.C4), false);
  assert.equal(state.pads.J12.sourceFilename, 'A0000010.WAV');
  await writeCard({ root: card.root, state });
  assert.equal(fs.existsSync(path.join(card.directory, 'A0000010.WAV')), false);
  assert.equal(fs.existsSync(path.join(card.directory, 'C0000004.WAV')), false);
  assert.deepEqual(fs.readFileSync(path.join(card.directory, 'J0000012.WAV')), expectedWave(before, 119));
  assert.equal(snapshot(card).pads.A10.avaliable, true);
  assert.equal(snapshot(card).pads.C4.avaliable, true);
});

test('a moved pending import keeps its external source and converts on the final pad', async (t) => {
  const card = createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const state = snapshot(card);
  importPad(state, 'B3', card.file);
  state.pads.B3.volume = 49;
  transferPads(state.pads, 'B3', 'H9');
  assert.equal(state.pads.H9.convert, true);
  assert.equal(state.pads.H9.externalFile, card.file);
  assert.equal(state.pads.H9.sourceFilename, undefined);
  await writeCard({ root: card.root, state });
  assert.equal(fs.existsSync(path.join(card.directory, 'B0000003.WAV')), false);
  const result = snapshot(card).pads.H9;
  assert.equal(result.volume, 49);
  assert.equal(result.avaliable, false);
  assert.equal(result.originalSampleStart, 512);
});

test('pending mono conversion follows the moved sample and translates its trims', async (t) => {
  const card = createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  let state = snapshot(card);
  importPad(state, 'A1', card.file);
  await writeCard({ root: card.root, state });
  state = snapshot(card);
  Object.assign(state.pads.A1, { targetChannels: 'Mono', userSampleStart: 912, userSampleEnd: 4512 });
  transferPads(state.pads, 'A1', 'D2');
  await writeCard({ root: card.root, state });
  const moved = snapshot(card).pads.D2;
  assert.equal(moved.channels, 'Mono');
  assert.equal(moved.userSampleStart, 712);
  assert.equal(moved.userSampleEnd, 2512);
});

test('failed transfer commit restores original files and leaves the move available for retry', async (t) => {
  const card = createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  let state = snapshot(card);
  importPad(state, 'A1', card.file);
  await writeCard({ root: card.root, state });
  state = snapshot(card);
  const original = fs.readFileSync(path.join(card.directory, state.pads.A1.filename));
  const metadata = fs.readFileSync(path.join(card.directory, 'PAD_INFO.BIN'));
  transferPads(state.pads, 'A1', 'J12');
  const rename = fs.renameSync;
  let failed = false;
  const mock = t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === path.join(card.directory, 'PAD_INFO.BIN') && !failed) {
      failed = true;
      throw new Error('Injected transfer commit failure');
    }
    return rename(source, target);
  });
  await assert.rejects(writeCard({ root: card.root, state }), /transfer commit failure/);
  mock.mock.restore();
  assert.deepEqual(fs.readFileSync(path.join(card.directory, 'A0000001.WAV')), original);
  assert.deepEqual(fs.readFileSync(path.join(card.directory, 'PAD_INFO.BIN')), metadata);
  assert.equal(fs.existsSync(path.join(card.directory, 'J0000012.WAV')), false);
  assert.equal(state.pads.J12.sourceFilename, 'A0000001.WAV');
  await writeCard({ root: card.root, state });
  assert.deepEqual(fs.readFileSync(path.join(card.directory, 'J0000012.WAV')), expectedWave(original, 119));
});

test('same-pad, empty, removed, unknown, and untrusted source paths never become transfers', async (t) => {
  const card = createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const state = snapshot(card);
  assert.equal(transferPads(state.pads, 'A1', 'A1'), false);
  assert.equal(transferPads(state.pads, 'A1', 'B1'), false);
  assert.equal(transferPads(state.pads, 'unknown', 'B1'), false);
  importPad(state, 'A1', card.file);
  assert.equal(transferPads(state.pads, 'A1', 'unknown'), false);
  state.pads.A1.remove = true;
  assert.equal(transferPads(state.pads, 'A1', 'B1'), false);
  state.pads.B1.sourceFilename = '../../outside.wav';
  await assert.rejects(writeCard({ root: card.root, state }), /invalid transfer source filename/);
  assert.equal(fs.existsSync(path.join(card.root, '.super-pads-transaction')), false);
});
