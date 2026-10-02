export default {
  plugins: [
    {
      name: 'minimal-electric-shape',
      configureServer(server) {
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
    },
  ],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.REPRO_PORT ?? 4313),
    strictPort: true,
  },
};
