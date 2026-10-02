// An in-memory stand-in for Postgres + Electric that follows the parts of the
// Electric HTTP protocol the TanStack DB Electric collection relies on.
//
// It exists because hand-rolled one-off mocks drift from the protocol (the
// first version of create-navigation-repro answered every request, including
// the follow-up that should carry `up-to-date`, instantly with the same
// `snapshot-end` body; the Electric client failed and it looked like a
// TanStack DB bug). `contract.test.mjs` runs the real `@electric-sql/client`
// against this server, so protocol drift fails loudly instead of silently.
// The request/response sequence was checked against Electric 1.7.10.
//
// Modelled behaviour:
// - Writes are committed to "Postgres" immediately and get a txid.
// - Electric sees a commit only after `replicationLagMs` (logical replication).
// - `offset=-1` returns the replicated state ending in `snapshot-end`; the
//   follow-up request at the returned offset answers `up-to-date`.
// - `live=true` long-polls until a change is replicated or `longPollMs` passes.
// - Subset snapshots (POST, progressive / on-demand mode) query "Postgres"
//   directly, so they can see commits Electric has not replicated yet. They
//   return Postgres snapshot metadata so the client can deduplicate later
//   stream messages.
//
// Not modelled: subqueries in shape `where` clauses (move-in/move-out), shape
// rotation (409), HTTP caching, chunking, SSE. Use a real Electric for those
// (see real-electric/).

const SCHEMA = `public`;

export const defaultConfig = {
  replicationLagMs: 0,
  initialSyncDelayMs: 0,
  subsetDelayMs: 0,
  longPollMs: 20000,
};

export function createFakeElectric(initialConfig = {}) {
  let config = { ...defaultConfig, ...initialConfig };
  let generation = 0;
  let nextTxid = 1000;
  let cursor = 0;
  const tables = new Map();
  const requests = [];

  function table(name) {
    let state = tables.get(name);
    if (!state) {
      state = {
        committed: new Map(), // what Postgres has
        log: [], // what Electric has replicated, in commit order
        waiters: new Set(),
      };
      tables.set(name, state);
    }
    return state;
  }

  function messageKey(tableName, id) {
    return `"${SCHEMA}"."${tableName}"/"${id}"`;
  }

  function changeMessage(tableName, entry) {
    return {
      key: messageKey(tableName, entry.value.id),
      value: entry.value,
      headers: {
        operation: entry.operation,
        relation: [SCHEMA, tableName],
        txids: [entry.txid],
        lsn: String(entry.txid),
        op_position: 0,
      },
    };
  }

  function replicatedRows(state) {
    const rows = new Map();
    for (const entry of state.log) {
      if (entry.operation === `delete`) rows.delete(entry.value.id);
      else rows.set(entry.value.id, entry.value);
    }
    return rows;
  }

  function parseOffset(offset) {
    if (offset === `-1`) return -1;
    const match = /^(\d+)_0$/.exec(offset ?? ``);
    if (!match) throw new Error(`fake-electric: unsupported offset ${offset}`);
    return Number(match[1]);
  }

  function setShapeHeaders(response, tableName, offset) {
    response.setHeader(`content-type`, `application/json`);
    response.setHeader(`electric-handle`, `fake-${tableName}-${generation}`);
    response.setHeader(`electric-offset`, `${offset}_0`);
    response.setHeader(`electric-schema`, `{}`);
    response.setHeader(`cache-control`, `no-store`);
  }

  function upToDate(response, tableName, offset, messages) {
    setShapeHeaders(response, tableName, offset);
    response.setHeader(`electric-cursor`, String(++cursor));
    response.setHeader(`electric-up-to-date`, ``);
    response.end(
      JSON.stringify([...messages, { headers: { control: `up-to-date` } }]),
    );
  }

  // Minimal SQL support for subset snapshots: conjunctions of `"col" = $n` and
  // `"col" = ANY($n)` (join lookups), plus `true = true`, which the collection
  // sends for unfiltered queries.
  // Anything else is rejected so an unsupported query fails loudly.
  function compileSubsetWhere(where, params = {}) {
    if (!where) return () => true;
    const clauses = unwrap(where)
      .split(/\s+AND\s+/i)
      .map((clause) => unwrap(clause.trim()));
    const predicates = clauses.map((clause) => {
      if (/^true\s*=\s*true$/i.test(clause)) return () => true;
      const any = /^"([^"]+)"\s*=\s*ANY\(\$(\d+)\)$/i.exec(clause);
      if (any) {
        const [, column, index] = any;
        const values = new Set(parsePgArray(paramAt(params, index)));
        return (row) => values.has(String(row[column]));
      }
      const match = /^"([^"]+)"\s*=\s*\$(\d+)$/.exec(clause);
      if (!match) {
        throw new Error(`fake-electric: unsupported subset where: ${where}`);
      }
      const [, column, index] = match;
      const value = paramAt(params, index);
      return (row) => String(row[column]) === String(value);
    });
    return (row) => predicates.every((predicate) => predicate(row));
  }

  // Strips parentheses that wrap the whole expression, e.g. `(("a" = $1))`.
  function unwrap(expression) {
    let current = expression.trim();
    while (current.startsWith(`(`) && current.endsWith(`)`)) {
      let depth = 0;
      let wrapsAll = true;
      for (let i = 0; i < current.length - 1; i++) {
        if (current[i] === `(`) depth++;
        else if (current[i] === `)`) depth--;
        if (depth === 0) {
          wrapsAll = false;
          break;
        }
      }
      if (!wrapsAll) break;
      current = current.slice(1, -1).trim();
    }
    return current;
  }

  function paramAt(params, index) {
    return Array.isArray(params) ? params[index - 1] : params[index];
  }

  // Parses a one-dimensional Postgres text array literal such as {"a","b"}.
  function parsePgArray(literal) {
    const inner = String(literal).replace(/^\{(.*)\}$/s, `$1`);
    if (!inner) return [];
    return inner.split(`,`).map((item) => item.replace(/^"(.*)"$/s, `$1`));
  }

  async function readBody(request) {
    let body = ``;
    for await (const chunk of request) body += chunk;
    return body ? JSON.parse(body) : {};
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function handleShape(request, response) {
    const url = new URL(request.url, `http://fake-electric`);
    const tableName = url.searchParams.get(`table`);
    if (!tableName) {
      response.statusCode = 400;
      response.end(`fake-electric: table parameter is required`);
      return;
    }
    const state = table(tableName);
    const live = url.searchParams.get(`live`) === `true`;
    const offset = parseOffset(url.searchParams.get(`offset`));
    requests.push({ method: request.method, table: tableName, live, offset });

    if (request.method === `POST`) {
      const body = await readBody(request);
      await delay(config.subsetDelayMs);
      const matches = compileSubsetWhere(body.where, body.params);
      const rows = [...state.committed.values()].filter(matches);
      const limited = body.limit ? rows.slice(0, body.limit) : rows;
      setShapeHeaders(response, tableName, state.log.length);
      response.end(
        JSON.stringify({
          metadata: {
            xmin: String(nextTxid),
            xmax: String(nextTxid),
            xip_list: [],
            snapshot_mark: Math.floor(Math.random() * 1e9),
            database_lsn: String(nextTxid),
          },
          data: limited.map((value) => ({
            key: messageKey(tableName, value.id),
            value,
            headers: { operation: `insert`, relation: [SCHEMA, tableName] },
          })),
        }),
      );
      return;
    }

    if (offset === -1) {
      await delay(config.initialSyncDelayMs);
      const rows = [...replicatedRows(state).values()].map((value) => ({
        key: messageKey(tableName, value.id),
        value,
        headers: { operation: `insert`, relation: [SCHEMA, tableName] },
      }));
      // Like Electric: the snapshot ends with `snapshot-end`, not
      // `up-to-date`; the client then asks again at the returned offset.
      setShapeHeaders(response, tableName, state.log.length);
      response.end(
        JSON.stringify([
          ...rows,
          {
            headers: {
              control: `snapshot-end`,
              xmin: String(nextTxid),
              xmax: String(nextTxid),
              xip_list: [],
            },
          },
        ]),
      );
      return;
    }

    const pending = () =>
      state.log
        .slice(offset)
        .map((entry) => changeMessage(tableName, entry));

    if (!live || state.log.length > offset) {
      upToDate(response, tableName, state.log.length, pending());
      return;
    }

    // Long-poll like Electric: hold the request until something replicates.
    await new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        state.waiters.delete(waiter);
        resolve();
      };
      const timer = setTimeout(waiter, config.longPollMs);
      state.waiters.add(waiter);
      // `request` emits `close` once its (empty) body is read, so watch the
      // socket to notice the client disconnecting.
      response.on(`close`, waiter);
      request.socket.once(`close`, waiter);
    });
    if (response.destroyed || response.writableEnded) return;
    upToDate(response, tableName, state.log.length, pending());
  }

  // Commit one Postgres transaction (one txid) touching any number of tables.
  // Electric sees it after the replication lag.
  function commitTransaction(writes) {
    const txid = nextTxid++;
    for (const { table: tableName, operation, value } of writes) {
      const state = table(tableName);
      if (operation === `delete`) state.committed.delete(value.id);
      else state.committed.set(value.id, value);
    }
    setTimeout(() => {
      for (const { table: tableName, operation, value } of writes) {
        const state = table(tableName);
        state.log.push({ operation, value, txid });
        for (const waiter of [...state.waiters]) waiter();
      }
    }, config.replicationLagMs);
    return txid;
  }

  function commit(tableName, operation, value) {
    return commitTransaction([{ table: tableName, operation, value }]);
  }

  function reset(nextConfig = {}) {
    for (const state of tables.values()) {
      for (const waiter of [...state.waiters]) waiter();
    }
    tables.clear();
    requests.length = 0;
    generation++;
    config = { ...defaultConfig, ...nextConfig };
  }

  return {
    handleShape,
    commit,
    commitTransaction,
    reset,
    get config() {
      return config;
    },
    requests,
  };
}

// Vite plugin: mounts the fake shape endpoint plus control endpoints the
// Playwright runner uses to reset state between scenarios.
export function fakeElectricPlugin({ shapePath = `/v1/shape`, api } = {}) {
  const electric = createFakeElectric();
  return {
    name: `fake-electric`,
    configureServer(server) {
      server.middlewares.use(shapePath, (request, response) => {
        electric.handleShape(request, response).catch((error) => {
          response.statusCode = 500;
          response.end(String(error?.message ?? error));
        });
      });
      server.middlewares.use(`/__fake/reset`, async (request, response) => {
        let body = ``;
        for await (const chunk of request) body += chunk;
        electric.reset(body ? JSON.parse(body) : {});
        response.end(`ok`);
      });
      server.middlewares.use(`/__fake/requests`, (_request, response) => {
        response.setHeader(`content-type`, `application/json`);
        response.end(JSON.stringify(electric.requests));
      });
      api?.(server, electric);
    },
  };
}
