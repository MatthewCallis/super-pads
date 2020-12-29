const fs = require('fs');

onmessage = (event) => {
  const { root } = event.data;

  if (!root) {
    postMessage({ success: false, error: 'No root.' });
    return;
  }

  try {
    const data = fs.readFileSync(`${root}/super-pads.json`);
    const state = JSON.parse(data);
    postMessage({ success: true, state });
  } catch (error) {
    postMessage({ success: false, error });
  }
};
