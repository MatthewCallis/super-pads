/* eslint-disable no-use-before-define */
const { ipcRenderer, webUtils } = require('electron');
const AudioPreview = require('./src/audioPreview.js');
const path = require('node:path');
const runWorker = require('./src/runWorker.js');
const formatBytes = require('./src/formatBytes.js');
const { canDragPad, transferPads } = require('./src/padTransfer.js');
const PatternPanel = require('./src/patternPanel.js');
const { emptyPatternSlots } = require('./src/patternSlots.js');

/** Custom drag data is accepted only while this renderer owns an active pad drag. */
const PAD_DRAG_TYPE = 'application/x-super-pads-pad';
/** Active source label; cleared on drop/end so a detached drag node cannot leave reusable payloads. */
let draggedPad;

let state = {
  root: '',
  pads: {},
  padInfo: 'PAD_INFO.BIN',
  currentPad: 'A1',
  patterns: emptyPatternSlots(),
};
/** Selection belongs to this editor session; card snapshots retain only the active pad. */
let selectedPads = new Set(['A1']);
/** Fixed origin for repeated Shift-click ranges in bank/number order. */
let selectionAnchor = 'A1';

// Loading
let requestId = null;
const loading = document.querySelector('.loading');
window.noise.seed(Math.random());
loading.addEventListener('click', () => {
  window.noise.seed(Math.random());
});
const speed = 0.0005;
const showLoading = () => {
  // Repeated callers share one animation; removing its canvas alone does not cancel its loop.
  if (requestId !== null) return;
  document.querySelector('.left').inert = true;
  document.querySelector('.right').inert = true;
  for (const e of document.querySelectorAll('.loading canvas')) e.remove();
  loading.style.display = 'block';
  const res = Math.ceil(window.innerHeight / 32);
  let w = Math.ceil(window.innerWidth / res);
  let h = Math.ceil(window.innerHeight / res);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  loading.append(canvas);

  function setSize() {
    w = Math.ceil(window.innerWidth / res);
    h = Math.ceil(window.innerHeight / res);
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  let progress = 0;

  const doit = () => {
    if (ctx) {
      progress += speed;
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
          const sim = window.noise.simplex3((progress + x) / (w * 1.5), progress + y / (h * 1.5), progress);
          // const per = noise.perlin3((progress + x) / (w * 1.25), progress + y / (h * 1.25), progress);
          ctx.fillStyle = `hsl(${(1360 * Math.abs(sim)) % 360},100%,73%)`;
          ctx.fillRect(x * res, y * res, res, res);
        }
      }
      requestId = requestAnimationFrame(doit);
    }
  };
  doit();
  setSize();
};

const hideLoading = () => {
  cancelAnimationFrame(requestId);
  requestId = null;
  document.querySelector('.left').inert = !cardReady;
  document.querySelector('.right').inert = false;
  for (const e of document.querySelectorAll('.loading canvas')) e.remove();
  loading.style.display = 'none';
};

// Errors
const errors = document.querySelector('p.errors');

const showError = (content) => {
  errors.textContent = typeof content === 'string' ? content : content.message;
  errors.style.display = 'block';
};

const hideError = () => {
  errors.textContent = '';
  errors.style.display = 'none';
};

errors.addEventListener('click', () => {
  hideError();
});

const preview = new AudioPreview({
  canvas: document.querySelector('#waveform'),
  play: document.querySelector('button.play'),
  pause: document.querySelector('button.pause'),
  onError: showError,
});
let controlsController;

// A single operation owns the card until staging, commit, and recovery have finished.
let cardReady = false;
let busy = false;
/**
 * Serialize pattern work with card access, retaining pending edits on failure.
 * Native dialogs use showProgress=false: waiting for a choice is not file processing.
 */
const performPatternOperation = async (operation, { showProgress = true } = {}) => {
  if (busy || !cardReady) return undefined;
  busy = true;
  hideError();
  if (showProgress) showLoading();
  try { return await operation(); }
  catch (error) { showError(error); return undefined; }
  finally {
    busy = false;
    if (showProgress) hideLoading();
  }
};
const patternPanel = new PatternPanel({
  getState: () => state, isReady: () => cardReady, isBusy: () => busy,
  perform: performPatternOperation, showError,
});

/** Switch card views without changing either view's selection; tabs support standard arrow/Home/End navigation. */
const selectTab = (name) => {
  for (const tab of document.querySelectorAll('.workspace-tabs [role="tab"]')) {
    const active = tab.id === `${name}-tab`;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
  }
  document.querySelector('.matrix-help').hidden = name !== 'pads' || !cardReady;
  const middle = document.querySelector('.right .middle');
  middle.classList.toggle('patterns-active', name === 'patterns');
  middle.scrollTop = 0;
  document.querySelector('.matrix-legend span:first-child').lastChild.textContent = name === 'pads' ? 'Sample' : 'Pattern';
  if (name === 'patterns') {
    preview.clear();
    patternPanel.render();
  } else if (cardReady) renderLeft(state.currentPad);
};
for (const tab of document.querySelectorAll('.workspace-tabs [role="tab"]')) {
  tab.addEventListener('click', () => selectTab(tab.id.replace('-tab', '')));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let target = 'pads';
    if (event.key === 'End' || (event.key.startsWith('Arrow') && tab.id === 'pads-tab')) target = 'patterns';
    selectTab(target);
    document.querySelector(`#${target}-tab`).focus();
  });
}
const write = document.querySelector('button.write-card');
write.addEventListener('click', async () => {
  if (busy || !cardReady) return;
  busy = true;
  write.disabled = true;
  hideError();
  preview.clear();
  showLoading();
  try {
    const { pads, patterns, warning } = await runWorker('writeCard', { root: state.root, state });
    preview.cache.clear();
    state.pads = Object.fromEntries(pads.map((pad) => [pad.label, pad]));
    state.patterns = patterns || emptyPatternSlots();
    renderPads();
    patternPanel.render();
    if (warning) showError(warning);
  } catch (error) {
    // Keep pending edits on failure; incomplete recovery must be retried by reopening the card first.
    if (error.recoveryRequired) {
      cardReady = false;
      togglePicker(false);
      patternPanel.render();
    }
    showError(error);
  } finally {
    busy = false;
    write.disabled = !cardReady;
    hideLoading();
  }
});

/** Queue one disk file on the addressed slot and select it; conversion happens only when saving. */
const setExternalFile = (filePath, size = 0, label = state.currentPad) => {
  if (busy || !cardReady || !state.pads[label]) return;
  Object.assign(state.pads[label], {
    convert: true, avaliable: false, externalFile: filePath, externalFileSize: size, remove: false,
  });
  // Replacing a moved sample changes its source to this import, while its old slot still stays vacant.
  delete state.pads[label].sourceFilename;
  updatePad(label);
  selectPad(label);
};

/** Expose all bank groups only after a complete card read, keeping the folder picker available for recovery. */
const togglePicker = (show) => {
  document.querySelector('.bank-matrix').hidden = !show;
  document.querySelector('.pad-selection-toolbar').hidden = !show;
  document.querySelector('.matrix-help').hidden = !show || document.querySelector('#pads-panel').hidden;
  document.querySelector('.matrix-legend').hidden = !show;
  document.querySelector('.matrix-empty').hidden = show;
  document.querySelector('button.choose-folder').textContent = show ? 'Change Folder' : 'Pick Folder';
  document.querySelector('.card-path').textContent = show ? state.root : 'Select your SD card to get started';
  document.querySelector('.right .bottom .write-card').style.display = show ? 'block' : 'none';
};

/** Accept a local pad move or one real filesystem file without navigating Electron to the dropped file. */
const dropOnPad = (event, label) => {
  event.preventDefault();
  event.stopPropagation();
  clearDragFeedback();
  if (busy || !cardReady) return;
  const transfer = event.dataTransfer;
  if (!transfer) return;
  if (transfer.types.includes(PAD_DRAG_TYPE)) {
    const source = transfer.getData(PAD_DRAG_TYPE);
    // Ignore forged or stale drag payloads from outside this editor.
    if (source !== draggedPad) return;
    draggedPad = undefined;
    if (transferPads(state.pads, source, label)) {
      selectedPads = new Set([label]);
      selectionAnchor = label;
      state.currentPad = label;
      renderPads();
    }
    return;
  }
  if (transfer.files.length !== 1) {
    showError('Drop one audio file onto a pad.');
    return;
  }
  const file = transfer.files[0];
  // Electron 32 removed File.path; virtual files have no filesystem source to convert.
  const filePath = webUtils.getPathForFile(file);
  if (filePath) setExternalFile(filePath, file.size, label);
  else showError('Drop a file from your computer.');
};

/** Drag types are readable during hover even though the browser protects their payload until drop. */
const acceptsDrag = (event) => Boolean(event.dataTransfer && !busy && cardReady
  && (event.dataTransfer.types.includes('Files')
    || (draggedPad && event.dataTransfer.types.includes(PAD_DRAG_TYPE))));

/** Remove transient styling after a drop or cancellation, including when the source node was rebuilt. */
const clearDragFeedback = () => {
  for (const node of document.querySelectorAll('.dragging, .drop-target, .gradient-background')) {
    node.classList.remove('dragging', 'drop-target', 'gradient-background');
  }
};

// Suppress native file navigation even when a file misses every valid pad target.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());
document.addEventListener('dragend', () => { draggedPad = undefined; clearDragFeedback(); });

/** Select one pad, toggle membership, or extend a range; keep at least one editable pad selected. */
const selectPad = (label, { ctrlKey = false, metaKey = false, shiftKey = false } = {}) => {
  if (!state.pads[label]) return;
  const additive = ctrlKey || metaKey;
  if (shiftKey) {
    const labels = Object.keys(state.pads);
    const start = labels.indexOf(selectionAnchor);
    const end = labels.indexOf(label);
    if (!additive) selectedPads.clear();
    for (const item of labels.slice(Math.min(start, end), Math.max(start, end) + 1)) selectedPads.add(item);
  } else if (additive) {
    // Removing the active pad must select a remaining member before its controls are rebuilt.
    if (selectedPads.has(label) && selectedPads.size > 1) selectedPads.delete(label);
    else selectedPads.add(label);
    selectionAnchor = label;
  } else {
    selectedPads = new Set([label]);
    selectionAnchor = label;
  }
  const active = selectedPads.has(label) ? label : Array.from(selectedPads).at(-1);
  renderLeft(active);
};

document.querySelector('button.select-all-pads').addEventListener('click', () => {
  if (busy || !cardReady) return;
  selectedPads = new Set(Object.keys(state.pads));
  renderLeft(state.currentPad);
});

/** Return a shared setting, or undefined when selected pads differ; this never normalizes their values. */
const sharedValue = (pads, getValue) => {
  const value = getValue(pads[0]);
  return pads.every((pad) => getValue(pad) === value) ? value : undefined;
};

/** Resolve the pending import or card sample; empty pads have no preview work. */
const previewPath = (pad) => {
  if (!pad) return undefined;
  if (pad.convert) return pad.externalFile;
  if (pad.samplePresent) return path.join(state.root, 'ROLAND', 'SP-404SX', 'SMPL', pad.sourceFilename || pad.filename);
  return undefined;
};

/** Show shared/mixed values and bind field-specific edits to this selection, canceling previous listeners. */
const renderLeft = (label) => {
  if (!label) {
    return;
  }

  const pad = state.pads[label];
  if (!pad) {
    return;
  }
  // Direct navigation to a pad outside the selection starts a single-pad edit.
  if (!selectedPads.has(label)) {
    selectedPads = new Set([label]);
    selectionAnchor = label;
  }
  state.currentPad = label;
  const pads = Array.from(selectedPads, (selected) => state.pads[selected]);
  const bulk = pads.length > 1;
  for (const node of document.querySelectorAll('.pad-list .pad')) {
    const selected = selectedPads.has(node.dataset.label);
    node.classList.toggle('selected', selected);
    node.setAttribute('aria-pressed', String(selected));
  }

  controlsController?.abort();
  controlsController = new AbortController();
  const listen = (selector, type, listener) => {
    document.querySelector(selector).addEventListener(type, listener, { signal: controlsController.signal });
  };

  document.querySelector('.left').dataset.label = label;
  document.querySelector('.left').classList.remove('startup', 'drop-zone');
  document.querySelector('.left').classList.remove('open', 'used');
  document.querySelector('.left').classList.add(pad.avaliable ? 'open' : 'used');
  document.querySelector('.left').classList.toggle('bulk', bulk);
  document.querySelector('.selection-count').textContent = `${pads.length} pad${bulk ? 's' : ''} selected`;
  document.querySelector('button.select-all-pads').disabled = pads.length === Object.keys(state.pads).length;
  document.querySelector('.bulk-help').hidden = !bulk;

  for (const [selector, field] of [
    ['input.lofi-button', 'lofi'], ['input.gate-button', 'gate'],
    ['input.loop-button', 'loop'], ['input.reverse-off-button', 'reverse'],
  ]) {
    const input = document.querySelector(selector);
    const value = sharedValue(pads, (selected) => selected[field]);
    // These sliders invert checked for display; a first click on Mixed enables the flag for everyone.
    input.checked = value !== true;
    input.indeterminate = value === undefined;
    listen(selector, 'change', () => {
      for (const selected of pads) selected[field] = !input.checked;
      input.indeterminate = false;
    });
  }

  const channels = document.querySelector('input.mono-stereo-button');
  /** Include queued conversions in the shared value while keeping original mono sources read-only. */
  const renderChannels = () => {
    const value = sharedValue(pads, (selected) => selected.targetChannels || selected.channels);
    channels.checked = value === 'Mono';
    channels.indeterminate = value === undefined;
    channels.disabled = pads.every((selected) => selected.channels === 'Mono');
  };
  renderChannels();
  listen('input.mono-stereo-button', 'change', () => {
    for (const selected of pads) {
      // Existing mono audio cannot become stereo; cancel conversions only on original stereo sources.
      if (selected.channels === 'Mono') continue;
      if (channels.checked) selected.targetChannels = 'Mono';
      else delete selected.targetChannels;
      updatePad(selected.label);
    }
    renderChannels();
  });

  document.querySelector('select.tempo-mode').value = sharedValue(pads, (selected) => selected.tempoMode) ?? '';
  listen('select.tempo-mode', 'change', (event) => {
    if (!event.target.value) return;
    for (const selected of pads) selected.tempoMode = event.target.value;
  });

  // Blank mixed inputs are display-only. Invalid/cleared edits restore the shared value without touching any pad.
  for (const [selector, field] of [['input.bpm', 'originalTempo'], ['input.bpm-user', 'userTempo']]) {
    const renderTempo = () => {
      const input = document.querySelector(selector);
      const value = sharedValue(pads, (selected) => selected[field]);
      input.value = value ?? '';
      input.placeholder = value === undefined ? 'Mixed' : '';
    };
    renderTempo();
    listen(selector, 'change', (event) => {
      const input = event.target;
      if (!Number.isFinite(input.valueAsNumber) || !input.validity.valid) {
        renderTempo();
        return;
      }
      for (const selected of pads) selected[field] = input.valueAsNumber;
    });
  }

  const volume = sharedValue(pads, (selected) => selected.volume);
  document.querySelector('.volume-numeric').textContent = volume === undefined ? '(Mixed)' : `(${volume})`;
  document.querySelector('input.volume').value = volume ?? 64;
  document.querySelector('input.volume-entry').value = volume ?? '';
  /** Update only volume; the numeric input lets mixed selections choose any value, including the slider midpoint. */
  const changeVolume = (event) => {
    const input = event.target;
    if (!Number.isFinite(input.valueAsNumber) || !input.validity.valid) {
      input.value = sharedValue(pads, (selected) => selected.volume) ?? '';
      return;
    }
    for (const selected of pads) selected.volume = input.valueAsNumber;
    document.querySelector('.volume-numeric').textContent = `(${input.value})`;
    document.querySelector('input.volume').value = input.value;
    document.querySelector('input.volume-entry').value = input.value;
  };
  listen('input.volume-entry', 'change', changeVolume);
  listen('input.volume', 'change', changeVolume);

  if (bulk) preview.clear();
  else preview.show(previewPath(pad));

  document.querySelector('input.original-file').value = bulk ? '' : pad.externalFile || '';
  document.querySelector('.left .drop-zone').disabled = bulk;

  const removable = pads.filter((selected) => !selected.avaliable);
  const keep = removable.length > 0 && removable.every((selected) => selected.remove);
  document.querySelector('button.remove-pad').disabled = removable.length === 0;
  listen('button.remove-pad', 'click', (_event) => {
    for (const selected of removable) {
      selected.remove = !keep;
      updatePad(selected.label);
    }
    renderLeft(state.currentPad);
  });
  let removeText = keep ? 'Keep Pad' : 'Remove Pad';
  if (bulk) removeText = keep ? 'Keep Selected Pads' : 'Remove Selected Pads';
  document.querySelector('button.remove-pad').textContent = removeText;

  // Pad Meta Data
  document.querySelector('.pad-label').textContent = bulk ? `${pads.length} pads` : pad.label;
  document.querySelector('.file-type').textContent = pad.format;

  if (pad.duration) {
    const duration = new Date(pad.duration * 1000).toISOString().slice(11, 19);
    document.querySelector('.duration').textContent = duration;
  } else {
    document.querySelector('.duration').textContent = '00:00:00';
  }

  if (pad.size) {
    document.querySelector('.file-size').textContent = formatBytes(pad.size);
  } else {
    document.querySelector('.file-size').textContent = 'N/A';
  }

  // Drag & Drop
  const dropZone = document.querySelector('.left .drop-zone');
  dropZone.classList.remove('gradient-background');
  // Imports and sample moves address one slot, so the bulk inspector offers only shared settings/removal.
  if (bulk) return;
  listen('.left .drop-zone', 'click', () => {
    ipcRenderer.send('pickFile');
  });
  listen('.left .drop-zone', 'drop', (event) => dropOnPad(event, state.currentPad));

  listen('.left .drop-zone', 'dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!acceptsDrag(e)) return;
    e.dataTransfer.dropEffect = draggedPad ? 'move' : 'copy';
    dropZone.classList.add('gradient-background');
  });

  listen('.left .drop-zone', 'dragleave', (_event) => {
    dropZone.classList.remove('gradient-background');
  });
};

/** Refresh one pad's state classes without replacing its click target. */
const updatePad = (label) => {
  const pad = state.pads[label];
  const container = document.querySelector(`.bank-${label[0].toLowerCase()} .pad-${label.slice(1)}`);
  if (!container) return;
  container.classList.toggle('open-pad', pad.avaliable);
  container.classList.toggle('active-pad', !pad.avaliable);
  container.classList.toggle('add-pad', Boolean(pad.convert || pad.targetChannels || pad.relocated));
  container.classList.toggle('delete-pad', Boolean(pad.remove));
  container.draggable = canDragPad(pad);
  let status = 'Empty';
  if (canDragPad(pad)) status = 'Sample';
  if (pad.convert || pad.targetChannels || pad.relocated) status = 'Pending';
  if (pad.remove) status = 'Remove';
  container.querySelector('.pad-status').textContent = status;
  container.title = `${label}: ${status}. Click to edit; Cmd/Ctrl-click to select multiple; Shift-click for a range. Drop a file here or drag a sample to move or swap.`;
  const bank = document.querySelector(`.bank-group[data-bank="${label[0]}"]`);
  const filled = Object.values(state.pads).filter((item) => item.label[0] === label[0] && canDragPad(item)).length;
  bank.querySelector('.bank-count').textContent = `${filled} / 12`;
};

/** Build one keyboard-selectable pad with direct file drops and local sample move/swap support. */
const buildPads = (pad) => {
  const container = document.createElement('button');
  container.type = 'button';
  container.dataset.label = pad.label;
  container.classList.add('pad');
  container.classList.add(`pad-${pad.label.slice(1)}`);
  container.classList.toggle('selected', selectedPads.has(pad.label));
  const label = document.createElement('span');
  label.className = 'pad-name';
  label.textContent = pad.label;
  const status = document.createElement('span');
  status.className = 'pad-status';
  container.append(label, status);
  container.addEventListener('click', (event) => {
    if (busy || !cardReady) return;
    selectPad(pad.label, event);
  });
  container.addEventListener('dragstart', (event) => {
    if (busy || !cardReady || !canDragPad(state.pads[pad.label])) {
      event.preventDefault();
      return;
    }
    draggedPad = pad.label;
    event.dataTransfer.setData(PAD_DRAG_TYPE, pad.label);
    event.dataTransfer.effectAllowed = 'move';
    container.classList.add('dragging');
  });
  // A successful drop can detach this source during renderPads, so cleanup cannot rely on bubbling.
  container.addEventListener('dragend', () => { draggedPad = undefined; clearDragFeedback(); });
  container.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (!acceptsDrag(event) || draggedPad === pad.label) return;
    event.dataTransfer.dropEffect = draggedPad ? 'move' : 'copy';
    container.classList.add('drop-target');
  });
  container.addEventListener('dragleave', (event) => {
    // Moving over a label inside this same button is still hovering the same drop target.
    if (!container.contains(event.relatedTarget)) container.classList.remove('drop-target');
  });
  container.addEventListener('drop', (event) => dropOnPad(event, pad.label));
  return container;
};

/** Rebuild all ten banks after loading, saving, or rearranging; settings edits retain the existing pad buttons. */
const renderPads = () => {
  togglePicker(true);

  // Empty banks
  for (const bank of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
    const container = document.querySelector(`.right .middle .bank-${bank}`);
    container.replaceChildren();
  }

  // Build pads
  for (const pad of Object.values(state.pads)) {
    const container = document.querySelector(`.right .middle .bank-${pad.label[0].toLowerCase()}`);
    container.append(buildPads(pad));
    updatePad(pad.label);
  }
  renderLeft(state.currentPad);
};

// Pick SD Card
document.querySelector('button.choose-folder').addEventListener('click', () => {
  // event.target.disabled = true;
  ipcRenderer.send('pickSDCard');
});

// #region IPC Main Tasks
ipcRenderer.on('pickSDCard-task-finished', (event, { valid, root, error, canceled }) => {
  if (busy || canceled) return;
  if (error) {
    document.querySelector('button.choose-folder').disabled = false;
    showError(error);
    return;
  }
  if (!valid || !root) {
    document.querySelector('button.choose-folder').disabled = false;
    showError('Not a valid Roland SD Card directory root.');
  } else {
    state.root = root;

    // Card metadata is authoritative: saved editor state can be stale after edits on the sampler.
    parsePads();
  }
});
ipcRenderer.on('pickFile-task-finished', (event, { file, error, canceled }) => {
  if (canceled) return;
  if (error) {
    showError(error);
    return;
  }
  if (!file) {
    showError('Not a valid file.');
  } else {
    setExternalFile(file);
  }
});
// #endregion

/** Replace the complete card view only after a validated read; failed reads disable writing. */
const parsePads = async () => {
  if (busy) return;
  busy = true;
  cardReady = false;
  write.disabled = true;
  preview.clear();
  showLoading();
  try {
    const { pads, patterns } = await runWorker('parsePads', { root: state.root });
    state.pads = Object.fromEntries(pads.map((pad) => [pad.label, { ...pad, convert: false, remove: false }]));
    state.patterns = patterns;
    selectedPads = new Set([state.currentPad]);
    selectionAnchor = state.currentPad;
    cardReady = true;
    hideError();
    renderPads();
    patternPanel.render();
  } catch (error) {
    preview.clear();
    togglePicker(false);
    patternPanel.render();
    showError(`Card unavailable: ${error.message}`);
  } finally {
    busy = false;
    write.disabled = !cardReady;
    hideLoading();
  }
};
