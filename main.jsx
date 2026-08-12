import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BasicIndex,
  eq,
  materialize,
  createCollection,
} from '@tanstack/db';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';
import { useLiveQuery, useLiveSuspenseQuery } from '@tanstack/react-db';
import {
  Link,
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useParams,
} from 'react-router';
import './styles.css';

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

function Home() {
  return (
    <main className="page">
      <h1>Home</h1>
      <Link className="top-link" to="/documents">
        Documents
      </Link>
    </main>
  );
}

function Documents() {
  return (
    <main className="page">
      <h1>Documents</h1>
      <nav className="document-list" aria-label="Documents">
        <Link to="/documents/document-a">Document A</Link>
        <Link to="/documents/document-b">Document B</Link>
      </nav>
    </main>
  );
}

function DocumentLayout() {
  const { id } = useParams();
  const name = id === 'document-a' ? 'Document A' : 'Document B';
  return (
    <main className="page">
      <h1>{name}</h1>
      <Link className="top-link" to="/documents">
        Documents
      </Link>
      <nav className="sub-navigation" aria-label="Document sections">
        <Link to={`/documents/${id}/details`}>Details</Link>
        <Link to={`/documents/${id}/tags`}>Tags</Link>
      </nav>
      <Outlet />
    </main>
  );
}

function DocumentDetails() {
  const { id } = useParams();
  return <p>Details for {id}</p>;
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
    <section className="hierarchy" data-testid="document-tags">
      <div className="hierarchy-heading">
        <div>
          <p className="eyebrow">Document hierarchy</p>
          <h2>Tags</h2>
        </div>
        {document && <span className="document-badge">{document.title}</span>}
      </div>
      {document ? (
        <ul className="folder-list">
          {document.folders.map((folder) => (
            <li className="folder-node" key={folder.id}>
              <h3>{folder.name}</h3>
              <ul className="tag-list">
                {folder.tags.map((tag) => (
                  <li className="tag-node" key={tag.id}>
                    {tag.name}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <p>Loading tags...</p>
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
            ({ membership, folder }) =>
              eq(membership.folderId, folder.id),
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

function DocumentTagsRoute() {
  const { id } = useParams();
  return <DocumentTags documentId={id} />;
}

const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  { path: '/documents', element: <Documents /> },
  {
    path: '/documents/:id',
    element: <DocumentLayout />,
    children: [
      { index: true, element: <Navigate to="details" replace /> },
      { path: 'details', element: <DocumentDetails /> },
      { path: 'tags', element: <DocumentTagsRoute /> },
    ],
  },
]);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
