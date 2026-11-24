import { expect, test } from 'bun:test';
import { startWorker } from '../src/index.js';

test('failed startup terminates the worker before rejecting', async () => {
  let thread;
  let terminated = false;
  class TrackingWorker extends Worker {
    constructor(...args) {
      super(...args);
      thread = this;
    }
    terminate() {
      terminated = true;
      return super.terminate();
    }
  }

  try {
    await expect(startWorker({ code: 'export const example = 1', WorkerClass: TrackingWorker }))
      .rejects.toThrow('export default');
    expect(terminated).toBe(true);
  } finally {
    if (!terminated) thread?.terminate();
  }
});
