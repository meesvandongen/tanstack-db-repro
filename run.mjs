import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(
  new URL('./package.json', import.meta.url),
);
const { chromium } = require('@playwright/test');

const directory = fileURLToPath(new URL('.', import.meta.url));
const server = spawn(
  process.execPath,
  [
    `${directory}/node_modules/vite/bin/vite.js`,
    '--config',
    `${directory}/vite.config.mjs`,
  ],
  {
    cwd: directory,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

const output = [];
server.stdout.on('data', (chunk) => output.push(String(chunk)));
server.stderr.on('data', (chunk) => output.push(String(chunk)));

try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:4310/');
      if (response.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const browser = await chromium.launch({ headless: true });
  const runSequence = async (page, label) => {
    await page.goto('http://127.0.0.1:4310/');
    await page.getByRole('link', { name: 'Documents' }).click();

    for (const document of ['Document A', 'Document B']) {
      await page.getByRole('link', { name: document }).click();
      await page.getByRole('link', { name: 'Details' }).click();
      await page.getByRole('link', { name: 'Tags' }).click();
      await page.waitForTimeout(1000);
      const count = await page.getByTestId('document-tags').count();
      console.log(label, document, count);
      if (count !== 1) {
        return false;
      }
      await page.getByRole('link', { name: 'Documents' }).click();
    }
    return true;
  };

  const suspensePage = await browser.newPage();
  if (await runSequence(suspensePage, 'useLiveSuspenseQuery')) {
    throw new Error('The suspense reproduction unexpectedly passed');
  }

  const nonSuspensePage = await browser.newPage();
  await nonSuspensePage.addInitScript(() => {
    window.__reproUseNonSuspense = true;
  });
  if (!(await runSequence(nonSuspensePage, 'useLiveQuery'))) {
    throw new Error('The non-suspense control unexpectedly failed');
  }

  await browser.close();
} finally {
  server.kill('SIGTERM');
  if (output.length > 0) {
    process.stderr.write(output.join(''));
  }
}
