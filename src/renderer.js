/* eslint-disable no-use-before-define */
const { ipcRenderer, webUtils } = require('electron');
const AudioPreview = require('./src/audioPreview.js');
const path = require('node:path');
const runWorker = require('./src/runWorker.js');
const formatBytes = require('./src/formatBytes.js');

let state = {
  root: '',
  pads: {},
  padInfo: 'PAD_INFO.BIN',
  currentPad: 'A1',
  currentBank: 'bank-a',
};

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
const write = document.querySelector('button.write-card');
write.addEventListener('click', async () => {
  if (busy || !cardReady) return;
  busy = true;
  write.disabled = true;
  hideError();
  preview.clear();
  showLoading();
  try {
    const { pads, warning } = await runWorker('writeCard', { root: state.root, state });
    preview.cache.clear();
    state.pads = Object.fromEntries(pads.map((pad) => [pad.label, pad]));
    renderPads();
    if (warning) showError(warning);
  } catch (error) {
    // Keep pending edits on failure; incomplete recovery must be retried by reopening the card first.
    if (error.recoveryRequired) {
      cardReady = false;
      togglePicker(false);
    }
    showError(error);
  } finally {
    busy = false;
    write.disabled = !cardReady;
    hideLoading();
  }
});

const setExternalFile = (path, size = 0) => {
  if (busy || !cardReady) return;
  state.pads[state.currentPad].convert = true;
  state.pads[state.currentPad].avaliable = false;
  state.pads[state.currentPad].externalFile = path;
  state.pads[state.currentPad].externalFileSize = size;
  state.pads[state.currentPad].remove = false;
  updatePad(state.currentPad);
  renderLeft(state.currentPad);
};

const togglePicker = (show) => {
  document.querySelector('.right .top .bank-selector').style.display = show ? 'flex' : 'none';
  document.querySelector('.right .top .folder-selector').style.display = show ? 'none' : 'flex';
  document.querySelector('.right .bottom .write-card').style.display = show ? 'block' : 'none';

  for (const node of document.querySelectorAll('.right .pad-list')) node.classList.remove('open');
  document.querySelector(`.right .pad-list.${state.currentBank}`).classList.add('open');
};

const onChange = (field) => () => {
  state.pads[state.currentPad][field] = !state.pads[state.currentPad][field];
};

/** Resolve the pending import or card sample; empty pads have no preview work. */
const previewPath = (pad) => {
  if (!pad) return undefined;
  if (pad.convert) return pad.externalFile;
  if (pad.samplePresent) return path.join(state.root, 'ROLAND', 'SP-404SX', 'SMPL', pad.filename);
  return undefined;
};

/** Update stable controls and cancel listeners owned by the previous selection. */
const renderLeft = (label) => {
  if (!label) {
    return;
  }

  const pad = state.pads[label];
  if (!pad) {
    return;
  }
  state.currentPad = label;

  controlsController?.abort();
  controlsController = new AbortController();
  const listen = (selector, type, listener) => {
    document.querySelector(selector).addEventListener(type, listener, { signal: controlsController.signal });
  };

  document.querySelector('.left').dataset.label = label;
  document.querySelector('.left').classList.remove('startup', 'drop-zone');
  document.querySelector('.left').classList.remove('open', 'used');
  document.querySelector('.left').classList.add(pad.avaliable ? 'open' : 'used');

  // NOTE: Checkboxes invert to fit the checkbox style, only for display.
  document.querySelector('input.lofi-button').checked = !pad.lofi;
  listen('input.lofi-button', 'change', onChange('lofi'));

  document.querySelector('input.gate-button').checked = !pad.gate;
  listen('input.gate-button', 'change', onChange('gate'));

  document.querySelector('input.loop-button').checked = !pad.loop;
  listen('input.loop-button', 'change', onChange('loop'));

  document.querySelector('input.reverse-off-button').checked = !pad.reverse;
  listen('input.reverse-off-button', 'change', onChange('reverse'));

  if (pad.channels === 'Mono' || pad.targetChannels === 'Mono') {
    document.querySelector('input.mono-stereo-button').checked = true;
  } else {
    document.querySelector('input.mono-stereo-button').checked = false;
  }

  if (pad.channels === 'Mono') {
    document.querySelector('input.mono-stereo-button').disabled = true;
    document.querySelector('input.mono-stereo-button').readonly = true;
  } else {
    document.querySelector('input.mono-stereo-button').disabled = false;
    document.querySelector('input.mono-stereo-button').readonly = false;
    listen('input.mono-stereo-button', 'change', (event) => {
      if (event.target.checked) {
        state.pads[state.currentPad].targetChannels = 'Mono';
      } else {
        delete state.pads[state.currentPad].targetChannels;
      }
      updatePad(state.currentPad);
    });
  }

  document.querySelector('select.tempo-mode').value = pad.tempoMode;
  listen('select.tempo-mode', 'change', (event) => {
    state.pads[state.currentPad].tempoMode = event.target.value;
  });

  document.querySelector('input.bpm').value = pad.originalTempo;
  listen('input.bpm', 'change', (event) => {
    state.pads[state.currentPad].originalTempo = Number.parseInt(event.target.value, 10);
  });

  document.querySelector('input.bpm-user').value = pad.userTempo;
  listen('input.bpm-user', 'change', (event) => {
    state.pads[state.currentPad].userTempo = Number.parseInt(event.target.value, 10);
  });

  document.querySelector('.volume-numeric').textContent = `(${pad.volume})`;
  document.querySelector('input.volume').value = pad.volume;
  listen('input.volume', 'change', (event) => {
    event.target.previousSibling.previousSibling.textContent = `(${event.target.value})`;
    state.pads[state.currentPad].volume = Number.parseInt(event.target.value, 10);
  });

  preview.show(previewPath(pad));

  document.querySelector('input.original-file').value = pad.externalFile || '';

  document.querySelector('button.remove-pad').disabled = pad.avaliable;
  listen('button.remove-pad', 'click', (_event) => {
    state.pads[state.currentPad].remove = !state.pads[state.currentPad].remove;
    updatePad(state.currentPad);
    renderLeft(state.currentPad);
  });
  if (pad.remove) {
    document.querySelector('button.remove-pad').textContent = 'Keep Pad';
  } else {
    document.querySelector('button.remove-pad').textContent = 'Remove Pad';
  }

  // Pad Meta Data
  document.querySelector('.pad-label').textContent = pad.label;
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
  listen('.left .drop-zone', 'click', () => {
    ipcRenderer.send('pickFile');
  });
  listen('.left .drop-zone', 'drop', (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.dataTransfer.files.length > 0) {
      const file = event.dataTransfer.files[0];
      // Electron 32 removed File.path; virtual files have no filesystem path to convert.
      const path = webUtils.getPathForFile(file);
      if (path) {
        setExternalFile(path, file.size);
      } else {
        showError('Drop a file from your computer.');
      }
    }

    dropZone.classList.remove('gradient-background');
  });

  listen('.left .drop-zone', 'dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('gradient-background');
  });

  listen('.left .drop-zone', 'dragenter', (_event) => {
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
  container.classList.toggle('add-pad', Boolean(pad.convert || pad.targetChannels));
  container.classList.toggle('delete-pad', Boolean(pad.remove));
};

const buildPads = (pad) => {
  const container = document.createElement('div');
  container.classList.add('pad');
  container.classList.add(`pad-${pad.label.slice(1)}`);
  container.classList.add(pad.label === state.currentPad ? 'selected' : 'pad');
  container.classList.add(pad.avaliable ? 'open-pad' : 'active-pad');
  container.classList.add(pad.convert ? 'add-pad' : 'pad');
  container.classList.add(pad.remove ? 'delete-pad' : 'pad');
  container.textContent = pad.label;
  container.addEventListener('click', (event) => {
    if (busy || !cardReady) return;
    for (const node of document.querySelectorAll('.right .pad-list .pad')) node.classList.remove('selected');
    event.target.classList.add('selected');
    renderLeft(pad.label);
  });
  return container;
};

const renderPads = () => {
  togglePicker(true);

  // Empty banks
  for (const bank of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
    const container = document.querySelector(`.right .middle .bank-${bank}`);
    const cNode = container.cloneNode(false);
    container.parentNode.replaceChild(cNode, container);
  }

  // Build pads
  for (const pad of Object.values(state.pads)) {
    const container = document.querySelector(`.right .middle .bank-${pad.label[0].toLowerCase()}`);
    container.append(buildPads(pad));
  }

  // Update DOM
  for (const node of document.querySelectorAll('.pad-list')) node.classList.remove('open');
  document.querySelector(`.pad-list.${state.currentBank}`).classList.add('open');
  document.querySelector('.bank-selector select').value = state.currentBank;
  renderLeft(state.currentPad);
};

// Pick SD Card
document.querySelector('button.choose-folder').addEventListener('click', () => {
  // event.target.disabled = true;
  ipcRenderer.send('pickSDCard');
});

// Listen for Bank Changes
document.querySelector('.bank-selector select').addEventListener('change', (event) => {
  state.currentBank = event.target.value;
  for (const node of document.querySelectorAll('.pad-list')) node.classList.remove('open');
  document.querySelector(`.pad-list.${state.currentBank}`).classList.add('open');
}, false);

// #region IPC Main Tasks
ipcRenderer.on('pickSDCard-task-finished', (event, { valid, root, error }) => {
  if (busy) return;
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
ipcRenderer.on('pickFile-task-finished', (event, { file, error }) => {
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
    const { pads } = await runWorker('parsePads', { root: state.root });
    state.pads = Object.fromEntries(pads.map((pad) => [pad.label, { ...pad, convert: false, remove: false }]));
    cardReady = true;
    hideError();
    renderPads();
  } catch (error) {
    preview.clear();
    togglePicker(false);
    showError(`Card unavailable: ${error.message}`);
  } finally {
    busy = false;
    write.disabled = !cardReady;
    hideLoading();
  }
};
