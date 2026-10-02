// Contract test: drive the real Electric client and the real TanStack DB
// Electric collection against the fake server. If the fake stops speaking the
// protocol these consumers expect, this fails before any repro does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ShapeStream } from '@electric-sql/client';
import { createCollection } from '@tanstack/db';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';
import { createFakeElectric } from './fake-electric.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let abort;

async function withServer(config, fn) {
  abort = new AbortController();
  const electric = createFakeElectric(config);
  const server = createServer((request, response) => {
    electric.handleShape(request, response).catch((error) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, `127.0.0.1`, resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/shape`;
  try {
    await fn({ electric, url });
  } finally {
    abort.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function collectStream(stream) {
  const messages = [];
  const errors = [];
  const unsubscribe = stream.subscribe(
    (batch) => messages.push(...batch),
    (error) => errors.push(error),
  );
  return { messages, errors, unsubscribe };
}

async function waitFor(predicate, timeout = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error(`timed out`);
    await delay(10);
  }
}

test(`initial sync reaches up-to-date and live requests long-poll`, async () => {
  await withServer({}, async ({ electric, url }) => {
    electric.commit(`items`, `insert`, { id: `a`, title: `A` });
    await delay(5);
    const stream = new ShapeStream({ url, params: { table: `items` }, signal: abort.signal });
    const { messages, errors, unsubscribe } = collectStream(stream);
    try {
      await waitFor(() => stream.isUpToDate);
      assert.deepEqual(
        messages.filter((m) => m.value).map((m) => m.value),
        [{ id: `a`, title: `A` }],
      );
      await delay(1000);
      // A real Electric server holds live requests open; a mock that answers
      // immediately trips the client's fast-retry-loop guard.
      assert.ok(
        electric.requests.length <= 3,
        `expected a held live request, saw ${electric.requests.length} requests`,
      );
      assert.deepEqual(errors, []);
    } finally {
      unsubscribe();
    }
  });
});

test(`commits arrive on the live stream with their txid after replication lag`, async () => {
  await withServer({ replicationLagMs: 200 }, async ({ electric, url }) => {
    const stream = new ShapeStream({ url, params: { table: `items` }, signal: abort.signal });
    const { messages, errors, unsubscribe } = collectStream(stream);
    try {
      await waitFor(() => stream.isUpToDate);
      const txid = electric.commit(`items`, `insert`, { id: `b`, title: `B` });
      await delay(100);
      assert.equal(messages.filter((m) => m.value).length, 0, `visible before replication`);
      await waitFor(() => messages.some((m) => m.value?.id === `b`));
      const change = messages.find((m) => m.value?.id === `b`);
      assert.deepEqual(change.headers.txids, [txid]);
      assert.deepEqual(errors, []);
    } finally {
      unsubscribe();
    }
  });
});

test(`subset snapshots read Postgres directly, before replication`, async () => {
  await withServer({ replicationLagMs: 500 }, async ({ electric, url }) => {
    electric.commit(`items`, `insert`, { id: `c`, title: `C` });
    const stream = new ShapeStream({
      url,
      params: { table: `items` },
      log: `changes_only`,
      signal: abort.signal,
      subsetMethod: `POST`,
    });
    const { data, metadata } = await stream.fetchSnapshot({
      where: `"id" = $1`,
      params: { 1: `c` },
    });
    assert.deepEqual(
      data.map((m) => m.value),
      [{ id: `c`, title: `C` }],
    );
    assert.ok(Number(metadata.xmax) > 1000);
  });
});

test(`a progressive TanStack DB Electric collection becomes ready and syncs`, async () => {
  await withServer({ replicationLagMs: 50 }, async ({ electric, url }) => {
    electric.commit(`items`, `insert`, { id: `d`, title: `D` });
    await delay(60);
    const errors = [];
    const collection = createCollection(
      electricCollectionOptions({
        id: `contract-items`,
        getKey: (row) => row.id,
        shapeOptions: {
          url,
          params: { table: `items` },
          subsetMethod: `POST`,
          onError: (error) => {
            errors.push(error);
          },
        },
        syncMode: `progressive`,
      }),
    );
    try {
      await collection.preload();
      assert.equal(collection.status, `ready`);
      assert.equal(collection.get(`d`)?.title, `D`);
      electric.commit(`items`, `insert`, { id: `e`, title: `E` });
      await waitFor(() => collection.has(`e`));
      assert.deepEqual(errors, []);
    } finally {
      await collection.cleanup();
    }
  });
});

test(`subset snapshots support the where clauses TanStack DB generates`, async () => {
  await withServer({}, async ({ electric, url }) => {
    electric.commit(`items`, `insert`, { id: `f`, title: `F` });
    electric.commit(`items`, `insert`, { id: `g`, title: `G` });
    const stream = new ShapeStream({
      url,
      params: { table: `items` },
      log: `changes_only`,
      subsetMethod: `POST`,
      signal: abort.signal,
    });
    const ids = async (where, params) =>
      (await stream.fetchSnapshot({ where, params })).data.map((m) => m.value.id).sort();
    assert.deepEqual(await ids(`true = true`, {}), [`f`, `g`]);
    assert.deepEqual(await ids(`"id" = ANY($1)`, { 1: `{"f","g"}` }), [`f`, `g`]);
    assert.deepEqual(await ids(`("id" = $1) AND ("id" = ANY($2))`, { 1: `f`, 2: `{"f"}` }), [`f`]);
    // Unsupported SQL must fail loudly rather than return a wrong answer.
    const unsupported = await fetch(`${url}?table=items&offset=-1`, {
      method: `POST`,
      headers: { 'content-type': `application/json` },
      body: JSON.stringify({ where: `"id" > $1`, params: { 1: `a` } }),
    });
    assert.equal(unsupported.status, 500);
  });
});
