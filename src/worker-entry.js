// Runs inside the Web Worker that index.js starts. The user's Worker code never runs on the page's thread:
// it has no `document`, no `window`, and reaches the page only through the messages below.
import { createWorkerRuntime } from './runtime.js';
import { loadSnapshot, saveSnapshot } from './idb.js';

let rt = null;
let saveTimer = 0;
const serviceCalls = new Map();
let serviceSeq = 0;

const reply = (id, result, transfer = []) => self.postMessage({ id, ok: true, result }, transfer);
const fail = (id, e) => self.postMessage({ id, ok: false, error: String(e?.stack ?? e?.message ?? e) });

function serviceProxy(name) {
  return {
    async fetch(req) {
      const sid = ++serviceSeq;
      const body = ['GET', 'HEAD'].includes(req.method) ? null : await req.arrayBuffer();
      const out = new Promise((resolve, reject) => serviceCalls.set(sid, { resolve, reject }));
      self.postMessage(
        { type: 'service', sid, name, request: { url: req.url, method: req.method, headers: [...req.headers], body } },
        body ? [body] : [],
      );
      const r = await out;
      return new Response([101, 204, 205, 304].includes(r.status) ? null : r.body, {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers,
      });
    },
  };
}

async function start(options) {
  const { persist, d1, serviceNames = [], ...rest } = options;
  const services = Object.fromEntries(serviceNames.map((n) => [n, serviceProxy(n)]));
  const storage = persist ? await loadSnapshot(persist).catch(() => ({})) : {};
  let openD1;
  if (d1?.module) openD1 = (await import(/* @vite-ignore */ d1.module)).default.bind(null, d1);
  rt = await createWorkerRuntime({
    ...rest,
    services,
    storage,
    openD1,
    onError: (e) => self.postMessage({ type: 'error', message: String(e?.stack ?? e) }),
    onChange: persist
      ? () => {
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => rt && saveSnapshot(persist, rt.snapshot()).catch(() => {}), 200);
        }
      : undefined,
  });
  return { name: rt.config.name, crons: rt.config.crons };
}

self.onmessage = async ({ data: m }) => {
  if (m.type === 'service-reply') {
    const c = serviceCalls.get(m.sid);
    serviceCalls.delete(m.sid);
    if (m.ok) c?.resolve(m.response);
    else c?.reject(new Error(m.error));
    return;
  }
  try {
    if (m.type === 'start') return reply(m.id, await start(m.options));
    if (!rt) throw new Error('The Worker has not started');
    if (m.type === 'fetch') {
      const { url, method, headers, body } = m.request;
      const res = await rt.fetch(new Request(url, { method, headers, body: body ?? undefined }));
      const out = [101, 204, 205, 304].includes(res.status) ? null : await res.arrayBuffer();
      return reply(
        m.id,
        { status: res.status, statusText: res.statusText, headers: [...res.headers], body: out },
        out ? [out] : [],
      );
    }
    if (m.type === 'scheduled') return reply(m.id, await rt.scheduled(m.cron));
    if (m.type === 'idle') return reply(m.id, await rt.idle());
    if (m.type === 'snapshot') return reply(m.id, rt.snapshot());
    throw new Error(`Unknown message ${m.type}`);
  } catch (e) {
    fail(m.id, e);
  }
};
