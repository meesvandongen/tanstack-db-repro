import { fileURLToPath } from 'node:url';
import {
  launchBrowser,
  openPage,
  resetFake,
  startVite,
  stateSequence,
} from '../harness/harness.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.REPRO_PORT ?? 4313);
const observeMs = Number(process.env.OBSERVE_MS ?? 2500);

// `slow initial sync` shows the by-design behaviour: useLiveSuspenseQuery waits
// for the source collection's first sync even when the row exists optimistically.
const profiles = [
  { name: 'fast initial sync', config: { initialSyncDelayMs: 0 } },
  { name: 'slow initial sync', config: { initialSyncDelayMs: 1500 } },
];

const server = await startVite(directory, port);
const browser = await launchBrowser();
const results = [];
try {
  for (const profile of profiles) {
    for (const hook of ['suspense', 'plain']) {
      await resetFake(server.url, profile.config);
      const { page, problems, close } = await openPage(browser, `${server.url}/?hook=${hook}`);
      try {
        await page.getByRole('button', { name: 'Save' }).click();
        await page.waitForTimeout(observeMs);
        const timeline = await page.evaluate(() => window.__timeline);
        results.push({
          profile: profile.name,
          hook,
          states: stateSequence(timeline),
          invalid: [
            ...problems,
            ...timeline
              .filter((entry) => entry.event === 'sync-error')
              .map((entry) => `sync-error: ${entry.message}`),
          ],
        });
      } finally {
        await close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}

const final = (states) => states.at(-1)?.label;
for (const { profile, hook, states, invalid } of results) {
  const verdict = invalid.length ? 'INVALID' : final(states) === 'found' ? 'ok' : 'FAILED';
  const sequence = states.map(({ label, t }) => `${label}@${t}ms`).join(' -> ');
  console.log(`${profile.padEnd(18)} ${hook.padEnd(8)} ${verdict.padEnd(7)} ${sequence}`);
  for (const problem of [...new Set(invalid)].slice(0, 3)) {
    console.log(`    ${problem.slice(0, 200)}`);
  }
}

// 2: the harness itself is broken (errors, failing sync); 1: a valid run did
// not end up showing the created report.
if (results.some(({ invalid }) => invalid.length)) process.exit(2);
if (results.some(({ states }) => final(states) !== 'found')) process.exit(1);
