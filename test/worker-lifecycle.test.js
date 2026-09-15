const assert = require('node:assert/strict');
const { test } = require('node:test');
const runWorker = require('../src/runWorker');

for (const outcome of ['success', 'reply-error', 'runtime-error', 'clone-error', 'post-error', 'abort']) {
  test(`one-shot worker releases resources on ${outcome}`, async (t) => {
    let terminated = 0;
    let prevented = false;
    const controller = new AbortController();
    const original = global.Worker;
    t.after(() => { global.Worker = original; });
    global.Worker = class {
      terminate() { terminated++; }
      postMessage() {
        if (outcome === 'post-error') throw new Error('Cannot post');
        queueMicrotask(() => {
          if (outcome === 'success') this.onmessage({ data: { success: true } });
          if (outcome === 'reply-error') this.onmessage({ data: { success: false, error: 'Failed' } });
          if (outcome === 'clone-error') this.onmessageerror();
          if (outcome === 'runtime-error') this.onerror({ message: 'Failed', preventDefault: () => { prevented = true; } });
          if (outcome === 'abort') controller.abort();
        });
      }
    };
    const result = runWorker('fixture', {}, { signal: controller.signal });
    if (outcome === 'success') assert.equal((await result).success, true);
    else await assert.rejects(result);
    assert.equal(terminated, 1);
    controller.abort();
    assert.equal(terminated, 1);
    if (outcome === 'runtime-error') assert.equal(prevented, true);
  });
}
