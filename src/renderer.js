/* eslint-disable no-use-before-define */
const { ipcRenderer } = require('electron');
const WaveformData = require('waveform-data');
const formatBytes = require('./src/formatBytes.js');

let state = {
  root: '',
  pads: {},
  padInfo: 'PAD_INFO.BIN',
  currentPad: 'A1',
  currentBank: 'bank-a',
};

// Loading
let requestId;
const loading = document.querySelector('.loading');
window.noise.seed(Math.random());
loading.addEventListener('click', () => {
  window.noise.seed(Math.random());
});
const speed = 0.0005;
const showLoading = () => {
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

// Write to SD Card
const write = document.querySelector('button.write-card');
write.addEventListener('click', async () => {
  showLoading();

  const directory = `${state.root}/ROLAND/SP-404SX/SMPL/`;
  const encodes = [];
  // Loop over files that need to be fully converted and convert them.
  for (const pad of Object.values(state.pads).filter((pad) => pad.convert)) {
    if (state.pads[pad.label].channels === 'Convert') {
      state.pads[pad.label].channels = 'Mono';
    }
    state.pads[pad.label].convert = false;
    encodes.push(encodeFileAsync({
      file: state.pads[pad.label].externalFile,
      directory,
      pad: state.pads[pad.label],
    }));
  }

  // Loop over files that need to be converted from Stereo to Mono and convert them.
  for (const pad of Object.values(state.pads).filter((pad) => pad.channels === 'Convert')) {
    state.pads[pad.label].channels = 'Mono';
    encodes.push(encodeFileAsync({
      file: state.pads[pad.label].filename,
      directory,
      pad: state.pads[pad.label],
    }));
  }

  const finished = await Promise.all(encodes).catch((error) => {
    hideLoading();
    showError(error);
  });

  // Loop over output of the encodedFiles
  if (finished && Array.isArray(finished)) {
    for (const message of finished) {
      const { pad, size, error } = message.data;
      if (error) {
        showError(error);
        continue;
      }
      state.pads[pad.label].avaliable = false;
      state.pads[pad.label].size = size;
      state.pads[pad.label].originalSampleEnd = size;
      state.pads[pad.label].userSampleEnd = size;
    }
  }

  // Remove any files marked to be deleted
  const removed = [];
  for (const pad of Object.values(state.pads).filter((pad) => pad.remove)) {
    removed.push(removeFileAsync({
      file: `${directory}${state.pads[pad.label].filename}`,
      pad: state.pads[pad.label],
    }));
  }

  // Remove the pad info for deleted files by setting to the defaults.
  const deleted = await Promise.all(removed).catch((error) => {
    hideLoading();
    showError(error);
  });
  for (const message of deleted) {
    const { pad, error } = message.data;
    if (error) {
      showError(error);
      continue;
    }
    state.pads[pad.label] = {
      originalSampleStart: 512,
      originalSampleEnd: 512,
      userSampleStart: 512,
      userSampleEnd: 512,
      volume: 127,
      lofi: false,
      loop: false,
      gate: true,
      reverse: false,
      format: 'WAVE',
      channels: 2,
      tempoMode: 'Off',
      originalTempo: 120,
      userTempo: 120,
    };
  }

  // Write the new PAD_INFO.BIN file
  encodePads({
    file: state.padInfo,
    directory,
    pads: Object.values(state.pads),
  });

  // Write state out to root for keeping meta data
  saveState();
});

const setExternalFile = (path, size = 0) => {
  state.pads[state.currentPad].convert = true;
  state.pads[state.currentPad].avaliable = false;
  state.pads[state.currentPad].externalFile = path;
  state.pads[state.currentPad].externalFileSize = size;
  renderPads();
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

const renderLeft = (label) => {
  if (!label) {
    return;
  }

  const pad = state.pads[label];
  if (!pad) {
    return;
  }
  state.currentPad = label;

  // Clear all event listeners
  document.querySelector('.left').outerHTML = document.querySelector('.left').outerHTML;

  document.querySelector('.left').dataset.label = label;
  document.querySelector('.left').classList.remove('startup', 'drop-zone');
  document.querySelector('.left').classList.remove('open', 'used');
  document.querySelector('.left').classList.add(pad.avaliable ? 'open' : 'used');

  // NOTE: Checkboxes invert to fit the checkbox style, only for display.
  document.querySelector('input.lofi-button').checked = !pad.lofi;
  document.querySelector('input.lofi-button').addEventListener('change', onChange('lofi'));

  document.querySelector('input.gate-button').checked = !pad.gate;
  document.querySelector('input.gate-button').addEventListener('change', onChange('gate'));

  document.querySelector('input.loop-button').checked = !pad.loop;
  document.querySelector('input.loop-button').addEventListener('change', onChange('loop'));

  document.querySelector('input.reverse-off-button').checked = !pad.reverse;
  document.querySelector('input.reverse-off-button').addEventListener('change', onChange('reverse'));

  if (pad.channels === 'Mono' || pad.channels === 'Convert') {
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
    document.querySelector('input.mono-stereo-button').addEventListener('change', (event) => {
      if (event.target.checked) {
        state.pads[state.currentPad].channels = 'Mono';
      } else {
        state.pads[state.currentPad].channels = 'Stereo';
      }
    });
  }

  document.querySelector('select.tempo-mode').value = pad.tempoMode;
  document.querySelector('select.tempo-mode').addEventListener('change', (event) => {
    state.pads[state.currentPad].tempoMode = event.target.value;
  });

  document.querySelector('input.bpm').value = pad.originalTempo;
  document.querySelector('input.bpm').addEventListener('change', (event) => {
    state.pads[state.currentPad].originalTempo = Number.parseInt(event.target.value, 10);
  });

  document.querySelector('input.bpm-user').value = pad.userTempo;
  document.querySelector('input.bpm-user').addEventListener('change', (event) => {
    state.pads[state.currentPad].userTempo = Number.parseInt(event.target.value, 10);
  });

  document.querySelector('.volume-numeric').textContent = `(${pad.volume})`;
  document.querySelector('input.volume').value = pad.volume;
  document.querySelector('input.volume').addEventListener('change', (event) => {
    event.target.previousSibling.previousSibling.textContent = `(${event.target.value})`;
    state.pads[state.currentPad].volume = Number.parseInt(event.target.value, 10);
  });

  // Advanced Use
  // originalSampleEnd: 385388
  // originalSampleStart: 512
  // userSampleEnd: 385388
  // userSampleStart: 512

  // Audio Preview
  const path = `${state.root}/ROLAND/SP-404SX/SMPL/${pad.filename}`;
  const audioContext = new AudioContext();
  // renderAudioWaveform({ path });
  try {
    fetch(path)
      .then((response) => response.arrayBuffer())
      .then((buffer) => {
        const options = {
          audio_context: audioContext,
          array_buffer: buffer,
          scale: 128,
        };

        return new Promise((resolve, reject) => {
          WaveformData.createFromAudio(options, (err, waveform) => {
            if (err) {
              reject(err);
            } else {
              resolve(waveform);
            }
          });
        });
      }).then((waveform) => {
        console.log(`Waveform has ${waveform.channels} channels`);
        console.log(`Waveform has length ${waveform.length} points`);
        const scaleY = (amplitude, height) => {
          const range = 256;
          const offset = 128;

          return height - ((amplitude + offset) * height) / range;
        };

        const canvas = document.querySelector('#waveform');
        const ctx = canvas.getContext('2d');
        ctx.strokeStyle = '#222831';
        ctx.beginPath();

        const channel = waveform.channel(0);

        // Loop forwards, drawing the upper half of the waveform
        for (let x = 0; x < waveform.length; x++) {
          const val = channel.max_sample(x);
          ctx.lineTo(x + 0.5, scaleY(val, canvas.height) + 0.5);
        }

        // Loop backwards, drawing the lower half of the waveform
        for (let x = waveform.length - 1; x >= 0; x--) {
          const val = channel.min_sample(x);
          ctx.lineTo(x + 0.5, scaleY(val, canvas.height) + 0.5);
        }

        ctx.closePath();
        ctx.stroke();
        ctx.fill();
      });
  } catch (error) {
    console.error(error);
  }

  // Audio Preview
  const audio = new Audio(path);
  audio.load();
  document.querySelector('button.play').disabled = true;
  document.querySelector('button.pause').disabled = true;
  audio.addEventListener('canplaythrough', (_event) => {
    document.querySelector('button.play').disabled = false;
    document.querySelector('button.pause').disabled = false;
  });

  document.querySelector('button.play').addEventListener('click', (_event) => {
    console.log('PLAY');
    audio.play(); // Promise
  });
  document.querySelector('button.pause').addEventListener('click', (_event) => {
    audio.pause(); // Promise
  });

  document.querySelector('input.original-file').value = pad.externalFile || '';

  document.querySelector('button.remove-pad').disabled = pad.avaliable;
  document.querySelector('button.remove-pad').addEventListener('click', (_event) => {
    state.pads[state.currentPad].remove = !state.pads[state.currentPad].remove;
    renderPads();
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
  dropZone.addEventListener('click', () => {
    ipcRenderer.send('pickFile');
  });
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.dataTransfer.files.length > 0) {
      const { path, size } = event.dataTransfer.files[0];
      setExternalFile(path, size);
    }

    dropZone.classList.remove('gradient-background');
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('gradient-background');
  });

  dropZone.addEventListener('dragenter', (_event) => {
    dropZone.classList.add('gradient-background');
  });

  dropZone.addEventListener('dragleave', (_event) => {
    dropZone.classList.remove('gradient-background');
  });
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

    // TODO: Need a better way of detecting state changes, otherwise we see issues:
    // https://github.com/MatthewCallis/super-pads/issues/108
    // https://github.com/MatthewCallis/super-pads/issues/121
    // loadState({ root });
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

// #region Workers
const parsePads = () => {
  const worker = new Worker('./src/workers/parsePads.js');
  worker.onmessage = (message) => {
    hideLoading();
    const { pads } = message.data;
    for (const pad of pads) {
      state.pads[pad.label] = {
        ...state.pads[pad.label],
        ...pad,
        convert: false,
        remove: false,
      };
    }
    renderPads();
  };
  worker.addEventListener('error', (werror) => {
    hideLoading();
    showError(werror);
  });
  showLoading();
  worker.postMessage({ root: state.root });
};

const encodePads = ({ file, directory, pads }) => {
  const worker = new Worker('./src/workers/encodePads.js');
  worker.onmessage = (message) => {
    hideLoading();

    const { error } = message.data;
    if (error) {
      showError(error);
      return;
    }

    parsePads();
  };
  worker.addEventListener('error', (werror) => {
    hideLoading();
    showError(werror);
  });
  showLoading();
  worker.postMessage({ file, directory, pads });
};

const encodeFileAsync = ({ file, directory, pad }) => new Promise((resolve, reject) => {
  const worker = new Worker('./src/workers/encodeFile.js');
  worker.onmessage = resolve;
  worker.addEventListener('error', reject);
  worker.postMessage({ file, directory, pad });
});

const removeFileAsync = ({ file, pad }) => new Promise((resolve, reject) => {
  const worker = new Worker('./src/workers/removeFile.js');
  worker.onmessage = resolve;
  worker.addEventListener('error', reject);
  worker.postMessage({ file, pad });
});

const saveState = () => {
  const worker = new Worker('./src/workers/saveState.js');
  worker.onmessage = (message) => {
    const { error } = message.data;
    if (error) {
      showError(error);
    }
  };
  worker.addEventListener('error', (werror) => {
    hideLoading();
    showError(werror);
  });
  worker.postMessage({ root: state.root, state });
};

const loadState = ({ root }) => {
  const worker = new Worker('./src/workers/loadState.js');
  worker.onmessage = (message) => {
    const { state: newState, error } = message.data;
    if (error) {
      // showError(error);
      parsePads();
      return;
    }
    state = {
      ...state,
      ...newState,
      root: state.root,
    };
    renderPads();
  };
  worker.addEventListener('error', (werror) => {
    hideLoading();
    showError(werror);
  });
  worker.postMessage({ root });
};

const renderAudioWaveform = ({ path }) => {
  const worker = new Worker('./src/workers/renderAudioWaveform.js');
  worker.onmessage = (message) => {
    const { ctx, error } = message.data;
    if (error) {
      // showError(error);
      parsePads();
      return;
    }
    console.log('ctx', ctx);
  };
  worker.addEventListener('error', (werror) => {
    showError(werror);
  });
  worker.postMessage({ path });
};
// #endregion
