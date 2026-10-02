// The shape endpoint from the first version of this repro, kept as a negative
// control for the harness. It is NOT Electric-compatible:
// - every request gets the same `snapshot-end` body. Real Electric ends the
//   first `offset=-1` response that way too, but answers the follow-up request
//   with `up-to-date`; this mock never does, so the client never goes live, and
// - every request is answered immediately (no long-poll), so the client
//   re-polls the same offset until its fast-retry-loop guard fails the stream.
// `MOCK=original pnpm repro` must report every run as INVALID.
export function originalMockPlugin() {
  return {
    name: 'original-minimal-electric-shape',
    configureServer(server) {
      server.middlewares.use('/__fake/reset', (_request, response) => response.end('ok'));
      server.middlewares.use('/shape', (request, response) => {
        response.setHeader('content-type', 'application/json');
        response.setHeader('electric-cursor', 'repro-cursor');
        response.setHeader('electric-handle', 'repro-reports');
        response.setHeader('electric-offset', '0_0');
        response.setHeader('electric-schema', '{}');

        const rows = [];
        const data =
          request.method === 'POST'
            ? { metadata: {}, data: rows }
            : [...rows, { headers: { control: 'snapshot-end' } }];

        response.setHeader('electric-up-to-date', 'true');
        response.end(JSON.stringify(data));
      });
    },
  };
}
