// D1 for the browser: SQLite as WebAssembly, from sql.js (https://github.com/sql-js/sql.js, MIT).
// Pass it to startWorker as   d1: { module: new URL('./d1-sqljs.js', ...).href, sqlJs: '<url of sql-wasm.js>', wasm: '<url of sql-wasm.wasm>' }
// `sh vendor/get.sh` downloads both files, checked against a pinned sha256.
// The database is in memory: a reload starts it empty (run your migrations on start).

let engine;

// sql.js ships as a script, not an ES module, so the text is evaluated as CommonJS.
async function load({ sqlJs, wasm }) {
  engine ??= (async () => {
    const text = await (await fetch(sqlJs)).text();
    const module = { exports: {} };
    // `process` is hidden so sql.js takes its browser path (fetch + WebAssembly) even where a Node-like global exists.
    new Function('module', 'exports', 'require', 'process', text)(module, module.exports, () => {
      throw new Error('require is not available');
    }, undefined);
    // The wasm bytes are fetched here and handed over, so sql.js needs no loader of its own (and works in any worker).
    const wasmBinary = await (await fetch(wasm)).arrayBuffer();
    return module.exports({ wasmBinary });
  })();
  return engine;
}

export function adapterOver(db) {
  return {
    exec(sql, params) {
      const stmt = db.prepare(sql);
      try {
        if (params.length) stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.get());
        const columns = stmt.getColumnNames();
        const changes = db.getRowsModified();
        const lastRowId = db.exec('select last_insert_rowid()')[0].values[0][0];
        return { columns, rows, changes: rows.length ? 0 : changes, lastRowId };
      } finally {
        stmt.free();
      }
    },
    script(sql) {
      db.exec(sql);
    },
  };
}

export default async function openD1(options) {
  const SQL = await load(options);
  return adapterOver(new SQL.Database());
}
