const path = require('path');
const fs = require('fs');

const { AudioPadInfo } = require('@uttori/audio-padinfo');
const { AudioWAV } = require('@uttori/audio-wave');

const getLabel = (file) => file.replaceAll('.WAV', '').replaceAll('0', '');

onmessage = (event) => {
  const { root } = event.data;

  if (!root) {
    postMessage({ success: false, error: 'No root.' });
    return;
  }

  let pads = [];
  try {
    const data = fs.readFileSync(`${root}/ROLAND/SP-404SX/SMPL/PAD_INFO.BIN`);
    const api = AudioPadInfo.fromFile(data);
    pads = api.pads;
  } catch (error) {
    postMessage({ error });
  }

  // Add file meta-data for each pad with a file
  if (pads.length > 0) {
    const files = fs.readdirSync(`${root}/ROLAND/SP-404SX/SMPL/`);
    files.forEach((file) => {
      if (file[0] !== '.' && path.extname(file) === '.WAV') {
        const label = getLabel(file);
        const pad = pads.find((p) => p.label === label);
        if (pad) {
          const { size } = fs.statSync(`${root}/ROLAND/SP-404SX/SMPL/${file}`);
          const data = fs.readFileSync(`${root}/ROLAND/SP-404SX/SMPL/${file}`);
          const { chunks } = AudioWAV.fromFile(data);
          const { duration } = chunks.find((c) => c.type === 'data').value;

          pad.duration = duration;
          pad.size = size;
        }
      } else {
        // console.log('Extra File:', file);
      }
    });
  }

  postMessage({ success: true, pads });
};
