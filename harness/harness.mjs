// Shared Playwright harness for the repros.
//
// Every run records page errors, console errors and Electric sync errors. A
// run with any of those is reported as INVALID instead of being counted as a
// pass or a failure, so a broken mock or a crashed root can no longer be
// mistaken for the behaviour under test.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const viteBin = fileURLToPath(
  new URL('../node_modules/vite/bin/vite.js', import.meta.url),
);

export async function startVite(directory, port) {
  const server = spawn(
    process.execPath,
    [viteBin, '--config', `${directory}vite.config.mjs`, '--port', String(port), '--strictPort'],
    { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, REPRO_PORT: String(port) } },
  );
  const output = [];
  server.stdout.on('data', (chunk) => output.push(String(chunk)));
  server.stderr.on('data', (chunk) => output.push(String(chunk)));
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${url}/`)).ok) return { url, stop: () => server.kill('SIGTERM') };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  server.kill('SIGTERM');
  throw new Error(`vite did not start:\n${output.join('')}`);
}

export function launchBrowser() {
  // CHROMIUM_PATH lets the repro run where Playwright's bundled browser for
  // this exact version is not installed.
  return chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
}

export async function openPage(browser, url) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  await page.goto(url);
  return {
    page,
    problems,
    close: () => context.close(),
  };
}

export async function resetFake(baseUrl, config) {
  const response = await fetch(`${baseUrl}/__fake/reset`, {
    method: 'POST',
    body: JSON.stringify(config),
  });
  if (!response.ok) throw new Error(`reset failed: ${response.status}`);
}

// Collapse a render timeline into the sequence of distinct visible states.
export function stateSequence(timeline) {
  const states = [];
  for (const entry of timeline) {
    if (entry.event !== 'view') continue;
    const label = entry.state;
    if (states.at(-1)?.label !== label) states.push({ label, t: entry.t });
  }
  return states;
}
