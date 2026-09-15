const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, dialog, shell } = require('electron');
const { AudioWAV } = require('@uttori/audio-wave');
const { createCard } = require('../test/helpers');

// An optional app.asar path runs the same checks against a packaged application's resources.
let appRoot = path.join(__dirname, '..');
if (process.argv[2]) appRoot = path.resolve(process.argv[2]);
const card = createCard();
const externalURLs = [];
const rendererErrors = [];
let finished = false;

// Isolate the single-instance lock and profile, and keep dialogs/browser launches inside the fixture.
app.setPath('userData', path.join(card.root, 'profile'));
fs.copyFileSync(card.file, path.join(card.directory, 'A0000001.WAV'));
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
  const evaluate = (source) => contents.executeJavaScript(source, true);
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

  // A File constructed in JavaScript has no disk path. CDP supplies a real file-backed File.
  contents.debugger.attach('1.3');
  await evaluate('const input = document.createElement("input"); input.type = "file"; input.id = "smoke-file"; document.body.append(input)');
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
  assert.deepEqual(rendererErrors, []);
  console.log(`Electron ${process.versions.electron}: startup, links, 120 pads, audio preview, waveform, file drop, and conversion passed.`);
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

setTimeout(() => finish(new Error('Electron smoke test exceeded 45 seconds.')), 45000).unref();
process.on('unhandledRejection', finish);
process.on('uncaughtException', finish);
require(path.join(appRoot, 'src', 'main.js'));
