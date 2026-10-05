/** Preserve the worker's diagnostic and recovery flag when converting a failure reply to an exception. */
function readWorkerResult(result) {
  if (result.error || result.success === false) {
    const message = result.error?.message || result.error || 'Worker failed.';
    const error = new Error(message);
    error.recoveryRequired = Boolean(result.recoveryRequired);
    throw error;
  }
  return result;
}

/**
 * Run one worker request, rejecting error replies and releasing the worker on every terminal path.
 * Optional cancellation is for browser preview workers; main-managed card operations run to completion.
 */
module.exports = function runWorker(name, data, { signal, transfer = [] } = {}) {
  const needsNode = ['parsePads', 'encodePads', 'writeCard', 'convertPattern', 'encodeFile'].includes(name);
  // Electron renderers cannot create Node threads. The main process owns ESM jobs and their cleanup.
  if (needsNode && process.type === 'renderer') {
    return require('electron').ipcRenderer.invoke('runDataWorker', { name, data }).then(readWorkerResult);
  }
  return new Promise((resolve, reject) => {
    let worker;
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      worker?.terminate();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(new DOMException('Preview cancelled.', 'AbortError'));
    if (signal?.aborted) { abort(); return; }
    try {
      // Chromium's worker loader cannot safely import the ESM-only data tools; use a Node thread for those jobs.
      if (needsNode) {
        worker = require('./createNodeWorker')(name);
      } else {
        worker = new Worker(`./src/workers/${name}.js`);
      }
      worker.onmessage = ({ data: result }) => {
        try { finish(null, readWorkerResult(result)); }
        catch (error) { finish(error); }
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        finish(new Error(event.message || 'Worker failed.'));
      };
      worker.onmessageerror = () => finish(new Error('Could not read worker response.'));
      signal?.addEventListener('abort', abort, { once: true });
      worker.postMessage(data, transfer);
    } catch (error) { finish(error); }
  });
};
