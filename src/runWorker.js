/**
 * Run one browser-worker request, rejecting error replies and releasing the worker on every terminal path.
 * Optional cancellation is for preview work; do not abort a card commit midway through its worker.
 */
module.exports = function runWorker(name, data, { signal, transfer = [] } = {}) {
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
      worker = new Worker(`./src/workers/${name}.js`);
      worker.onmessage = ({ data: result }) => {
        if (result.error || result.success === false) {
          const message = result.error?.message || result.error || 'Worker failed.';
          const error = new Error(message);
          error.recoveryRequired = Boolean(result.recoveryRequired);
          finish(error);
        } else finish(null, result);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        finish(new Error(event.message || 'Worker failed.'));
      };
      worker.onmessageerror = () => finish(new Error('Could not read worker response.'));
      signal?.addEventListener('abort', abort, { once: true });
      worker.postMessage(data, transfer);
    } catch (error) { finish(error); }
  });
};
