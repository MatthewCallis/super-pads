const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { createCard } = require('./helpers');

/** Load an isolated encoder with a controlled process or binary path, leaving shared module caches untouched. */
function loadEncoder(spawnProcess, binaryPath = require('ffmpeg-static-electron').path) {
  const filename = path.join(__dirname, '..', 'src', 'encodeAudio.js');
  const requireFromEncoder = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, Buffer,
    require(name) {
      if (name === 'node:child_process') return { spawn: spawnProcess };
      if (name === 'ffmpeg-static-electron') return { path: binaryPath };
      return requireFromEncoder(name);
    },
  }, { filename });
  return module.exports;
}

/** Expose exit and close independently so tests can hold output and diagnostics open after exit. */
function controlledProcess() {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  return child;
}

test('encoder waits for process close and passes unpacked executable and literal paths', async (t) => {
  const card = await createCard({ prefix: 'super-pads-ffmpeg-é ; ' });
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const destination = path.join(card.root, 'converted ; sample.wav');
  const temporary = `${destination}.ffmpeg.wav`;
  const child = controlledProcess();
  const started = Promise.withResolvers();
  const encodeAudio = loadEncoder((command, args, options) => {
    assert.equal(command, '/Applications/Super Pads.app/Contents/Resources/app.asar.unpacked/ffmpeg');
    assert.ok(args.includes(card.file));
    assert.equal(args.at(-1), temporary);
    assert.equal(options.shell, undefined);
    assert.equal(options.windowsHide, true);
    started.resolve();
    return child;
  }, '/Applications/Super Pads.app/Contents/Resources/app.asar/ffmpeg');
  let settled = false;
  const conversion = encodeAudio(card.file, destination, { label: 'A1', channels: 'Mono' });
  conversion.then(() => { settled = true; }, () => { settled = true; });
  await started.promise;
  fs.writeFileSync(temporary, 'incomplete WAV');
  child.emit('exit', 0, null);
  await new Promise(setImmediate);
  assert.equal(settled, false);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(temporary), true);
  // Final output can still arrive before close; parsing at exit would read the incomplete fixture.
  fs.copyFileSync(card.file, temporary);
  child.stderr.end();
  child.emit('close', 0, null);
  const result = await conversion;
  assert.equal(result.size, fs.statSync(destination).size);
  assert.equal(fs.existsSync(temporary), false);
});

for (const [code, signal, reason] of [
  [1, null, /ffmpeg exited with code 1/],
  [null, 'SIGTERM', /ffmpeg was killed with signal SIGTERM/],
]) {
  test(`encoder preserves destination and cleans temporary output on ${signal || `exit ${code}`}`, async (t) => {
    const card = await createCard();
    t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
    const destination = path.join(card.root, 'existing.wav');
    const temporary = `${destination}.ffmpeg.wav`;
    fs.writeFileSync(destination, 'existing sample');
    const child = controlledProcess();
    const started = Promise.withResolvers();
    const encodeAudio = loadEncoder(() => { started.resolve(); return child; });
    const conversion = encodeAudio(card.file, destination, { label: 'A1', channels: 'Stereo' });
    await started.promise;
    fs.writeFileSync(temporary, 'partial output');
    child.stderr.write(`discarded-prefix${'x'.repeat(80 * 1024)}`);
    child.emit('exit', code, signal);
    child.stderr.end('\nfinal FFmpeg diagnostic\n');
    child.emit('close', code, signal);
    await assert.rejects(conversion, (error) => {
      assert.match(error.message, reason);
      assert.match(error.message, /final FFmpeg diagnostic$/);
      assert.ok(!error.message.includes('discarded-prefix'));
      assert.ok(error.message.length < 66 * 1024);
      return true;
    });
    assert.equal(fs.readFileSync(destination, 'utf8'), 'existing sample');
    assert.equal(fs.existsSync(temporary), false);
  });
}

test('encoder preserves a spawn error and waits for close before cleanup', async (t) => {
  const card = await createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const destination = path.join(card.root, 'converted.wav');
  const temporary = `${destination}.ffmpeg.wav`;
  const child = controlledProcess();
  const started = Promise.withResolvers();
  const encodeAudio = loadEncoder(() => { started.resolve(); return child; });
  const conversion = encodeAudio(card.file, destination, { label: 'A1', channels: 'Mono' });
  await started.promise;
  fs.writeFileSync(temporary, 'partial output');
  const spawnError = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
  child.emit('error', spawnError);
  await new Promise(setImmediate);
  assert.equal(fs.existsSync(temporary), true);
  child.stderr.end();
  child.emit('close', -1, null);
  await assert.rejects(conversion, (error) => error === spawnError);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(temporary), false);
});

test('encoder rejects a missing executable using the real spawn error event', async (t) => {
  const card = await createCard();
  t.after(() => fs.rmSync(card.root, { recursive: true, force: true }));
  const destination = path.join(card.root, 'converted.wav');
  const encodeAudio = loadEncoder(spawn, path.join(card.root, 'missing-ffmpeg'));
  await assert.rejects(encodeAudio(card.file, destination, { label: 'A1', channels: 'Mono' }), { code: 'ENOENT' });
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(`${destination}.ffmpeg.wav`), false);
});
