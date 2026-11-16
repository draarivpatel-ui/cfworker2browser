// Workers KV and R2 as in-memory stores with the same calls a Worker makes on the platform.
// Kept in the tab's memory; `snapshot()` and `initial` let the caller save and restore them (see idb.js).
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (s) => btoa(String.fromCharCode(...enc.encode(s)));
const unb64 = (s) => dec.decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

export async function bytesOf(v) {
  if (v == null) return new Uint8Array();
  if (typeof v === 'string') return enc.encode(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  if (typeof v.getReader === 'function') return new Uint8Array(await new Response(v).arrayBuffer());
  if (typeof v.arrayBuffer === 'function') return new Uint8Array(await v.arrayBuffer());
  throw new TypeError('Unsupported value: use a string, ArrayBuffer, typed array, Blob or ReadableStream');
}

function asType(bytes, type) {
  switch (type) {
    case 'text':
      return dec.decode(bytes);
    case 'json':
      return JSON.parse(dec.decode(bytes));
    case 'arrayBuffer':
      return bytes.slice().buffer;
    case 'stream':
      return new Response(bytes.slice()).body;
    default:
      throw new TypeError(`Unknown type: ${type}. Use text, json, arrayBuffer or stream.`);
  }
}
const typeOf = (o) => (typeof o === 'string' ? o : (o?.type ?? 'text'));

export class MemoryKV {
  constructor({ initial, now = () => Date.now(), onChange } = {}) {
    this.m = new Map(initial ?? []);
    this.now = now;
    this.onChange = onChange;
  }

  #entry(key) {
    const e = this.m.get(key);
    if (!e) return null;
    if (e.expiration && e.expiration * 1000 <= this.now()) {
      this.m.delete(key);
      return null;
    }
    return e;
  }

  async get(key, opts) {
    if (Array.isArray(key)) return new Map(await Promise.all(key.map(async (k) => [k, await this.get(k, opts)])));
    const type = typeOf(opts);
    if (!['text', 'json', 'arrayBuffer', 'stream'].includes(type)) asType(new Uint8Array(), type);
    const e = this.#entry(key);
    return e ? asType(e.value, type) : null;
  }

  async getWithMetadata(key, opts) {
    if (Array.isArray(key)) {
      return new Map(await Promise.all(key.map(async (k) => [k, await this.getWithMetadata(k, opts)])));
    }
    const e = this.#entry(key);
    if (!e) return { value: null, metadata: null, cacheStatus: null };
    return { value: asType(e.value, typeOf(opts)), metadata: e.metadata ?? null, cacheStatus: null };
  }

  async put(key, value, opts = {}) {
    if (!key) throw new Error('KV PUT failed: 400 Key must not be empty');
    if (enc.encode(key).length > 512) throw new Error('KV PUT failed: 414 Key too long (max 512 bytes)');
    let expiration = null;
    if (opts.expirationTtl != null) {
      if (opts.expirationTtl < 60) {
        throw new Error(
          `KV PUT failed: 400 Invalid expiration_ttl of ${opts.expirationTtl}. Expiration TTL must be at least 60.`,
        );
      }
      expiration = Math.floor(this.now() / 1000) + opts.expirationTtl;
    } else if (opts.expiration != null) expiration = opts.expiration;
    const bytes = await bytesOf(value);
    if (bytes.length > 25 * 1024 * 1024) throw new Error('KV PUT failed: 413 Value too large (max 25 MiB)');
    this.m.set(key, { value: bytes, expiration, metadata: opts.metadata });
    this.onChange?.();
  }

  async delete(key) {
    this.m.delete(key);
    this.onChange?.();
  }

  async list({ prefix = '', limit = 1000, cursor } = {}) {
    const names = [...this.m.keys()].filter((k) => k.startsWith(prefix) && this.#entry(k)).sort();
    let start = 0;
    if (cursor) {
      const after = unb64(cursor);
      start = names.findIndex((n) => n > after);
      if (start < 0) start = names.length;
    }
    const page = names.slice(start, start + limit);
    const keys = page.map((name) => {
      const e = this.m.get(name);
      const k = { name };
      if (e.expiration) k.expiration = e.expiration;
      if (e.metadata !== undefined) k.metadata = e.metadata;
      return k;
    });
    if (start + limit >= names.length) return { keys, list_complete: true, cacheStatus: null };
    return { keys, list_complete: false, cursor: b64(page.at(-1)), cacheStatus: null };
  }

  snapshot() {
    return [...this.m.entries()];
  }
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function describe(key, e) {
  return {
    key,
    version: e.version,
    size: e.bytes.length,
    etag: e.etag,
    httpEtag: `"${e.etag}"`,
    checksums: {},
    uploaded: new Date(e.uploaded),
    httpMetadata: e.httpMetadata ?? {},
    customMetadata: e.customMetadata ?? {},
    storageClass: 'Standard',
    writeHttpMetadata(headers) {
      const m = this.httpMetadata;
      if (m.contentType) headers.set('content-type', m.contentType);
      if (m.contentLanguage) headers.set('content-language', m.contentLanguage);
      if (m.contentDisposition) headers.set('content-disposition', m.contentDisposition);
      if (m.contentEncoding) headers.set('content-encoding', m.contentEncoding);
      if (m.cacheControl) headers.set('cache-control', m.cacheControl);
    },
  };
}

export class MemoryR2 {
  constructor({ initial, now = () => Date.now(), onChange } = {}) {
    this.m = new Map(initial ?? []);
    this.now = now;
    this.onChange = onChange;
  }

  async put(key, value, opts = {}) {
    const bytes = await bytesOf(value);
    // R2 uses MD5 for the etag; WebCrypto has none, so this is a SHA-256 prefix. Same shape, different value.
    const etag = hex(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 32);
    const e = {
      bytes,
      etag,
      version: crypto.randomUUID().replace(/-/g, ''),
      uploaded: this.now(),
      httpMetadata: opts.httpMetadata,
      customMetadata: opts.customMetadata,
    };
    this.m.set(key, e);
    this.onChange?.();
    return describe(key, e);
  }

  async head(key) {
    const e = this.m.get(key);
    return e ? describe(key, e) : null;
  }

  async get(key) {
    const e = this.m.get(key);
    if (!e) return null;
    let used = false;
    const take = () => {
      if (used) throw new TypeError('Body has already been used.');
      used = true;
      return e.bytes.slice();
    };
    return {
      ...describe(key, e),
      get body() {
        return new Response(e.bytes.slice()).body;
      },
      get bodyUsed() {
        return used;
      },
      arrayBuffer: async () => take().buffer,
      text: async () => dec.decode(take()),
      json: async () => JSON.parse(dec.decode(take())),
      blob: async () => new Blob([take()], { type: e.httpMetadata?.contentType ?? '' }),
    };
  }

  async delete(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.m.delete(k);
    this.onChange?.();
  }

  async list({ prefix = '', limit = 1000, cursor, delimiter } = {}) {
    const names = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Math.max(0, names.findIndex((n) => n > unb64(cursor))) : 0;
    const objects = [];
    const delimitedPrefixes = new Set();
    let i = start;
    for (; i < names.length && objects.length + delimitedPrefixes.size < limit; i++) {
      const name = names[i];
      const cut = delimiter ? name.indexOf(delimiter, prefix.length) : -1;
      if (cut >= 0) delimitedPrefixes.add(name.slice(0, cut + delimiter.length));
      else objects.push(describe(name, this.m.get(name)));
    }
    const truncated = i < names.length && start !== -1;
    return {
      objects,
      truncated,
      ...(truncated ? { cursor: b64(names[i - 1]) } : {}),
      delimitedPrefixes: [...delimitedPrefixes],
    };
  }

  snapshot() {
    return [...this.m.entries()];
  }
}
