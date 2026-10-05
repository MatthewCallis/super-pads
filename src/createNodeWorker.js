const path = require('node:path');
const { Worker } = require('node:worker_threads');

/**
 * Expose the browser-worker contract on a main-process Node thread so ESM tools use Node's module loader.
 * Unexpected exits become errors; intentional termination after a reply or cancellation is silent.
 */
module.exports = function createNodeWorker(name) {
  const thread = new Worker(path.join(__dirname, 'workers', 'nodeWorker.js'), { workerData: { name } });
  let terminated = false;
  const worker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (data, transfer) => thread.postMessage(data, transfer),
    terminate() {
      terminated = true;
      thread.terminate().catch((error) => worker.onerror?.(error));
    },
  };
  thread.on('message', (data) => worker.onmessage?.({ data }));
  thread.on('messageerror', (error) => worker.onmessageerror?.(error));
  thread.on('error', (error) => worker.onerror?.(error));
  thread.on('exit', (code) => {
    // A thread that exits without a terminal reply must not leave the caller waiting forever.
    if (!terminated) worker.onerror?.(new Error(`Worker ${name} exited before replying (code ${code}).`));
  });
  return worker;
};
