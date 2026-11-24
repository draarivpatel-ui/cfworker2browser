// cfworker2browser: run a Cloudflare Worker in the visitor's own browser tab.
//
//   const w = await startWorker({ code, config });          // code: the bundled Worker module, config: wrangler.toml text
//   const res = await w.fetch('https://worker.local/hello'); // a real Response
//   await w.stop();
//
// The Worker runs in a Web Worker, so it cannot touch the page. Everything it stores lives in the tab (or IndexedDB
// with `persist`). Nothing is sent to Cloudflare.
export { readConfig, parseToml } from './config.js';

const NO_BODY = [101, 204, 205, 304];

export async function startWorker({
  code,
  config = '',
  vars,
  secrets,
  services = {},
  d1,
  persist,
  entry = new URL('./worker-entry.js', import.meta.url),
  WorkerClass = globalThis.Worker,
  onError = (msg) => console.error(msg),
} = {}) {
  if (!WorkerClass) throw new Error('startWorker needs a browser (or a runtime with Web Workers)');
  const worker = new WorkerClass(entry, { type: 'module' });
  let seq = 0;
  const calls = new Map();
  let stopped = false;

  worker.onmessage = async ({ data: m }) => {
    if (m.type === 'error') return onError(m.message);
    if (m.type === 'service') {
      // The Worker called a service binding: answer from the other worker the caller passed in.
      try {
        const { url, method, headers, body } = m.request;
        const res = await services[m.name].fetch(new Request(url, { method, headers, body: body ?? undefined }));
        const out = NO_BODY.includes(res.status) ? null : await res.arrayBuffer();
        worker.postMessage(
          { type: 'service-reply', sid: m.sid, ok: true, response: { status: res.status, statusText: res.statusText, headers: [...res.headers], body: out } },
          out ? [out] : [],
        );
      } catch (e) {
        worker.postMessage({ type: 'service-reply', sid: m.sid, ok: false, error: String(e?.message ?? e) });
      }
      return;
    }
    const c = calls.get(m.id);
    if (!c) return;
    calls.delete(m.id);
    if (m.ok) c.resolve(m.result);
    else c.reject(new Error(m.error));
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || 'The Worker thread crashed');
    for (const c of calls.values()) c.reject(err);
    calls.clear();
  };

  const call = (message, transfer = []) => {
    if (stopped) return Promise.reject(new Error('This worker has stopped'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject });
      worker.postMessage({ id, ...message }, transfer);
    });
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    worker.terminate();
    for (const c of calls.values()) c.reject(new Error('This worker has stopped'));
    calls.clear();
  }

  let info;
  try {
    info = await call({
      type: 'start',
      options: { code, config, vars, secrets, persist, d1, serviceNames: Object.keys(services) },
    });
  } catch (e) {
    stop();
    throw e;
  }

  return {
    name: info.name,
    crons: info.crons,
    // Same arguments as the global fetch: a URL string, a URL, or a Request. Only the path and query matter to most Workers.
    async fetch(input, init) {
      const req = input instanceof Request ? input : new Request(input, init);
      const body = ['GET', 'HEAD'].includes(req.method) ? null : await req.arrayBuffer();
      const r = await call({ type: 'fetch', request: { url: req.url, method: req.method, headers: [...req.headers], body } }, body ? [body] : []);
      return new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
    },
    scheduled: (cron) => call({ type: 'scheduled', cron }),
    // Resolves when every ctx.waitUntil() promise has finished.
    idle: () => call({ type: 'idle' }),
    // KV and R2 contents, as saved by `persist`.
    snapshot: () => call({ type: 'snapshot' }),
    async stop() { stop(); },
  };
}
