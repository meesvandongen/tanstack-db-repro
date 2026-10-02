import { fakeElectricPlugin } from '../fake-electric/fake-electric.mjs';

// The fake API's create command: write the user and the service account in
// one transaction and return that transaction's txid.
function fakeApi(server, electric) {
  server.middlewares.use('/api/service-accounts/', async (request, response) => {
    if (request.method !== 'PUT') {
      response.statusCode = 405;
      response.end();
      return;
    }
    const id = decodeURIComponent(request.url.replace(/^\//, '').split('?')[0]);
    let body = '';
    for await (const chunk of request) body += chunk;
    const command = JSON.parse(body);
    await new Promise((resolve) => setTimeout(resolve, electric.config.apiLatencyMs ?? 0));
    const txid = electric.commitTransaction([
      {
        table: 'users',
        operation: 'insert',
        value: { id, username: command.username },
      },
      {
        table: 'service_accounts',
        operation: 'insert',
        value: { id, name: command.name, type: command.type },
      },
    ]);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ transactionId: String(txid) }));
  });
}

// API_URL switches from the fake to a real backend that serves the same
// routes (`PUT /api/service-accounts/:id` returning `{ transactionId }`, and an
// Electric shape proxy at `/api/shape`). API_TOKEN is sent as a bearer token.
const apiUrl = process.env.API_URL;

export default {
  plugins: apiUrl ? [] : [fakeElectricPlugin({ shapePath: '/api/shape', api: fakeApi })],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.REPRO_PORT ?? 4314),
    strictPort: true,
    proxy: apiUrl
      ? {
          '/api': {
            target: apiUrl,
            changeOrigin: true,
            headers: { authorization: `Bearer ${process.env.API_TOKEN ?? 'repro'}` },
          },
        }
      : undefined,
  },
};
