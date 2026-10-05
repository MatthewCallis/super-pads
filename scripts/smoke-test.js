const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, dialog, shell } = require('electron');
const { AudioWAV } = require('@uttori/audio-wave');
const { AudioPadInfo } = require('@uttori/audio-padinfo');
const { createCard } = require('../test/helpers');

// An optional app.asar path runs the same checks against a packaged application's resources.
let appRoot = path.join(__dirname, '..');
if (process.argv[2]) appRoot = path.resolve(process.argv[2]);
const card = createCard({ seconds: 4, prefix: 'super-pads-#card-' });
const replacement = createCard();
const externalURLs = [];
const rendererErrors = [];
let finished = false;

// Isolate the single-instance lock and profile, and keep dialogs/browser launches inside the fixture.
app.setPath('userData', path.join(card.root, 'profile'));
for (const filename of ['A0000001.WAV', 'A0000002.WAV', 'A0000010.WAV']) {
  fs.copyFileSync(card.file, path.join(card.directory, filename));
}
dialog.showOpenDialog = async (_window, options) => {
  const selected = options.properties.includes('openDirectory') ? card.root : card.file;
  return { canceled: false, filePaths: [selected] };
};
shell.openExternal = async (url) => { externalURLs.push(url); };

/** End the process with a CI-friendly status and remove only this run's temporary card. */
function finish(error) {
  if (finished) return;
  finished = true;
  if (error) {
    console.error(error);
    if (rendererErrors.length > 0) console.error('Renderer errors:', rendererErrors);
  }
  fs.rmSync(card.root, { recursive: true, force: true });
  fs.rmSync(replacement.root, { recursive: true, force: true });
  app.exit(error ? 1 : 0);
}

/** Poll asynchronous UI/worker results for at most ten seconds. */
async function waitFor(check, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}

/** Exercise the actual renderer, IPC, browser workers, file-backed drop, and waveform decoder. */
async function checkWindow(window) {
  const contents = window.webContents;
  const evaluate = async (source) => {
    try { return await contents.executeJavaScript(source, true); }
    catch (error) { throw new Error(`Renderer evaluation failed: ${source.slice(0, 180)}`, { cause: error }); }
  };
  await evaluate(`
    window.smokeErrors = [];
    window.addEventListener('error', (event) => smokeErrors.push(event.message));
    window.addEventListener('unhandledrejection', (event) => smokeErrors.push(String(event.reason)));
    preview.audio.muted = true;
  `);
  assert.equal(await evaluate('typeof require'), 'function');
  assert.equal(await evaluate('document.title'), 'Super Pads');

  await evaluate('document.querySelector("a").click()');
  await waitFor(() => externalURLs.length === 1, 'external link opens in the browser');
  assert.equal(externalURLs[0], 'https://github.com/MatthewCallis/super-pads');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  await evaluate('window.open("file:///tmp/super-pads-denied")');
  await delay(100);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  assert.equal(externalURLs.length, 1);

  await evaluate('document.querySelector("button.choose-folder").click()');
  await waitFor(() => evaluate('document.querySelectorAll(".pad-list .pad").length === 120'), 'SD card parsing');
  await waitFor(() => evaluate('!document.querySelector("button.play").disabled'), 'audio preview decoding');
  await waitFor(() => evaluate('Array.from(document.querySelector("#waveform").getContext("2d").getImageData(0, 0, 240, 78).data).some(value => value !== 0)'), 'waveform rendering');
  assert.equal(await evaluate('document.querySelectorAll(".right select").length'), 0);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.pad-list .pad')).every(pad => {
    const rect = pad.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
  })`), true);

  // A File constructed in JavaScript has no disk path. CDP supplies a real file-backed File.
  contents.debugger.attach('1.3');
  await evaluate('const input = document.createElement("input"); input.type = "file"; input.id = "smoke-file"; input.hidden = true; document.body.append(input)');
  const { root } = await contents.debugger.sendCommand('DOM.getDocument');
  const { nodeId } = await contents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#smoke-file' });
  await contents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [card.file] });
  await evaluate(`
    const transfer = new DataTransfer();
    transfer.items.add(document.querySelector('#smoke-file').files[0]);
    document.querySelector('.left .drop-zone').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer }));
  `);
  assert.equal(await evaluate('document.querySelector("input.original-file").value'), card.file);
  contents.debugger.detach();

  await evaluate(`
    const virtualTransfer = new DataTransfer();
    virtualTransfer.items.add(new File(['audio'], 'virtual.wav'));
    document.querySelector('.left .drop-zone').dispatchEvent(new DragEvent('drop', { dataTransfer: virtualTransfer }));
  `);
  assert.equal(await evaluate('document.querySelector("p.errors").textContent'), 'Drop a file from your computer.');
  assert.equal(await evaluate('document.querySelector("input.original-file").value'), card.file);
  await evaluate('document.querySelector("p.errors").click()');

  const pad = { label: 'B3', filename: 'B0000003.WAV', channels: 'Stereo' };
  const result = await evaluate(`new Promise((resolve, reject) => {
    const worker = new Worker('./src/workers/encodeFile.js');
    worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage(${JSON.stringify({ ...card, pad })});
  })`);
  assert.equal(result.success, true);
  const { chunks } = AudioWAV.fromFile(fs.readFileSync(path.join(card.directory, pad.filename)));
  assert.equal(chunks.find((chunk) => chunk.type === 'format').value.sampleRate, 44100);
  assert.equal(chunks.find((chunk) => chunk.type === 'roland').value.sampleIndex, 14);
  await checkMatrix(evaluate);
  // Opt-in captures let developers inspect the real renderer without retaining fixture files.
  if (process.env.SUPER_PADS_SCREENSHOT) {
    // Let rapid synthetic selections reach the compositor before capturing the final matrix state.
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(process.env.SUPER_PADS_SCREENSHOT, (await contents.capturePage()).toPNG());
  }
  window.setSize(1100, 600);
  assert.equal(await evaluate(`(() => {
    const matrix = document.querySelector('.middle');
    return matrix.scrollHeight > matrix.clientHeight && document.body.scrollWidth === innerWidth;
  })()`), true);
  await evaluate(`document.querySelector('.pad[data-label="J12"]').scrollIntoView({ block: 'nearest' })`);
  assert.equal(await evaluate(`document.querySelector('.pad[data-label="J12"]').getBoundingClientRect().bottom <= innerHeight`), true);
  window.setSize(1480, 680);
  await checkRegressions(contents, evaluate);
  assert.deepEqual(await evaluate('smokeErrors'), []);
  assert.deepEqual(rendererErrors, []);
  console.log(`Electron ${process.versions.electron}: startup, links, all 120 visible pads, cross-bank moves/swaps, direct file drops, audio preview, waveform, full card writes, recovery-related error handling, previews, worker cleanup, and conversion passed.`);
}

/** Exercise the matrix's real drop listeners, selection, pending settings, and drag feedback. */
async function checkMatrix(evaluate) {
  await evaluate(`
    window.smokeDragPad = (sourceLabel, targetLabel) => {
      const source = document.querySelector('.pad[data-label="' + sourceLabel + '"]');
      const target = document.querySelector('.pad[data-label="' + targetLabel + '"]');
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      const highlighted = target.classList.contains('drop-target');
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      source.dispatchEvent(new DragEvent('dragend', { dataTransfer: transfer, bubbles: true }));
      return highlighted;
    };
    const padTransfer = new DataTransfer();
    padTransfer.items.add(document.querySelector('#smoke-file').files[0]);
    document.querySelector('.pad[data-label="J12"]').dispatchEvent(new DragEvent('drop', { dataTransfer: padTransfer }));
  `);
  assert.equal(await evaluate('state.currentPad'), 'J12');
  assert.equal(await evaluate('state.pads.J12.externalFile'), card.file);
  await evaluate(`
    const volume = document.querySelector('input.volume');
    volume.value = 49;
    volume.dispatchEvent(new Event('change'));
    document.querySelector('input.loop-button').click();
  `);
  assert.equal(await evaluate(`smokeDragPad('J12', 'B4')`), true);
  assert.equal(await evaluate('state.currentPad'), 'B4');
  assert.equal(await evaluate('state.pads.B4.convert'), true);
  assert.equal(await evaluate('state.pads.B4.volume'), 49);
  assert.equal(await evaluate('state.pads.B4.loop'), true);
  assert.equal(await evaluate('canDragPad(state.pads.J12)'), false);
  assert.equal(await evaluate(`smokeDragPad('B4', 'A1')`), true);
  assert.equal(await evaluate('state.pads.A1.volume'), 49);
  assert.equal(await evaluate('state.pads.B4.volume'), 127);
  // Restore A1's queued import for the existing regression suite while retaining the new J12 import.
  await evaluate(`smokeDragPad('A1', 'B4'); smokeDragPad('B4', 'J12');`);
  assert.equal(await evaluate('state.pads.A1.volume'), 127);
  assert.equal(await evaluate('state.pads.J12.volume'), 49);
  await evaluate(`document.querySelector('.pad[data-label="A1"] .pad-name').click()`);
  assert.equal(await evaluate('state.currentPad'), 'A1');
  assert.equal(await evaluate('document.querySelectorAll(".pad.selected").length'), 1);
  assert.equal(await evaluate('document.querySelectorAll(".dragging, .drop-target").length'), 0);
  await evaluate(`
    const forged = new DataTransfer();
    forged.setData(PAD_DRAG_TYPE, 'A1');
    document.querySelector('.pad[data-label="C4"]').dispatchEvent(new DragEvent('drop', { dataTransfer: forged }));
  `);
  assert.equal(await evaluate('canDragPad(state.pads.C4)'), false);
}

/** Exercise the audit regressions through real controls, files, asynchronous media, and browser workers. */
async function checkRegressions(contents, evaluate) {
  const info = path.join(card.directory, 'PAD_INFO.BIN');
  const readPads = () => AudioPadInfo.fromFile(fs.readFileSync(info)).pads;
  const readWave = () => fs.readFileSync(path.join(card.directory, 'A0000001.WAV'));
  async function writeCardUI() {
    await evaluate(`document.querySelector('button.write-card').click()`);
    await waitFor(() => evaluate('!busy'), 'card write completes');
  }

  // The preceding real file drop queued A1. Write through the UI, then use the actual mono switch.
  await writeCardUI();
  assert.equal(await evaluate('state.pads.A1.convert'), false);
  assert.equal(readPads()[0].originalSampleStart, 512);
  assert.equal(readPads()[119].volume, 49);
  const beforeMove = readWave();
  await evaluate(`smokeDragPad('A1', 'F6')`);
  assert.equal(await evaluate('previewPath(state.pads.F6)'), path.join(card.directory, 'A0000001.WAV'));
  assert.deepEqual(readWave(), beforeMove);
  await writeCardUI();
  assert.equal(fs.existsSync(path.join(card.directory, 'A0000001.WAV')), false);
  assert.equal(readPads()[65].avaliable, false);
  await evaluate(`smokeDragPad('F6', 'A1')`);
  await writeCardUI();
  assert.deepEqual(readWave(), beforeMove);
  assert.equal(fs.existsSync(path.join(card.directory, 'F0000006.WAV')), false);
  await evaluate(`document.querySelector('input.mono-stereo-button').click()`);
  await writeCardUI();
  assert.equal(readPads()[0].channels, 'Mono');
  assert.equal(AudioWAV.fromFile(readWave()).chunks.find(c => c.type === 'format').value.channels, 1);

  // New imports must reset offsets that were valid only for the longer, previous sample.
  await evaluate(`Object.assign(state.pads.A1, { userSampleStart: 80000 }); setExternalFile(${JSON.stringify(replacement.file)});`);
  await writeCardUI();
  assert.equal(readPads()[0].userSampleStart, 512);
  assert.equal(readPads()[0].userSampleEnd, readWave().length);
  assert.ok(readWave().length < 80000);

  // A failed conversion must neither commit a changed volume nor clear the pending import.
  const previousMetadata = fs.readFileSync(info);
  const previousWave = readWave();
  await evaluate(`setExternalFile(${JSON.stringify(replacement.file)}); state.pads.A1.volume = 37; preview.clear();`);
  fs.unlinkSync(replacement.file);
  await writeCardUI();
  assert.deepEqual(fs.readFileSync(info), previousMetadata);
  assert.deepEqual(readWave(), previousWave);
  assert.equal(await evaluate('state.pads.A1.convert'), true);
  assert.equal(await evaluate('state.pads.A1.volume'), 37);
  assert.ok(await evaluate('document.querySelector("p.errors").textContent.length > 0'));
  // Restore the same source and prove retry uses the retained state.
  fs.copyFileSync(card.file, replacement.file);
  await writeCardUI();
  assert.equal(readPads()[0].volume, 37);
  assert.equal(await evaluate('state.pads.A1.convert'), false);
  await waitFor(() => evaluate('!document.querySelector("button.play").disabled'), 'preview ready after retry');

  await evaluate(`document.querySelector('button.play').click()`);
  await waitFor(() => evaluate('!preview.audio.paused'), 'playback begins');
  await evaluate(`document.querySelector('.bank-a .pad-2').click()`);
  assert.equal(await evaluate('preview.audio.paused'), true);
  await waitFor(() => evaluate('!document.querySelector("button.pause").disabled'), 'second pad ready');
  await evaluate(`document.querySelector('button.pause').click()`);
  assert.equal(await evaluate('preview.audio.paused'), true);
  assert.equal(await evaluate('preview.audio.src.includes("%23card-")'), true);

  // Gate one fetch response to force out-of-order completion, independently of disk speed.
  await evaluate(`
    preview.cache.clear();
    window.smokeDraws = [];
    window.smokeRelease = null;
    window.smokeFetch = window.fetch;
    window.smokeDraw = preview.draw;
    preview.draw = function(waveform) { smokeDraws.push(state.currentPad); return smokeDraw.call(this, waveform); };
    window.fetch = (...args) => {
      const result = smokeFetch(...args);
      if (String(args[0]).endsWith('A0000001.WAV')) {
        return result.then(response => new Promise(resolve => { smokeRelease = () => resolve(response); }));
      }
      return result;
    };
    renderLeft('A1');
  `);
  await waitFor(() => evaluate('smokeRelease !== null'), 'held waveform fetch');
  await evaluate(`renderLeft('A2')`);
  await waitFor(() => evaluate('smokeDraws.length === 1'), 'current waveform drawn');
  await evaluate('smokeRelease()');
  await delay(100);
  assert.deepEqual(await evaluate('smokeDraws'), ['A2']);
  assert.ok(await evaluate('Array.from(preview.cache.values()).every(waveform => waveform.length <= 240)'));
  await evaluate('window.fetch = smokeFetch; preview.draw = smokeDraw; undefined;');

  // Show/hide remains idempotent even when separate layers request the same loading indicator.
  const animation = await evaluate(`(() => {
    hideLoading();
    const raf = window.requestAnimationFrame;
    const cancel = window.cancelAnimationFrame;
    let next = 0;
    const pending = new Map();
    window.requestAnimationFrame = fn => { pending.set(++next, fn); return next; };
    window.cancelAnimationFrame = id => pending.delete(id);
    try {
      showLoading(); showLoading();
      const shown = pending.size;
      hideLoading();
      return { shown, hidden: pending.size, canvases: document.querySelectorAll('.loading canvas').length };
    } finally { window.requestAnimationFrame = raf; window.cancelAnimationFrame = cancel; }
  })()`);
  assert.deepEqual(animation, { shown: 1, hidden: 0, canvases: 0 });

  contents.debugger.attach('1.3');
  for (let index = 0; index < 3; index++) await evaluate('parsePads()');
  await waitFor(async () => {
    const { targetInfos } = await contents.debugger.sendCommand('Target.getTargets');
    return !targetInfos.some(target => target.type === 'worker');
  }, 'all one-shot workers terminate');
  contents.debugger.detach();
  assert.equal(await evaluate('state.pads.A10.size'), fs.statSync(card.file).size);

  // Failed reads keep a visible diagnostic and disable writes instead of accepting a partial card.
  fs.truncateSync(info, 32);
  await evaluate('parsePads()');
  assert.equal(await evaluate('cardReady'), false);
  assert.equal(await evaluate('document.querySelector("button.write-card").disabled'), true);
  assert.match(await evaluate('document.querySelector("p.errors").textContent'), /120 pad records/);
  fs.unlinkSync(info);
  await evaluate('parsePads()');
  assert.match(await evaluate('document.querySelector("p.errors").textContent'), /ENOENT/);
}

app.on('browser-window-created', (_event, window) => {
  window.hide();
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') rendererErrors.push(event.message);
  });
  window.webContents.on('render-process-gone', (_event, details) => finish(new Error(details.reason)));
  window.webContents.once('did-fail-load', (_event, code, description) => finish(new Error(`${code}: ${description}`)));
  window.webContents.once('did-finish-load', () => checkWindow(window).then(() => finish(), finish));
});

setTimeout(() => finish(new Error('Electron smoke test exceeded 90 seconds.')), 90000).unref();
process.on('unhandledRejection', finish);
process.on('uncaughtException', finish);
require(path.join(appRoot, 'src', 'main.js'));
