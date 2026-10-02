import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BasicIndex, createCollection, eq } from '@tanstack/db';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';
import { useLiveQuery, useLiveSuspenseQuery } from '@tanstack/react-db';

const reports = createCollection({
  ...electricCollectionOptions({
    id: 'reports',
    getKey: (report) => report.id,
    shapeOptions: {
      url: `${window.location.origin}/shape`,
      params: { table: 'reports' },
      subsetMethod: 'POST',
    },
    syncMode: 'progressive',
    defaultIndexType: BasicIndex,
    onInsert: async () => {},
  }),
});

function App() {
  const [screen, setScreen] = useState('create');

  if (screen === 'create') {
    return (
      <main>
        <h1>Create report</h1>
        <button
          onClick={() => {
            reports.insert({
              id: 'report-created',
              title: 'Created report',
            });
            setScreen('permissions');
          }}
        >
          Save
        </button>
      </main>
    );
  }

  if (screen === 'list') {
    return (
      <main>
        <h1>Reports</h1>
        <button onClick={() => setScreen('create')}>Create report</button>
        <button onClick={() => setScreen('permissions')}>
          Created report
        </button>
      </main>
    );
  }

  return (
    <main>
      <h1>Created report</h1>
      <button onClick={() => setScreen('list')}>Reports</button>
      <button onClick={() => setScreen('create')}>Create report</button>
      <ReportPermissions reportId="report-created" />
    </main>
  );
}

function ReportPermissions({ reportId }) {
  if (window.__reproUseNonSuspense) {
    const { data: report } = useLiveQuery(
      (q) =>
        q
          .from({ report: reports })
          .where(({ report }) => eq(report.id, reportId))
          .findOne(),
      [reportId],
    );
    return <ReportResult report={report} />;
  }

  const { data: report } = useLiveSuspenseQuery(
    (q) =>
      q
        .from({ report: reports })
        .where(({ report }) => eq(report.id, reportId))
        .findOne(),
    [reportId],
  );
  return <ReportResult report={report} />;
}

function ReportResult({ report }) {
  return (
    <section data-testid="report-result">
      <h2>Permissions</h2>
      {report ? <p>{report.title}</p> : <p>Report not found</p>}
    </section>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
