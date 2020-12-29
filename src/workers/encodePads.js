const fs = require('fs');

const { AudioPadInfo } = require('@uttori/audio-padinfo');

onmessage = (event) => {
  const { file, directory, pads } = event.data;

  if (!file) {
    postMessage({ success: false, error: 'No file.' });
    return;
  }
  if (!directory) {
    postMessage({ success: false, error: 'No directory.' });
    return;
  }
  if (!pads || !Array.isArray(pads) || pads.length === 0) {
    postMessage({ success: false, error: 'No pads.' });
    return;
  }

  // Build the PAD_INFO.BIN binary data
  const parts = pads.map((pad) => AudioPadInfo.encodePad(pad));
  const output = Buffer.concat(parts);
  fs.writeFileSync(`${directory}${file}`, output, { flag: 'w' });

  postMessage({ success: true });
};
