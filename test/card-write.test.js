const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { AudioWAV } = require('@uttori/audio-wave');
const { createCard } = require('./helpers');
const writeCard = require('../src/writeCard');
const { decodePads } = require('../src/padMetadata');
const { atomicWrite, writeNew } = require('../src/fileStorage');
const { CardTransaction, recoverCard, SAMPLE_DIRECTORY } = require('../src/cardTransaction');

/** Create a complete editor snapshot from the disposable card's metadata. */
function snapshot(card) {
  const pads = decodePads(fs.readFileSync(path.join(card.directory, 'PAD_INFO.BIN')));
  return { root: card.root, pads: Object.fromEntries(pads.map((pad) => [pad.label, pad])) };
}

/** Queue imports using the same pending fields as the renderer. */
function importPad(state, label, file) {
  Object.assign(state.pads[label], { convert: true, externalFile: file, channels: 'Stereo' });
}

test('partial temporary writes preserve existing metadata', (t) => {
  const card = createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const file = path.join(card.directory, 'PAD_INFO.BIN');
  const before = fs.readFileSync(file);
  const original = fs.writeFileSync;
  const mock = t.mock.method(fs, 'writeFileSync', (fd, data, ...args) => {
    original(fd, data.subarray(0, 16), ...args);
    throw new Error('Injected ENOSPC after 16 bytes');
  });
  assert.throws(() => atomicWrite(file, Buffer.alloc(3840)), /ENOSPC/);
  mock.mock.restore();
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(card.directory), ['PAD_INFO.BIN']);
});

test('failed conversion leaves metadata, samples, deletion targets, and pending flags intact', async (t) => {
  const card = createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const state = snapshot(card);
  const before = fs.readFileSync(path.join(card.directory, 'PAD_INFO.BIN'));
  fs.copyFileSync(card.file, path.join(card.directory, state.pads.A3.filename));
  importPad(state, 'A1', card.file);
  importPad(state, 'A2', path.join(card.root, 'missing.wav'));
  state.pads.A1.volume = 37;
  state.pads.A3.remove = true;
  await assert.rejects(writeCard({ root: card.root, state }), /ffmpeg exited/);
  assert.deepEqual(fs.readFileSync(path.join(card.directory, 'PAD_INFO.BIN')), before);
  assert.equal(fs.existsSync(path.join(card.directory, state.pads.A1.filename)), false);
  assert.equal(fs.existsSync(path.join(card.directory, state.pads.A3.filename)), true);
  assert.equal(state.pads.A1.convert, true);
  assert.equal(state.pads.A3.remove, true);
  assert.equal(fs.existsSync(path.join(card.root, '.super-pads-transaction')), false);
  // The successful peer has finished before failure returns: no late writes recreate staging.
  assert.equal(fs.existsSync(path.join(card.root, 'super-pads.json')), false);
});

test('mono conversion changes WAV channels and translates existing trim offsets', async (t) => {
  const card = createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  let state = snapshot(card);
  importPad(state, 'A1', card.file);
  await writeCard({ root: card.root, state });
  state = snapshot(card);
  Object.assign(state.pads.A1, { targetChannels: 'Mono', userSampleStart: 912, userSampleEnd: 4512 });
  await writeCard({ root: card.root, state });
  const result = snapshot(card).pads.A1;
  const wave = fs.readFileSync(path.join(card.directory, result.filename));
  const format = AudioWAV.fromFile(wave).chunks.find((chunk) => chunk.type === 'format').value;
  assert.equal(format.channels, 1);
  assert.equal(result.channels, 'Mono');
  assert.equal(result.userSampleStart, 712);
  assert.equal(result.userSampleEnd, 2512);
  assert.equal(result.originalSampleEnd, wave.length);
});

test('new imports reset both trim ranges to the replacement payload', async (t) => {
  const card = createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const state = snapshot(card);
  Object.assign(state.pads.A1, {
    originalSampleStart: 80000, originalSampleEnd: 100000,
    userSampleStart: 90000, userSampleEnd: 95000,
  });
  importPad(state, 'A1', card.file);
  await writeCard({ root: card.root, state });
  const result = snapshot(card).pads.A1;
  const size = fs.statSync(path.join(card.directory, result.filename)).size;
  assert.equal(result.originalSampleStart, 512);
  assert.equal(result.userSampleStart, 512);
  assert.equal(result.originalSampleEnd, size);
  assert.equal(result.userSampleEnd, size);
});

test('commit failure restores changed samples and metadata and preserves retry state', async (t) => {
  const card = createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const state = snapshot(card);
  const sample = path.join(card.directory, state.pads.A1.filename);
  const deleted = path.join(card.directory, state.pads.A3.filename);
  fs.copyFileSync(card.file, sample);
  fs.copyFileSync(card.file, deleted);
  const previousSample = fs.readFileSync(sample);
  state.pads.A3.remove = true;
  importPad(state, 'A1', card.file);
  const file = path.join(card.directory, 'PAD_INFO.BIN');
  const before = fs.readFileSync(file);
  const rename = fs.renameSync;
  let failed = false;
  const mock = t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === file && !failed) { failed = true; throw new Error('Injected commit failure'); }
    return rename(source, target);
  });
  await assert.rejects(writeCard({ root: card.root, state }), /commit failure/);
  mock.mock.restore();
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readFileSync(sample), previousSample);
  assert.deepEqual(fs.readFileSync(deleted), previousSample);
  assert.equal(state.pads.A1.convert, true);
});

test('deletion commits an empty pad without changing its identity or other samples', async (t) => {
  const card = createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  let state = snapshot(card);
  importPad(state, 'B3', card.file);
  importPad(state, 'A1', card.file);
  await writeCard({ root: card.root, state });
  state = snapshot(card);
  const before = fs.readFileSync(path.join(card.directory, state.pads.A1.filename));
  state.pads.B3.remove = true;
  const result = await writeCard({ root: card.root, state });
  const removed = result.pads.find((pad) => pad.label === 'B3');
  assert.equal(removed.filename, 'B0000003.WAV');
  assert.equal(removed.avaliable, true);
  assert.equal(removed.remove, false);
  assert.equal(fs.existsSync(path.join(card.directory, removed.filename)), false);
  assert.deepEqual(fs.readFileSync(path.join(card.directory, state.pads.A1.filename)), before);
});

test('reopening an interrupted commit restores backups and can retry interrupted recovery', (t) => {
  const card = createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const file = path.join(card.directory, 'PAD_INFO.BIN');
  const before = fs.readFileSync(file);
  const tx = new CardTransaction(card.root);
  writeNew(tx.stage(`${SAMPLE_DIRECTORY}/PAD_INFO.BIN`), Buffer.alloc(3840));
  writeNew(tx.stage('super-pads.json'), '{}');
  const rename = fs.renameSync;
  let mock = t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === path.join(card.root, 'super-pads.json')) throw new Error('Simulated interruption');
    return rename(source, target);
  });
  assert.throws(() => tx.commit(), /interruption/);
  mock.mock.restore();
  assert.notDeepEqual(fs.readFileSync(file), before);
  mock = t.mock.method(fs, 'renameSync', () => { throw new Error('Recovery interrupted'); });
  assert.throws(() => recoverCard(card.root), /Recovery interrupted/);
  mock.mock.restore();
  recoverCard(card.root);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(card.root, 'super-pads.json')), false);
});

test('interrupted cleanup never rolls back a committed card', (t) => {
  const card = createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const tx = new CardTransaction(card.root);
  writeNew(tx.stage('super-pads.json'), '{"saved":true}');
  const remove = fs.rmSync;
  const mock = t.mock.method(fs, 'rmSync', (file, options) => {
    if (file.endsWith('-complete') && fs.existsSync(file)) throw new Error('Cleanup interrupted');
    return remove(file, options);
  });
  assert.match(tx.commit(), /Saved successfully/);
  mock.mock.restore();
  recoverCard(card.root);
  assert.equal(fs.readFileSync(path.join(card.root, 'super-pads.json'), 'utf8'), '{"saved":true}');
});
