import { Component, StrictMode, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BasicIndex, createCollection, eq } from '@tanstack/db';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';
import { useLiveQuery, useLiveSuspenseQuery } from '@tanstack/react-db';

const hook = new URLSearchParams(window.location.search).get('hook') ?? 'suspense';

// Visible states are recorded with timestamps relative to the Save click, so
// the runner asserts on what the user saw instead of counting DOM nodes once.
const timeline = (window.__timeline = []);
let t0 = performance.now();
function record(event, details = {}) {
  timeline.push({ t: Math.round(performance.now() - t0), event, ...details });
}

const reports = createCollection({
  ...electricCollectionOptions({
    id: 'reports',
    getKey: (report) => report.id,
    shapeOptions: {
      url: `${window.location.origin}/shape`,
      params: { table: 'reports' },
      subsetMethod: 'POST',
      // Without this, a failing stream only surfaces as a collection error
      // that useLiveQuery silently renders around.
      onError: (error) => {
        record('sync-error', { message: String(error?.message ?? error) });
        console.error('Electric sync error', error);
      },
    },
    syncMode: 'progressive',
    defaultIndexType: BasicIndex,
    onInsert: async () => {},
  }),
});

reports.on('status:change', ({ status }) => record('source-status', { status }));

function App() {
  const [screen, setScreen] = useState('create');

  if (screen === 'create') {
    return (
      <main>
        <h1>Create report</h1>
        <button
          onClick={() => {
            t0 = performance.now();
            record('insert');
            reports.insert({ id: 'report-created', title: 'Created report' });
            setScreen('permissions');
          }}
        >
          Save
        </button>
      </main>
    );
  }

  return (
    <main>
      <h1>Created report</h1>
      {/* Both boundaries make every outcome distinguishable: suspended,
          errored, or rendered. Without them a thrown error unmounts the whole
          root, which looks exactly like a never-resolving suspension. */}
      <ErrorBoundary>
        <Suspense fallback={<Fallback />}>
          {hook === 'suspense' ? (
            <SuspenseReportPermissions reportId="report-created" />
          ) : (
            <PlainReportPermissions reportId="report-created" />
          )}
        </Suspense>
      </ErrorBoundary>
    </main>
  );
}

const reportQuery = (reportId) => (q) =>
  q
    .from({ report: reports })
    .where(({ report }) => eq(report.id, reportId))
    .findOne();

function SuspenseReportPermissions({ reportId }) {
  const { data } = useLiveSuspenseQuery(reportQuery(reportId), [reportId]);
  return <ReportResult report={data} status="ready" />;
}

function PlainReportPermissions({ reportId }) {
  // The control reports its status too: rendering a node while the query is
  // `loading` or `error` is not the same as the query working.
  const { data, status } = useLiveQuery(reportQuery(reportId), [reportId]);
  return <ReportResult report={data} status={status} />;
}

function ReportResult({ report, status }) {
  const state = report ? 'found' : status === 'ready' ? 'missing' : status;
  useEffect(() => {
    record('view', { state, status, synced: report?.$synced });
  }, [state, status, report?.$synced]);
  return (
    <section data-testid="report-result" data-state={state} data-status={status}>
      <h2>Permissions</h2>
      {report ? <p>{report.title}</p> : <p>Report not found</p>}
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
