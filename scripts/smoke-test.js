const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, dialog, shell } = require('electron');
const loadDataTools = require('../src/dataTools');
const { createCard } = require('../test/helpers');

// An optional app.asar path runs the same checks against a packaged application's resources.
let appRoot = path.join(__dirname, '..');
if (process.argv[2]) appRoot = path.resolve(process.argv[2]);
let card;
let replacement;
let SP404PadInfo;
let AudioWAV;
const externalURLs = [];
const rendererErrors = [];
let finished = false;
let patternImportFile = path.join(__dirname, '..', 'test', 'fixtures', 'future-bap.mid');
/** Cancel only the next sample/card picker so both startup and queued edits can be checked. */
let cancelNextPicker = false;
/** Gate the native picker reply so loading/cancellation can be checked while the user is still choosing. */
let holdPatternPicker = false;
let releasePatternPicker;

// Keep dialogs/browser launches inside the fixtures created before the app starts.
dialog.showOpenDialog = async (_window, options) => {
  if (cancelNextPicker) {
    cancelNextPicker = false;
    return { canceled: true, filePaths: [] };
  }
  let selected = card.file;
  if (options.properties.includes('openDirectory')) selected = card.root;
  else if (options.title === 'Import MIDI or SX Pattern') {
    if (holdPatternPicker) return new Promise((resolve) => { releasePatternPicker = resolve; });
    selected = patternImportFile;
  }
  return { canceled: false, filePaths: [selected] };
};
dialog.showSaveDialog = async (_window, options) => ({
  canceled: false, filePath: path.join(card.root, options.title === 'Export MIDI' ? 'pattern-export.mid' : 'pattern-export.bin'),
});
shell.openExternal = async (url) => { externalURLs.push(url); };

/** End the process with a CI-friendly status and remove only this run's temporary card. */
function finish(error) {
  if (finished) return;
  finished = true;
  if (error) {
    console.error(error);
    if (rendererErrors.length > 0) console.error('Renderer errors:', rendererErrors);
  }
  if (card) fs.rmSync(card.root, { recursive: true, force: true });
  if (replacement) fs.rmSync(replacement.root, { recursive: true, force: true });
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

/** Wait for the real IPC reply and verify that canceling a picker preserves the complete editor snapshot. */
async function checkPickerCancellation(evaluate, selector, channel) {
  const previous = await evaluate('JSON.stringify(state)');
  cancelNextPicker = true;
  await evaluate(`new Promise(resolve => {
    ipcRenderer.once(${JSON.stringify(channel)}, () => resolve());
    document.querySelector(${JSON.stringify(selector)}).click();
  })`);
  assert.equal(await evaluate('JSON.stringify(state)'), previous);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("p.errors")).display'), 'none');
}

/** Exercise the actual renderer, IPC, Node conversion threads, browser previews, and file-backed drop. */
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
  await checkPatternConversion(evaluate);

  await evaluate('document.querySelector("a").click()');
  await waitFor(() => externalURLs.length === 1, 'external link opens in the browser');
  assert.equal(externalURLs[0], 'https://github.com/MatthewCallis/super-pads');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  await evaluate('window.open("file:///tmp/super-pads-denied")');
  await delay(100);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  assert.equal(externalURLs.length, 1);

  await checkPickerCancellation(evaluate, 'button.choose-folder', 'pickSDCard-task-finished');
  await evaluate('document.querySelector("button.choose-folder").click()');
  await waitFor(async () => {
    const error = await evaluate('document.querySelector("p.errors").textContent');
    if (error) throw new Error(`SD card parsing failed: ${error}`);
    return evaluate('document.querySelectorAll(".pad-list .pad").length === 120');
  }, 'SD card parsing');
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
  const result = await evaluate(`runWorker('encodeFile', ${JSON.stringify({ ...card, pad })})`);
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
  window.setSize(1480, 760);
  await checkPatterns(contents, evaluate);
  await checkRegressions(contents, evaluate);
  assert.deepEqual(await evaluate('smokeErrors'), []);
  assert.deepEqual(rendererErrors, []);
  console.log(`Electron ${process.versions.electron}: startup, all 120 pads, transfers, audio preview, card recovery, Patterns tabs/matrix/timeline, future-bap assignment, MIDI/native import/export, save/reopen, and conversion passed.`);
}

/** Exercise pattern controls and native dialogs against the repository MIDI fixture, without touching a real card. */
async function checkPatterns(contents, evaluate) {
  const window = BrowserWindow.fromWebContents(contents);
  await evaluate(`document.querySelector('#patterns-tab').click()`);
  assert.equal(await evaluate(`document.querySelector('#pads-panel').hidden`), true);
  assert.equal(await evaluate(`document.querySelector('#patterns-tab').getAttribute('aria-selected')`), 'true');
  assert.equal(await evaluate(`document.querySelectorAll('.pattern-pad').length`), 120);
  await evaluate(`document.querySelector('.pattern-pad[data-slot="F1"]').click()`);
  holdPatternPicker = true;
  await evaluate(`document.querySelector('.import-pattern').click()`);
  await waitFor(() => Boolean(releasePatternPicker), 'native pattern picker is waiting');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.loading')).display`), 'none');
  releasePatternPicker({ canceled: true, filePaths: [] });
  releasePatternPicker = undefined;
  await waitFor(() => evaluate('!busy'), 'canceled pattern picker finishes');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.loading')).display`), 'none');
  assert.equal(await evaluate(`state.patterns.F1.bytes`), undefined);
  assert.equal(await evaluate(`document.querySelector('.pattern-mapping').open`), false);

  // Hold the selected file read so the progress indicator can be observed independently of disk speed.
  await evaluate(`
    window.smokePatternReadFile = require('node:fs/promises').readFile;
    window.smokeReleasePatternRead = null;
    require('node:fs/promises').readFile = async (...args) => {
      await new Promise(resolve => { smokeReleasePatternRead = resolve; });
      return smokePatternReadFile(...args);
    };
    undefined;
  `);
  await evaluate(`document.querySelector('.import-pattern').click()`);
  await waitFor(() => Boolean(releasePatternPicker), 'native picker waits before selection');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.loading')).display`), 'none');
  holdPatternPicker = false;
  releasePatternPicker({ canceled: false, filePaths: [patternImportFile] });
  releasePatternPicker = undefined;
  await waitFor(() => evaluate('smokeReleasePatternRead !== null'), 'selected pattern file read begins');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.loading')).display`), 'block');
  await evaluate(`
    require('node:fs/promises').readFile = smokePatternReadFile;
    smokeReleasePatternRead();
  `);
  await waitFor(() => evaluate(`document.querySelector('.pattern-mapping').open`), 'MIDI assignment dialog');
  window.setSize(1100, 600);
  await waitFor(() => evaluate('innerWidth === 1100'), 'minimum-window pattern layout');
  assert.equal(await evaluate(`document.querySelector('.confirm-mapping').getBoundingClientRect().bottom <= innerHeight`), true);
  assert.equal(await evaluate(`document.body.scrollWidth === innerWidth`), true);
  window.setSize(1480, 760);
  await waitFor(() => evaluate('innerWidth === 1480'), 'restored pattern layout');
  assert.equal(await evaluate(`document.querySelectorAll('.mapping-rows tr').length`), 8);
  assert.deepEqual(await evaluate(`patternPanel.pending.map`), {
    36: 'F9', 37: 'F10', 38: 'F11', 39: 'F12', 40: 'F5', 41: 'F6', 42: 'F7', 43: 'F8',
  });
  await evaluate(`document.querySelector('.cancel-mapping').click()`);
  await waitFor(() => evaluate(`!patternPanel.pending`), 'assignment cancellation');
  assert.equal(await evaluate(`state.patterns.F1.bytes`), undefined);

  // Import defaults belong to the selected pattern bank, even after a different bank's dialog was opened.
  await evaluate(`document.querySelector('.pattern-pad[data-slot="C3"]').click(); document.querySelector('.import-pattern').click()`);
  await waitFor(() => evaluate(`document.querySelector('.pattern-mapping').open`), 'bank C MIDI assignment');
  assert.equal(await evaluate(`document.querySelector('.mapping-bank').value`), 'C');
  assert.deepEqual(await evaluate(`patternPanel.pending.map`), {
    36: 'C9', 37: 'C10', 38: 'C11', 39: 'C12', 40: 'C5', 41: 'C6', 42: 'C7', 43: 'C8',
  });
  await evaluate(`
    const group = document.querySelector('.mapping-bank');
    group.value = 'J'; group.dispatchEvent(new Event('change'));
    const layout = document.querySelector('.mapping-layout');
    layout.value = 'ascending'; layout.dispatchEvent(new Event('change'));
  `);
  assert.equal(await evaluate(`patternPanel.pending.map[36]`), 'J1');
  await evaluate(`document.querySelector('.cancel-mapping').click()`);
  await waitFor(() => evaluate(`!patternPanel.pending`), 'bank C assignment cancellation');
  await evaluate(`document.querySelector('.pattern-pad[data-slot="F1"]').click()`);
  await evaluate(`document.querySelector('.import-pattern').click()`);
  await waitFor(() => evaluate(`document.querySelector('.pattern-mapping').open`), 'second MIDI assignment');
  assert.equal(await evaluate(`document.querySelector('.mapping-bank').value`), 'F');
  assert.equal(await evaluate(`document.querySelector('.mapping-layout').value`), 'drum');
  await evaluate(`
    const assignment = document.querySelector('.mapping-rows select[data-source="36"]');
    assignment.value = 'F10'; assignment.dispatchEvent(new Event('change'));
  `);
  assert.equal(await evaluate(`document.querySelector('.confirm-mapping').disabled`), true);
  assert.match(await evaluate(`document.querySelector('.mapping-validation').textContent`), /more than once/);
  await evaluate(`document.querySelector('.auto-map').click()`);
  assert.equal(await evaluate(`document.querySelector('.confirm-mapping').disabled`), false);
  if (process.env.SUPER_PADS_MAPPING_SCREENSHOT) {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(process.env.SUPER_PADS_MAPPING_SCREENSHOT, (await contents.capturePage()).toPNG());
  }
  await evaluate(`document.querySelector('.confirm-mapping').click()`);
  await waitFor(() => evaluate(`state.patterns.F1.summary?.notes.length === 131`), 'future-bap import');
  assert.equal(await evaluate(`state.patterns.F1.summary.bars`), 4);
  assert.equal(await evaluate(`document.querySelector('.pattern-matrix').clientHeight >= 80`), true);
  // Matrix scrolling must keep the timeline visible, even while selecting a lower-bank destination.
  await evaluate(`document.querySelector('.pattern-pad[data-slot="F1"]').scrollIntoView({ block: 'nearest' })`);
  assert.equal(await evaluate(`document.querySelector('.pattern-preview').getBoundingClientRect().top > document.querySelector('.workspace-tabs').getBoundingClientRect().bottom`), true);
  assert.equal(await evaluate(`document.querySelector('.pattern-pad[data-slot="F1"]').classList.contains('add-pad')`), true);
  assert.equal(fs.existsSync(path.join(card.root, 'ROLAND', 'SP-404SX', 'PTN', 'PTN00061.BIN')), false);
  assert.equal(await evaluate(`Array.from(document.querySelector('.pattern-timeline').getContext('2d').getImageData(65 * devicePixelRatio, 28 * devicePixelRatio, 100 * devicePixelRatio, 20 * devicePixelRatio).data).some((value, index) => index % 4 === 0 && value > 100)`), true);
  if (process.env.SUPER_PADS_PATTERN_SCREENSHOT) {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(process.env.SUPER_PADS_PATTERN_SCREENSHOT, (await contents.capturePage()).toPNG());
  }
  await evaluate(`document.querySelector('.export-midi').click()`);
  assert.equal(await evaluate(`document.querySelector('.mapping-rows input[data-source="F9"]').value`), '36');
  await evaluate(`document.querySelector('.confirm-mapping').click()`);
  await waitFor(() => fs.existsSync(path.join(card.root, 'pattern-export.mid')), 'MIDI export');
  const { inspectMidi } = require(path.join(appRoot, 'src', 'patternMetadata'));
  const exported = await inspectMidi(fs.readFileSync(path.join(card.root, 'pattern-export.mid')));
  assert.deepEqual(exported.pitches, [36, 37, 38, 39, 40, 41, 42, 43]);
  assert.equal(exported.notes.length, 131);
  await waitFor(() => evaluate('!busy'), 'MIDI export finishes');
  await evaluate(`document.querySelector('.export-pattern').click()`);
  await waitFor(() => fs.existsSync(path.join(card.root, 'pattern-export.bin')), 'native pattern export');
  assert.deepEqual(Array.from(fs.readFileSync(path.join(card.root, 'pattern-export.bin'))), await evaluate('state.patterns.F1.bytes'));
  await waitFor(() => evaluate('!busy'), 'native export finishes');
  patternImportFile = path.join(card.root, 'pattern-export.bin');
  await evaluate(`document.querySelector('.pattern-pad[data-slot="F2"]').click(); document.querySelector('.import-pattern').click()`);
  await waitFor(() => evaluate(`state.patterns.F2.summary?.notes.length === 131`), 'native pattern import');
  await evaluate(`document.querySelector('.remove-pattern').click()`);
  assert.equal(await evaluate(`state.patterns.F2.remove`), true);
  await evaluate(`document.querySelector('button.write-card').click()`);
  await waitFor(() => evaluate('!busy'), 'patterns save together with queued samples');
  assert.deepEqual(Array.from(fs.readFileSync(path.join(card.root, 'ROLAND', 'SP-404SX', 'PTN', 'PTN00061.BIN'))), await evaluate('state.patterns.F1.bytes'));
  assert.equal(await evaluate(`state.patterns.F1.dirty`), undefined);
  assert.equal(await evaluate(`state.patterns.F2.bytes`), undefined);
  await evaluate('parsePads()');
  assert.equal(await evaluate(`state.patterns.F1.name`), 'future-bap');
  assert.equal(await evaluate(`state.patterns.F1.noteMap[36]`), 'F9');
  await evaluate(`document.querySelector('#patterns-tab').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`);
  assert.equal(await evaluate(`document.querySelector('#pads-tab').getAttribute('aria-selected')`), 'true');
}

/** Exercise the ESM pattern worker through real renderer IPC, including transferred output and error replies. */
async function checkPatternConversion(evaluate) {
  const result = await evaluate(`(async () => {
    const footer = new Uint8Array(16);
    footer[1] = 140;
    footer[9] = 2;
    const pattern = new Uint8Array([0, 59, 1, 0, 100, 64, 0, 96, ...footer]);
    const midi = await runWorker('convertPattern', {
      direction: 'midi', buffer: pattern.buffer, options: { noteMap: { G1: 42 }, ppq: 480 },
    });
    const restored = await runWorker('convertPattern', {
      direction: 'pattern', buffer: midi.buffer, options: { noteMap: { 42: 'G1' } },
    });
    let error;
    try {
      await runWorker('convertPattern', { direction: 'midi', buffer: pattern.buffer, options: { noteMap: {} } });
    } catch (failure) { error = failure.message; }
    return { bytes: Array.from(new Uint8Array(restored.buffer)), error };
  })()`);
  const bytes = Buffer.from(result.bytes);
  const { inspectPattern } = require(path.join(appRoot, 'src', 'patternMetadata'));
  assert.deepEqual((await inspectPattern(bytes)).usedPads, ['G1']);
  assert.equal(bytes[1], 59);
  assert.equal(bytes[2], 1);
  assert.equal(bytes.readUInt16BE(6), 96);
  assert.equal(bytes[bytes.length - 7], 2);
  assert.match(result.error, /No MIDI note mapping for G1/);
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
  const readPads = () => SP404PadInfo.fromFile(fs.readFileSync(info)).pads;
  const readWave = () => fs.readFileSync(path.join(card.directory, 'A0000001.WAV'));
  async function writeCardUI() {
    await evaluate(`document.querySelector('button.write-card').click()`);
    await waitFor(() => evaluate('!busy'), 'card write completes');
  }

  // Canceled sample/card pickers must leave queued audio and settings intact without reporting failures.
  await evaluate(`renderLeft('A1'); setExternalFile(${JSON.stringify(card.file)}); hideError()`);
  assert.equal(await evaluate('state.pads.A1.convert'), true);
  await checkPickerCancellation(evaluate, '.left .drop-zone', 'pickFile-task-finished');
  await checkPickerCancellation(evaluate, 'button.choose-folder', 'pickSDCard-task-finished');

  // Use real controls and on-card metadata to catch rounding or invalid input poisoning future saves.
  await evaluate(`
    for (const [selector, value] of [['input.bpm', '123.4'], ['input.bpm-user', '98.7']]) {
      const input = document.querySelector(selector);
      input.value = value;
      input.dispatchEvent(new Event('change'));
      if (!input.validity.valid) throw new Error('Tenths of BPM must be valid');
    }
  `);
  assert.equal(await evaluate('state.pads.A1.originalTempo'), 123.4);
  assert.equal(await evaluate('state.pads.A1.userTempo'), 98.7);
  for (const value of ['', '19', '1000', '123.45']) {
    await evaluate(`{
      const input = document.querySelector('input.bpm');
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('change'));
    }`);
    assert.equal(await evaluate('state.pads.A1.originalTempo'), 123.4);
    assert.equal(await evaluate('document.querySelector("input.bpm").value'), '123.4');
  }
  // The preceding real file drop queued A1. Write through the UI, then use the actual mono switch.
  await writeCardUI();
  assert.equal(readPads()[0].originalTempo, 123.4);
  assert.equal(readPads()[0].userTempo, 98.7);
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
  window.webContents.on('render-process-gone', (_event, details) => finish(new Error(`${details.reason} (exit ${details.exitCode})`)));
  window.webContents.once('did-fail-load', (_event, code, description) => finish(new Error(`${code}: ${description}`)));
  window.webContents.once('did-finish-load', () => checkWindow(window).then(() => finish(), finish));
});

setTimeout(() => finish(new Error('Electron smoke test exceeded 90 seconds.')), 90000).unref();
process.on('unhandledRejection', finish);
process.on('uncaughtException', finish);
/** Load ESM tools and fixtures before creating windows or acquiring the app's single-instance lock. */
async function start() {
  ({ SP404PadInfo, AudioWAV } = await loadDataTools());
  card = await createCard({ seconds: 4, prefix: 'super-pads-#card-' });
  replacement = await createCard();
  app.setPath('userData', path.join(card.root, 'profile'));
  for (const filename of ['A0000001.WAV', 'A0000002.WAV', 'A0000010.WAV']) {
    fs.copyFileSync(card.file, path.join(card.directory, filename));
  }
  require(path.join(appRoot, 'src', 'main.js'));
}
start().catch(finish);
