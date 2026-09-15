const { atomicWrite } = require('../fileStorage');

onmessage = (event) => {
  const { root, state } = event.data;

  if (!state) {
    postMessage({ success: false, error: 'No state.' });
    return;
  }
  if (!root) {
    postMessage({ success: false, error: 'No root.' });
    return;
  }

  try {
    atomicWrite(`${root}/super-pads.json`, JSON.stringify(state, null, 2));
    postMessage({ success: true });
  } catch (error) {
    postMessage({ success: false, error });
  }
};
