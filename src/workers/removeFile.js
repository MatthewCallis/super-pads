const fs = require('fs');

onmessage = (event) => {
  const { file, pad } = event.data;

  if (!file) {
    postMessage({ success: false, error: 'No file.' });
    return;
  }

  try {
    fs.unlinkSync(file);
    postMessage({ success: true, pad });
  } catch (error) {
    postMessage({ success: false, pad, error });
  }
};
