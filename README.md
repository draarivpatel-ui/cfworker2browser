# cfworker2browser

Run a Cloudflare Worker in the visitor's own browser tab. No account, no key, no server, no cost.

[Kitesurf](https://github.com/cloudflare/kitesurf) puts a browser inside a Worker. This does the opposite: it puts a Worker inside a browser.
Same idea as [linux2wasm](https://github.com/flisk-sh/fleet) (the fleet browser pod runs Linux in the tab):
the page is the host, and closing the tab ends it.

```js
import { startWorker } from 'https://your.site/cfworker2browser/src/index.js';

const w = await startWorker({
  code: workerModuleText,   // your Worker, bundled to one ES module
  config: wranglerTomlText, // optional: vars and bindings come from it
});
const res = await w.fetch('https://worker.local/hello'); // a real Response
console.log(res.status, await res.text());
await w.stop();
```

Try it: serve this folder (`python3 -m http.server`) and open `/demo/`.

## What runs

| Worker feature | In the tab |
|---|---|
| `export default { fetch, scheduled }` | yes. `w.scheduled(cron)` runs it once; there is no timer |
| `env` vars, secrets, `wrangler.toml` / `wrangler.jsonc` | yes (`vars`, `secrets` options override the file) |
| KV (`get`, `getWithMetadata`, `put`, `delete`, `list`, expiry, metadata) | yes, in memory |
| R2 (`put`, `get`, `head`, `delete`, `list` with prefix and delimiter) | yes, in memory. The etag is a SHA-256 prefix, not MD5. No ranges or conditional reads |
| D1 (`prepare`, `bind`, `all`, `run`, `first`, `raw`, `batch`, `exec`) | yes, on SQLite as WebAssembly (sql.js). Starts empty on every start |
| Service bindings | yes: pass other workers in `services` |
| `ctx.waitUntil`, `request.cf` | yes (`cf` is `{ colo: 'BROWSER', country: 'XX' }`). `await w.idle()` waits for `waitUntil` work |
| Durable Objects, Queues, Workers AI, Vectorize, Hyperdrive, Cache API, HTMLRewriter, WebSocket upgrades, TCP sockets | no |
| Service-worker syntax (`addEventListener('fetch')`) | no. Use the module syntax |

It is not `workerd`. It is your Worker's JavaScript on the browser's engine, with the Workers APIs above around it. A Worker that only uses
`fetch`, `Request`, `Response`, `URL`, `crypto` and those bindings behaves the same. One that needs the rest does not run here.

## Bundle first

The Worker is one ES module: a bare `import { Hono } from 'hono'` cannot be resolved in a tab. Bundle it the way Wrangler does:

```bash
npx wrangler deploy --dry-run --outdir dist   # dist/index.js is the module to pass as `code`
```

## Isolation

The Worker runs in a Web Worker, not on the page's thread. It has no `document`, no `window`, no cookies of the page,
and reaches the page only through `startWorker`'s messages (and the `services` you pass). It can still call `fetch` to other
sites like any script in the tab, subject to CORS. Do not run Workers you do not trust with secrets you care about.

## Options

| Option | |
|---|---|
| `code` | the Worker module text (required) |
| `config` | `wrangler.toml` or `wrangler.jsonc` text |
| `vars`, `secrets` | extra `env` values |
| `services` | `{ name: worker }`: other `startWorker` results, for `[[services]]` bindings |
| `persist` | a name. KV and R2 are saved in IndexedDB under it and restored on the next start |
| `d1` | `{ module, sqlJs, wasm }`, see below |
| `entry`, `WorkerClass` | where `worker-entry.js` is, and the Worker constructor (for tests) |

### D1

`sh vendor/get.sh` downloads sql.js 1.12.0 (`sql-wasm.js`, `sql-wasm.wasm`, MIT) and checks each file against a pinned sha256.

```js
const base = location.origin + '/cfworker2browser/';
await startWorker({
  code, config,
  d1: { module: base + 'src/d1-sqljs.js', sqlJs: base + 'vendor/sql-wasm.js', wasm: base + 'vendor/sql-wasm.wasm' },
});
```

The database is in memory: run your migrations when the Worker starts. Without `d1`, using a D1 binding throws an error that says so.

## Content-Security-Policy

A page that runs this needs `worker-src blob:` and `script-src 'wasm-unsafe-eval'` (only for D1). The Worker module is loaded from a `blob:` URL.

## Test

```bash
sh vendor/get.sh
bun test
```

The suite runs the Worker in a real Web Worker thread, including the sql.js path. It also runs in a browser: the demo and the
`persist` and D1 paths were checked in a browser.

## License

MIT. sql.js is MIT. The idea of running a runtime inside the page comes from the fleet browser pod; the reverse direction is Cloudflare's
[Kitesurf](https://github.com/cloudflare/kitesurf) (Apache-2.0), which this repository does not use or copy.
