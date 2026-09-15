const writeCard = require('../writeCard');

/** Return one terminal result; the renderer retains its pending changes on failure. */
onmessage = async ({ data }) => {
  try {
    postMessage({ success: true, ...await writeCard(data) });
  } catch (error) {
    postMessage({ success: false, error: error.message, recoveryRequired: Boolean(error.recoveryRequired) });
  }
};
