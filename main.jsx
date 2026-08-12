import { StrictMode, Suspense, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BasicIndex,
  createCollection,
  eq,
  materialize,
} from '@tanstack/db';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';
import { useLiveQuery, useLiveSuspenseQuery } from '@tanstack/react-db';

const documents = sourceCollection('documents');
const folderMemberships = sourceCollection('folder-memberships');
const folders = sourceCollection('folders');
const documentTags = sourceCollection('document-tags');

folderMemberships.createIndex((row) => row.folderId);
folders.createIndex((row) => row.id);
documentTags.createIndex((row) => row.folderId);

function sourceCollection(id) {
  return createCollection({
    ...electricCollectionOptions({
      id,
      getKey: (row) => row.id,
      shapeOptions: {
        url: `${window.location.origin}/shape`,
        params: { table: id },
        subsetMethod: 'POST',
      },
      syncMode: 'progressive',
      defaultIndexType: BasicIndex,
    }),
  });
}

function App() {
  const [screen, setScreen] = useState({ name: 'home' });

  if (screen.name === 'home') {
    return (
      <main>
        <h1>Home</h1>
        <button onClick={() => setScreen({ name: 'documents' })}>
          Documents
        </button>
      </main>
    );
  }

  if (screen.name === 'documents') {
    return (
      <main>
        <h1>Documents</h1>
        <button onClick={() => setScreen({ name: 'document', id: 'document-a' })}>
          Document A
        </button>
        <button onClick={() => setScreen({ name: 'document', id: 'document-b' })}>
          Document B
        </button>
      </main>
    );
  }

  const documentName = screen.id === 'document-a' ? 'Document A' : 'Document B';

  return (
    <main>
      <h1>{documentName}</h1>
      <button onClick={() => setScreen({ name: 'documents' })}>
        Documents
      </button>
      <button onClick={() => setScreen({ name: 'details', id: screen.id })}>
        Details
      </button>
      <button onClick={() => setScreen({ name: 'tags', id: screen.id })}>
        Tags
      </button>
      {screen.name === 'details' && <p>Details for {documentName}</p>}
      {screen.name === 'tags' && (
        <Suspense fallback={<p>Loading tags...</p>}>
          <DocumentTags documentId={screen.id} />
        </Suspense>
      )}
    </main>
  );
}

function DocumentTags({ documentId }) {
  if (window.__reproUseNonSuspense) {
    return <DocumentTagsWithoutSuspense documentId={documentId} />;
  }

  return <DocumentTagsWithSuspense documentId={documentId} />;
}

function DocumentTagsWithSuspense({ documentId }) {
  const { data: document } = useLiveSuspenseQuery(
    (q) => documentTagsQuery(q, documentId),
    [documentId],
  );

  return <DocumentTagsContent document={document} />;
}

function DocumentTagsWithoutSuspense({ documentId }) {
  const { data: document } = useLiveQuery(
    (q) => documentTagsQuery(q, documentId),
    [documentId],
  );

  return <DocumentTagsContent document={document} />;
}

function DocumentTagsContent({ document }) {
  return (
    <section data-testid="document-tags">
      <h2>Tags</h2>
      {document?.folders.flatMap((folder) =>
        folder.tags.map((tag) => <p key={tag.id}>{tag.name}</p>),
      )}
    </section>
  );
}

function documentTagsQuery(q, documentId) {
  return q
    .from({ document: documents })
    .where(({ document }) => eq(document.id, documentId))
    .select(({ document }) => ({
      ...document,
      folders: materialize(
        q
          .from({ membership: folderMemberships })
          .innerJoin(
            { folder: folders },
            ({ membership, folder }) => eq(membership.folderId, folder.id),
          )
          .where(({ membership }) => eq(membership.documentId, document.id))
          .select(({ folder }) => ({
            ...folder,
            tags: materialize(
              q
                .from({ tag: documentTags })
                .where(({ tag }) => eq(tag.folderId, folder.id))
                .select(({ tag }) => ({ ...tag })),
            ),
          })),
      ),
    }))
    .findOne();
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
