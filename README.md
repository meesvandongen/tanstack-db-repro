# TanStack DB create → navigate reproductions

Two browser repros for "optimistically create a row, then immediately render
a parameterized `findOne()` detail view" with `@tanstack/electric-db-collection`.
Both run against a shared fake Electric server whose protocol behaviour is
checked by a contract test. `service-account-repro` can also run against a real
backend and Electric 1.7.10 ([Real backend](#running-against-a-real-backend)).

```sh
pnpm install
pnpm test:fake                # the fake speaks the protocol the real clients expect
pnpm repro                    # create-navigation-repro (reports)
pnpm repro:service-account    # service-account-repro (service accounts)
API_URL=http://127.0.0.1:3000 pnpm repro:service-account   # against a real backend
```

If Playwright's bundled Chromium for this version is not installed, point the
harness at another Chromium: `CHROMIUM_PATH=/path/to/chrome pnpm repro`.

Exit codes: `0`: every run ended in the expected state. `1`: a valid run
showed the row as missing (service account) or not found at the end
(create navigation). `2`: the harness itself is broken (page error,
`console.error`, or Electric sync error). A run with code `2` says nothing
about TanStack DB.

## Findings

### 1. The first `create-navigation-repro` was not a TanStack DB bug

Its shape endpoint answered every request instantly with the same
`snapshot-end` body. Real Electric 1.7.10 also ends the first `offset=-1`
response with `snapshot-end`, but it answers the follow-up `offset=0_0` request
with `up-to-date`, and then holds `live=true` requests open. The mock never sent
`up-to-date`, so the client re-polled `offset=0_0` until its fast-retry-loop
guard failed the stream. `reports` then went into the `error` state:

- `useLiveSuspenseQuery` rethrew the error. With no error boundary, React
  unmounted the root, so the `0` count meant **crashed**, not **suspended**.
- `useLiveQuery` hit the same error, but kept rendering the optimistic row
  (`status: 'error'`, `$synced: false`). Counting DOM nodes read that as a
  pass.

The regression came in `29c407b`. The earlier mock (`879d04f`) sent
`up-to-date`. The `29c407b` mock is kept as
`create-navigation-repro/original-mock.mjs`. `MOCK=original pnpm repro` now
reports it as `INVALID`.

With a protocol-correct server, both hooks render the created report:

```text
fast initial sync  suspense ok      suspended@36ms -> found@337ms
fast initial sync  plain    ok      found@32ms
slow initial sync  suspense ok      suspended@34ms -> found@1555ms
slow initial sync  plain    ok      found@28ms
```

`slow initial sync` shows by-design behaviour: `useLiveSuspenseQuery` waits
for the source collection's first sync, even when the row already exists
optimistically. The extra ~300 ms in every Suspense reveal is React's
Suspense fallback throttle, not TanStack DB.

### 2. Service account: when the new row shows as missing

In `service-account-repro`, the API creates a service account as a `users` row
plus a `service_accounts` row in one transaction, and the `PUT` returns that
transaction's txid. The fake models a typical cold start: the API commits after
150 ms, Electric replicates 300 ms later, and the first full sync takes 400 ms.
After each run the runner also opens the detail page fresh, like a refresh.
Results:

```text
progressive no-join collection cold awaitTxId=no  suspense  ok             suspended@52ms -> found@462ms  | refresh: found
progressive no-join collection cold awaitTxId=no  plain     ok             found@32ms  | refresh: found
progressive no-join collection cold awaitTxId=yes suspense  ok             suspended@32ms -> found@425ms  | refresh: found
progressive no-join collection cold awaitTxId=yes plain     ok             found@32ms  | refresh: found
progressive no-join collection warm awaitTxId=no  suspense  ok             suspended@22ms -> found@321ms  | refresh: found
progressive no-join collection warm awaitTxId=no  plain     ok             found@31ms  | refresh: found
progressive no-join collection warm awaitTxId=yes suspense  ok             suspended@22ms -> found@322ms  | refresh: found
progressive no-join collection warm awaitTxId=yes plain     ok             found@22ms  | refresh: found
progressive join    collection cold awaitTxId=no  suspense  SHOWS MISSING  suspended@41ms -> missing@455ms -> found@478ms  | refresh: found
progressive join    collection cold awaitTxId=no  plain     SHOWS MISSING  loading@38ms -> missing@449ms -> found@470ms  | refresh: found
progressive join    collection cold awaitTxId=yes suspense  SHOWS MISSING  suspended@44ms -> missing@455ms -> found@473ms  | refresh: found
progressive join    collection cold awaitTxId=yes plain     SHOWS MISSING  loading@35ms -> missing@446ms -> found@479ms  | refresh: found
progressive join    collection warm awaitTxId=no  suspense  SHOWS MISSING  missing@24ms -> found@481ms  | refresh: found
progressive join    collection warm awaitTxId=no  plain     SHOWS MISSING  missing@28ms -> found@470ms  | refresh: found
progressive join    collection warm awaitTxId=yes suspense  SHOWS MISSING  missing@24ms -> found@485ms  | refresh: found
progressive join    collection warm awaitTxId=yes plain     SHOWS MISSING  missing@23ms -> found@468ms  | refresh: found
progressive join    action     cold awaitTxId=no  suspense  SHOWS MISSING  suspended@44ms -> missing@430ms -> found@469ms  | refresh: found
progressive join    action     cold awaitTxId=no  plain     SHOWS MISSING  found@46ms -> loading@179ms -> missing@429ms -> found@470ms  | refresh: found
progressive join    action     cold awaitTxId=yes suspense  ok             suspended@46ms -> found@446ms  | refresh: found
progressive join    action     cold awaitTxId=yes plain     ok             found@49ms  | refresh: found
progressive join    action     warm awaitTxId=no  suspense  SHOWS MISSING  suspended@28ms -> found@327ms -> missing@329ms -> found@468ms  | refresh: found
progressive join    action     warm awaitTxId=no  plain     SHOWS MISSING  found@31ms -> missing@170ms -> found@466ms  | refresh: found
progressive join    action     warm awaitTxId=yes suspense  ok             suspended@30ms -> found@330ms  | refresh: found
progressive join    action     warm awaitTxId=yes plain     ok             found@34ms  | refresh: found
```

Dimensions:

- `join`: the detail query inner-joins `users`.
- `collection`: `serviceAccounts.insert()` with an `onInsert` handler; only the
  service account row is optimistic.
- `action`: one `createOptimisticAction` inserts both rows.
- `warm`: the list page synced the collections first.
- `cold`: the detail page starts the sync.
- `awaitTxId`: the mutation awaits the API's txid before it settles.
- `SYNC_MODES=progressive,on-demand,eager` adds the other sync modes.

What this shows:

- **The Suspense and non-Suspense hooks behave the same in every scenario.**
  Neither one stays missing: both reach `found` once Electric delivers the
  row, and a refresh always finds it. The hooks differ in one respect:
  Suspense reveals only after the first sync.
- **The row goes missing when the detail query depends on rows that aren't
  optimistic.** An inner join on `users` drops the optimistic service account
  row until the `users` row replicates. `awaitTxId` on the service account
  collection doesn't help.
- **An optimistic action that doesn't await the txid drops its rows when
  `mutationFn` resolves.** That happens before Electric has the commit. A
  direct `collection.insert()` behaves differently: it keeps its optimistic
  row until sync acknowledges it (`DIRECT_TRANSACTION_METADATA_KEY` /
  `acknowledgedInserts` in `@tanstack/db` `collection/state.ts`).
- **Awaiting the txid on a collection that isn't active yet works.** Navigating
  to the detail page starts that collection's sync, and the await resolves
  (`cold awaitTxId=yes`). It would time out (15 s by default) only if nothing
  started the collection.

### 3. Real backend

Against a real backend (an HTTP API with an Electric shape proxy, Electric
1.7.10 and Postgres 16), the same matrix in `progressive`, `on-demand` and
`eager` mode gives the same picture. Every run ends in `found`, and every
refresh shows `found`. The only `missing` states are short gaps, a few ms
locally, in the same two cases as above.

So "missing right after create, but found after a refresh" isn't produced by
Electric and TanStack DB alone. It needs something in the app that turns the
short gap into a final state. A common way: the Suspense view treats
`undefined` from `findOne()` as not found (`throw notFound()`, a thrown error,
or a redirect). The boundary that catches it stays in that state after the row
arrives, until a remount such as a refresh. A `useLiveQuery` view usually just
re-renders when the row arrives.

One unexplained observation: in 1 of 11 cold runs without `awaitTxId`,
against a shape Electric had only just created, the single-table case showed
`missing` for about 7 ms. It never showed up with `awaitTxId`.

### Recommended fix

1. Create the record with **one** optimistic action that inserts every row the
   destination view reads. In `mutationFn`, await the API's txid on **every**
   collection touched:

   ```js
   const txid = Number((await putServiceAccount(command)).transactionId);
   await Promise.all([
     users.utils.awaitTxId(txid),
     serviceAccounts.utils.awaitTxId(txid),
   ]);
   ```

   This is the `join action awaitTxId=yes` row: clean cold and warm, for both
   hooks.
2. Await the txid even when the destination collection isn't active yet. The
   navigation that follows a create activates it.
3. Treat `undefined` from `findOne()` right after a create as "not synced
   yet", not as a terminal not-found. Don't redirect or throw a router
   `notFound()` on it.
4. Always configure `shapeOptions.onError` and wrap Suspense queries in an
   error boundary, so sync failures can't look like missing data.

### Notes for an Electric proxy

- When a proxy adds a `where` with a subquery and the tables live outside
  `public`, qualify the tables **inside** the subquery too. Electric parses
  subquery `FROM` clauses itself and defaults an unqualified table to `public`
  (`lib/electric/replication/eval/parser.ex` in Electric 1.7.10), ignoring the
  database `search_path`. The shape then fails with `Table "public"."..." does
  not exist`. `useLiveSuspenseQuery` throws that error, while `useLiveQuery`
  keeps rendering optimistic rows from the errored collection.
- Electric sends `Cache-Control: public, max-age=604800, s-maxage=3600` on
  shape responses. If the proxy adds a per-user `where` server-side, the
  browser-visible URL is the same for every user. Add `Vary: Authorization`,
  or make the responses `private`, so a shared cache can't serve one user's
  shape to another.

## Running against a real backend

`API_URL` makes `service-account-repro` proxy `/api` to a running backend
instead of using the fake, and sends `API_TOKEN` as a bearer token. The
backend has to serve:

- an Electric shape proxy at `/api/shape` for the `users` and
  `service_accounts` tables, and
- `PUT /api/service-accounts/:id`, which writes both rows in one transaction
  and returns `{ "transactionId": "<txid>" }`. Adapt `putServiceAccount` in
  `service-account-repro/main.jsx` if your API's body differs.

`real-electric/electric-from-hex/` runs the published Electric 1.7.10 from Hex,
for machines that can't pull the `electricsql/electric` image. Docker Hub gives
anonymous clients no pull access to that repository from some networks. It
needs Erlang/OTP 27+ and Elixir 1.17+:

```sh
cd real-electric/electric-from-hex
MIX_ENV=prod mix deps.get && MIX_ENV=prod mix compile
DATABASE_URL='postgresql://postgres:pass@localhost:5432/postgres?sslmode=disable' \
ELECTRIC_SECRET=local-electric-secret ELECTRIC_PORT=3001 MIX_ENV=prod mix run --no-halt
```

`FILTER='{"join":false,"warm":false}'` selects scenarios and `REPEAT=8` repeats
them, for intermittent races.

The fake leaves out subqueries in `where` (move-in/move-out), HTTP caching,
shape rotation (409), chunking and SSE; use a real Electric for those.

## Layout

- `fake-electric/fake-electric.mjs`: in-memory Postgres + Electric. Commits get
  txids, Electric sees them after a replication lag, live requests long-poll,
  and subset snapshots read Postgres directly. Unsupported SQL fails loudly.
- `fake-electric/contract.test.mjs`: runs the real `@electric-sql/client` and
  `@tanstack/electric-db-collection` against the fake.
- `harness/harness.mjs`: Playwright helpers. A run with errors is reported as
  `INVALID`, and runs are judged on the recorded state timeline rather than a
  DOM count after a fixed sleep.
- `create-navigation-repro/`: the original reports flow, plus
  `original-mock.mjs` as a negative control.
- `service-account-repro/`: the service-account flow. Fake timings can be set
  with `API_LATENCY_MS`, `REPLICATION_LAG_MS`, `INITIAL_SYNC_DELAY_MS`,
  `SUBSET_DELAY_MS` and `OBSERVE_MS`. `API_URL` targets a real backend,
  `SYNC_MODES` adds sync modes, `FILTER` and `REPEAT` select and repeat
  scenarios, and `VERBOSE=1` prints full timelines.
- `real-electric/electric-from-hex/`: Electric 1.7.10 from Hex.

Versions: `@tanstack/db` 0.11.1, `@tanstack/electric-db-collection` 0.5.2,
`@tanstack/react-db` 0.5.1, `@electric-sql/client` 1.5.25, `react` 19.2.8,
`vite` 8.3.2.
