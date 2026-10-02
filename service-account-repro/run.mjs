import { fileURLToPath } from 'node:url';
import {
  launchBrowser,
  openPage,
  resetFake,
  startVite,
  stateSequence,
} from '../harness/harness.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.REPRO_PORT ?? 4314);
const observeMs = Number(process.env.OBSERVE_MS ?? 2500);

// Server timings. The default profile matches a typical cold start: the API
// PUT commits before Electric has replicated it, and before the first full
// sync of the (not yet started) service_account shape completes.
const timings = {
  apiLatencyMs: Number(process.env.API_LATENCY_MS ?? 150),
  replicationLagMs: Number(process.env.REPLICATION_LAG_MS ?? 300),
  initialSyncDelayMs: Number(process.env.INITIAL_SYNC_DELAY_MS ?? 400),
  subsetDelayMs: Number(process.env.SUBSET_DELAY_MS ?? 20),
};

// `join`: the detail query inner-joins users. `mutation`: which rows are
// optimistic (`collection`: the service account only, `action`: both).
const variants = [
  { join: false, mutation: 'collection' },
  { join: true, mutation: 'collection' },
  { join: true, mutation: 'action' },
];
// SYNC_MODES picks the Electric collection sync modes, e.g. "progressive,on-demand".
const syncModes = (process.env.SYNC_MODES ?? 'progressive').split(',');
const scenarios = [];
for (const sync of syncModes) {
  for (const variant of variants) {
    for (const warm of [false, true]) {
      for (const awaitTxId of [false, true]) {
        for (const hook of ['suspense', 'plain']) {
          scenarios.push({ sync, ...variant, hook, awaitTxId, warm });
        }
      }
    }
  }
}

// FILTER selects scenarios by partial match, e.g. FILTER='{"join":false,"warm":false}'.
// REPEAT runs each selected scenario several times, for intermittent races.
const filter = JSON.parse(process.env.FILTER ?? '{}');
const repeat = Number(process.env.REPEAT ?? 1);
const selected = scenarios
  .filter((scenario) => Object.entries(filter).every(([key, value]) => scenario[key] === value))
  .flatMap((scenario) => Array.from({ length: repeat }, () => scenario));

const server = await startVite(directory, port);
const browser = await launchBrowser();
const results = [];
try {
  for (const scenario of selected) {
    // Against a real backend + Electric there is nothing to reset: every run
    // creates a new service account with a fresh id.
    if (!process.env.API_URL) await resetFake(server.url, timings);
    const query = new URLSearchParams({
      hook: scenario.hook,
      awaitTxId: scenario.awaitTxId ? '1' : '0',
      warm: scenario.warm ? '1' : '0',
      join: scenario.join ? '1' : '0',
      mutation: scenario.mutation,
      sync: scenario.sync,
    });
    const { page, problems, close } = await openPage(browser, `${server.url}/?${query}`);
    try {
      if (scenario.warm) {
        try {
          await page.getByTestId('list-status').filter({ hasText: 'ready' }).waitFor({ timeout: 10000 });
        } catch {
          // A failing shape keeps the list loading; report it instead of aborting.
          const timeline = await page.evaluate(() => window.__timeline);
          results.push({
            scenario,
            states: [],
            timeline,
            invalid: [
              'list page never became ready',
              ...problems,
              ...timeline
                .filter((entry) => entry.event === 'sync-error')
                .map((entry) => `sync-error: ${entry.message}`),
            ],
          });
          continue;
        }
        await page.getByRole('button', { name: 'New service account' }).click();
      }
      await page.getByRole('button', { name: 'Save' }).click();
      await page.waitForTimeout(observeMs);
      const timeline = await page.evaluate(() => window.__timeline);
      const syncErrors = timeline.filter((entry) => entry.event === 'sync-error');
      const states = stateSequence(timeline);
      // Then open the same detail page fresh, like a refresh.
      const createdId = await page.evaluate(() => window.__createdId);
      query.set('detail', createdId);
      const fresh = await openPage(browser, `${server.url}/?${query}`);
      let refresh;
      try {
        await fresh.page.waitForTimeout(observeMs);
        refresh = stateSequence(await fresh.page.evaluate(() => window.__timeline)).at(-1)?.label;
        problems.push(...fresh.problems);
      } finally {
        await fresh.close();
      }
      results.push({
        scenario,
        states,
        refresh,
        timeline,
        invalid: [...problems, ...syncErrors.map((entry) => `sync-error: ${entry.message}`)],
      });
    } finally {
      await close();
    }
  }
} finally {
  await browser.close();
  server.stop();
}

console.log(
  process.env.API_URL
    ? `backend: real API at ${process.env.API_URL}\n`
    : `backend: fake, timings: ${JSON.stringify(timings)}\n`,
);
for (const { scenario, states, refresh, invalid } of results) {
  const label = [
    scenario.sync.padEnd(11),
    scenario.join ? 'join   ' : 'no-join',
    scenario.mutation.padEnd(10),
    scenario.warm ? 'warm' : 'cold',
    `awaitTxId=${scenario.awaitTxId ? 'yes' : 'no '}`,
    scenario.hook.padEnd(8),
  ].join(' ');
  const sequence = states.map(({ label, t }) => `${label}@${t}ms`).join(' -> ');
  const verdict = invalid.length
    ? 'INVALID'
    : states.some((state) => state.label === 'missing' || state.label === 'error')
      ? 'SHOWS MISSING'
      : 'ok';
  console.log(`${label}  ${verdict.padEnd(13)}  ${sequence}  | refresh: ${refresh ?? '-'}`);
  for (const problem of [...new Set(invalid)].slice(0, 4)) {
    console.log(`    ${problem.slice(0, 240)}`);
  }
}

if (process.env.VERBOSE) {
  for (const { scenario, timeline } of results) {
    console.log(`\n${JSON.stringify(scenario)}`);
    for (const entry of timeline) console.log(`  ${JSON.stringify(entry)}`);
  }
}

if (results.some(({ invalid }) => invalid.length)) process.exit(2);
if (results.some(({ states }) => states.some((s) => s.label === 'missing' || s.label === 'error'))) {
  process.exit(1);
}
