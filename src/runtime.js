// The Worker runtime: loads a Worker module, builds its `env` (vars, secrets, KV, R2, D1, service bindings) and
// calls its `fetch` and `scheduled` handlers the way the platform does. No browser API is needed except `Request`
// and `Response`, so it runs in a Web Worker (worker-entry.js), in Bun, and in Node 20+.
import { readConfig } from './config.js';
import { D1Database } from './d1.js';
import { MemoryKV, MemoryR2 } from './stores.js';

const utf8 = new TextEncoder();

// Loads an ES module from text. A blob: URL where there is one (works under a strict CSP that allows blob:),
// a data: URL elsewhere.
export async function loadModuleFromCode(code) {
  if (typeof URL.createObjectURL === 'function' && typeof Blob === 'function') {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try {
      return await import(/* @vite-ignore */ url);
    } finally {
      URL.revokeObjectURL?.(url);
    }
  }
  const b64 = btoa(String.fromCharCode(...utf8.encode(code)));
  return import(/* @vite-ignore */ `data:text/javascript;base64,${b64}`);
}

const serviceBinding = (svc) => ({
  fetch: (input, init) => svc.fetch(input instanceof Request ? input : new Request(input, init)),
});

export async function createWorkerRuntime({
  code,
  config = {},
  vars = {},
  secrets = {},
  bindings = {},
  services = {},
  storage = {},
  openD1,
  loadModule = loadModuleFromCode,
  onError = (e) => console.error(e),
  onChange,
} = {}) {
  if (typeof code !== 'string' || !code.trim()) throw new TypeError('createWorkerRuntime: `code` must be the Worker module text');
  const cfg = typeof config === 'string' ? readConfig(config) : { ...readConfig('{}'), ...config };
  const stores = { kv: {}, r2: {} };
  const env = { ...cfg.vars, ...vars, ...secrets };

  for (const { binding } of cfg.kv_namespaces) {
    env[binding] = stores.kv[binding] = new MemoryKV({
      initial: storage.kv?.[binding],
      onChange: () => onChange?.(),
    });
  }
  for (const { binding } of cfg.r2_buckets) {
    env[binding] = stores.r2[binding] = new MemoryR2({
      initial: storage.r2?.[binding],
      onChange: () => onChange?.(),
    });
  }
  for (const d of cfg.d1_databases) {
    if (!openD1) {
      Object.defineProperty(env, d.binding, {
        enumerable: true,
        get() {
          throw new Error(
            `The D1 binding ${d.binding} needs an SQLite engine in the browser. Pass \`d1\` to startWorker (see README, "D1").`,
          );
        },
      });
    } else env[d.binding] = new D1Database(await openD1(d));
  }
  for (const { binding, service } of cfg.services) {
    if (!services[service]) throw new Error(`Service binding ${binding} points to "${service}", which was not passed in \`services\``);
    env[binding] = serviceBinding(services[service]);
  }
  Object.assign(env, bindings);

  const mod = await loadModule(code);
  const handler = mod.default;
  if (!handler || (typeof handler.fetch !== 'function' && typeof handler.scheduled !== 'function')) {
    throw new TypeError(
      'The Worker must be an ES module with `export default { fetch }` (or `scheduled`). Service-worker syntax (addEventListener) is not supported.',
    );
  }

  const pending = new Set();
  const makeCtx = () => ({
    waitUntil(p) {
      const t = Promise.resolve(p).catch(onError);
      pending.add(t);
      t.finally(() => pending.delete(t));
    },
    passThroughOnException() {},
    props: {},
  });

  return {
    config: cfg,
    env,
    async fetch(request) {
      if (typeof handler.fetch !== 'function') return new Response('This Worker has no fetch handler', { status: 500 });
      Object.defineProperty(request, 'cf', { value: { colo: 'BROWSER', country: 'XX' }, configurable: true });
      try {
        const res = await handler.fetch(request, env, makeCtx());
        if (!(res instanceof Response)) throw new TypeError('Worker fetch() must return a Response');
        return res;
      } catch (e) {
        onError(e);
        // What the platform answers when a Worker throws.
        return new Response('Error 1101: Worker threw exception', { status: 500, headers: { 'content-type': 'text/plain' } });
      }
    },
    async scheduled(cron = cfg.crons[0] ?? '* * * * *') {
      if (typeof handler.scheduled !== 'function') throw new TypeError('This Worker has no scheduled handler');
      await handler.scheduled({ cron, type: 'scheduled', scheduledTime: Date.now(), noRetry() {} }, env, makeCtx());
    },
    // Resolves when every waitUntil promise has finished.
    async idle() {
      while (pending.size) await Promise.all([...pending]);
    },
    snapshot() {
      return {
        kv: Object.fromEntries(Object.entries(stores.kv).map(([k, s]) => [k, s.snapshot()])),
        r2: Object.fromEntries(Object.entries(stores.r2).map(([k, s]) => [k, s.snapshot()])),
      };
    },
  };
}
