import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const directory = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.REPRO_PORT ?? 4313);
const server = spawn(
  process.execPath,
  [`${directory}../node_modules/vite/bin/vite.js`, '--config', `${directory}vite.config.mjs`],
  { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] },
);

try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const run = async (useNonSuspense) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    if (useNonSuspense) {
      await page.addInitScript(() => {
        window.__reproUseNonSuspense = true;
      });
    }
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(1000);
    const rendered = await page.getByTestId('report-result').count();
    console.log(useNonSuspense ? 'useLiveQuery' : 'useLiveSuspenseQuery', rendered);
    await browser.close();
    return rendered === 1;
  };

  const suspenseResult = await run(false);
  const nonSuspenseResult = await run(true);
  if (!suspenseResult || !nonSuspenseResult) {
    throw new Error('create-navigation reproduction did not render both controls');
  }
} finally {
  server.kill('SIGTERM');
}
