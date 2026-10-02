import {
  Component,
  StrictMode,
  Suspense,
  startTransition,
  useEffect,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { BasicIndex, createCollection, createOptimisticAction, eq } from '@tanstack/db';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';
import { useLiveQuery, useLiveSuspenseQuery } from '@tanstack/react-db';

// Scenario flags come from the URL so the runner can drive every combination.
const params = new URLSearchParams(window.location.search);
const scenario = {
  // `suspense` uses useLiveSuspenseQuery, `plain` uses useLiveQuery.
  hook: params.get('hook') ?? 'suspense',
  // Await the API's transaction ID in the mutation before it settles.
  awaitTxId: params.get('awaitTxId') === '1',
  // Visit the list first, so the collection is already synced (warm) instead
  // of being started by the detail page (cold).
  warm: params.get('warm') === '1',
  // The detail query inner-joins the user row, which the API creates in the
  // same transaction as the service account.
  join: params.get('join') === '1',
  // `collection`: serviceAccounts.insert() with an onInsert handler (only the
  // service account row is optimistic). `action`: one optimistic action that
  // inserts both the user and the service account row.
  mutation: params.get('mutation') ?? 'collection',
  // Electric collection sync mode: `progressive`, `on-demand` or `eager`.
  syncMode: params.get('sync') ?? 'progressive',
  // Open the detail page for an existing id directly, like a page refresh.
  detailId: params.get('detail'),
};

// Everything the user would see is recorded with a timestamp relative to the
// Save click, so the runner can assert on the sequence instead of sampling the
// DOM once after a fixed sleep.
const timeline = (window.__timeline = []);
let t0 = performance.now();
function record(event, details = {}) {
  timeline.push({ t: Math.round(performance.now() - t0), event, ...details });
}

async function putServiceAccount(account) {
  const response = await fetch(`/api/service-accounts/${account.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: account.name,
      type: account.type,
      username: account.username,
    }),
  });
  if (!response.ok) throw new Error(`PUT failed with ${response.status}`);
  const { transactionId } = await response.json();
  record('api-committed', { transactionId });
  return Number(transactionId);
}

function electricOptions(table, extra = {}) {
  return electricCollectionOptions({
    id: table,
    getKey: (row) => row.id,
    shapeOptions: {
      url: `${window.location.origin}/api/shape`,
      params: { table },
      subsetMethod: 'POST',
      onError: (error) => {
        record('sync-error', { table, message: String(error?.message ?? error) });
        console.error('Electric sync error', error);
      },
    },
    syncMode: scenario.syncMode,
    defaultIndexType: BasicIndex,
    ...extra,
  });
}

const users = createCollection(electricOptions('users'));

const serviceAccounts = createCollection(
  electricOptions('service_accounts', {
    // PUT the service account; the API returns the Postgres txid of the
    // transaction that committed it.
    onInsert: async ({ transaction, collection }) => {
      const txid = await putServiceAccount(transaction.mutations[0].modified);
      if (scenario.awaitTxId) {
        await collection.utils.awaitTxId(txid);
        record('txid-synced', { txid });
      }
    },
  }),
);

const createServiceAccountAction = createOptimisticAction({
  onMutate: (account) => {
    users.insert({ id: account.id, username: account.username });
    serviceAccounts.insert({ id: account.id, name: account.name, type: account.type });
  },
  mutationFn: async (account) => {
    const txid = await putServiceAccount(account);
    if (scenario.awaitTxId) {
      await Promise.all([
        users.utils.awaitTxId(txid),
        serviceAccounts.utils.awaitTxId(txid),
      ]);
      record('txid-synced', { txid });
    }
  },
});

serviceAccounts.on('status:change', ({ status }) => record('source-status', { status }));
window.__serviceAccounts = serviceAccounts;

function App() {
  const [route, setRoute] = useState(() =>
    scenario.detailId
      ? { page: 'detail', id: scenario.detailId }
      : { page: scenario.warm ? 'list' : 'create' },
  );
  const navigate = (next) => startTransition(() => setRoute(next));

  if (route.page === 'list') return <ListPage onCreate={() => navigate({ page: 'create' })} />;
  if (route.page === 'create') {
    return (
      <CreatePage
        onCreated={(id) => navigate({ page: 'detail', id })}
      />
    );
  }
  return <DetailPage id={route.id} />;
}

function ListPage({ onCreate }) {
  const { data, status } = useLiveQuery((q) => q.from({ account: serviceAccounts }));
  const userList = useLiveQuery((q) => q.from({ user: users }));
  return (
    <main>
      <h1>Service accounts</h1>
      <p data-testid="list-status">{status === 'ready' && userList.status === 'ready' ? 'ready' : 'loading'}</p>
      <p>{data?.length ?? 0} service accounts</p>
      <button onClick={onCreate}>New service account</button>
    </main>
  );
}

function CreatePage({ onCreated }) {
  return (
    <main>
      <h1>New service account</h1>
      <button
        onClick={() => {
          const id = `sa-${crypto.randomUUID()}`;
          t0 = performance.now();
          window.__createdId = id;
          record('insert', { id });
          const account = {
            id,
            name: 'Created service account',
            type: 'oauth',
            username: `svc-${id.slice(3, 11)}`,
          };
          if (scenario.mutation === 'action') createServiceAccountAction(account);
          else serviceAccounts.insert(account);
          onCreated(id);
        }}
      >
        Save
      </button>
    </main>
  );
}

function DetailPage({ id }) {
  return (
    <main>
      <h1>Service account</h1>
      <ErrorBoundary>
        <Suspense fallback={<Fallback />}>
          {scenario.hook === 'suspense' ? (
            <SuspensePermissions id={id} />
          ) : (
            <PlainPermissions id={id} />
          )}
        </Suspense>
      </ErrorBoundary>
    </main>
  );
}

const permissionsQuery = (id) => (q) => {
  let query = q.from({ account: serviceAccounts });
  if (scenario.join) {
    query = query
      .innerJoin({ user: users }, ({ account, user }) => eq(account.id, user.id))
      .select(({ account, user }) => ({ ...account, username: user.username }));
  }
  return query.where(({ account }) => eq(account.id, id)).findOne();
};

function SuspensePermissions({ id }) {
  const { data } = useLiveSuspenseQuery(permissionsQuery(id), [id]);
  return <Permissions account={data} status="ready" />;
}

function PlainPermissions({ id }) {
  const { data, status } = useLiveQuery(permissionsQuery(id), [id]);
  return <Permissions account={data} status={status} />;
}

function Permissions({ account, status }) {
  const state = account ? 'found' : status === 'ready' ? 'missing' : 'loading';
  useEffect(() => {
    record('view', { state, status, synced: account?.$synced });
  }, [state, status, account?.$synced]);
  return (
    <section data-testid="permissions" data-state={state}>
      <h2>Permissions</h2>
      {account ? <p>{account.name}</p> : <p>Service account not found</p>}
    </section>
  );
}

function Fallback() {
  useEffect(() => record('view', { state: 'suspended' }), []);
  return <p data-testid="fallback">Loading…</p>;
}

class ErrorBoundary extends Component {
  state = { error: undefined };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    record('view', { state: 'error', message: String(error?.message ?? error) });
  }
  render() {
    if (this.state.error) {
      return <p data-testid="error">Error: {String(this.state.error.message)}</p>;
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
