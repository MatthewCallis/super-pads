const path = require('node:path');
const { atomicWrite } = require('../fileStorage');
const { encodePads } = require('../padMetadata');

/** Safely replace standalone metadata; the UI uses the complete writeCard transaction. */
onmessage = async ({ data: { file, directory, pads } }) => {
  try {
    if (file !== 'PAD_INFO.BIN' || !directory) throw new Error('Invalid metadata destination.');
    atomicWrite(path.join(directory, file), await encodePads(pads));
    postMessage({ success: true });
  } catch (error) { postMessage({ success: false, error: error.message }); }
};
