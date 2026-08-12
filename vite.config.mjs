import { fileURLToPath } from 'node:url';

export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    {
      name: 'minimal-electric-shape',
      configureServer(server) {
        server.middlewares.use('/shape', (request, response) => {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1');
          const table = url.searchParams.get('table');
          const rows = {
            documents: [
              { id: 'document-a', title: 'Document A' },
              { id: 'document-b', title: 'Document B' },
            ],
            'folder-memberships': [
              {
                id: 'folder-membership-a',
                documentId: 'document-a',
                folderId: 'folder-a',
              },
              {
                id: 'folder-membership-b',
                documentId: 'document-b',
                folderId: 'folder-b',
              },
            ],
            folders: [
              { id: 'folder-a', name: 'Folder A' },
              { id: 'folder-b', name: 'Folder B' },
            ],
            'document-tags': [
              { id: 'tag-a', folderId: 'folder-a', name: 'Tag A' },
              { id: 'tag-b', folderId: 'folder-b', name: 'Tag B' },
            ],
          }[table];

          if (!rows) {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: `Unknown table ${table}` }));
            return;
          }

          response.setHeader('content-type', 'application/json');
          response.setHeader('electric-cursor', 'repro-cursor');
          response.setHeader('electric-handle', `repro-${table}`);
          response.setHeader('electric-offset', '0_0');
          response.setHeader('electric-schema', '{}');
          response.setHeader('electric-up-to-date', 'true');

          const messages = rows.map((value) => ({
            key: value.id,
            value,
            headers: { operation: 'insert' },
          }));
          const responseData =
            request.method === 'POST'
              ? messages
              : [...messages, { headers: { control: 'up-to-date' } }];
          response.end(
            JSON.stringify(
              request.method === 'POST'
                ? { metadata: {}, data: responseData }
                : responseData,
            ),
          );
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.REPRO_PORT ?? 4310),
    strictPort: true,
  },
};
