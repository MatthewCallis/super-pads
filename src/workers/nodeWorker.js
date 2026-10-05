const { parentPort, workerData } = require('node:worker_threads');

// Only migrated workers need Node's ESM loader; keep the entry point limited to those operations.
if (!['parsePads', 'encodePads', 'writeCard', 'convertPattern', 'encodeFile'].includes(workerData.name)) {
  throw new Error('Unsupported Node worker operation.');
}

global.onmessage = null;
global.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
require(`./${workerData.name}.js`);

/** Adapt one request to the existing worker handlers, including their asynchronous import failures. */
parentPort.on('message', async (data) => {
  try {
    await global.onmessage({ data });
  } catch (error) {
    global.postMessage({ success: false, error: error.message });
  }
});
