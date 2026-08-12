# TanStack DB navigation reproduction

- [x] Validated against the current package versions in this repository

## Describe the bug

When navigating between two parameterized routes that render the same nested
Electric/TanStack DB query, the second route can remain suspended indefinitely.
The URL changes, but the previous route content remains visible.

The issue is specific to `useLiveSuspenseQuery`. The same query and navigation
sequence works with `useLiveQuery`.

## To Reproduce

Install and run the standalone reproduction:

```sh
pnpm install
pnpm run repro
```

If port `4310` is already in use:

```sh
REPRO_PORT=4311 pnpm run repro
```

The Playwright runner performs this client-side sequence:

1. Open the Documents page.
2. Open `Document A`.
3. Open `Details`.
4. Open `Tags`.
5. Return to Documents.
6. Open `Document B`.
7. Open `Details`.
8. Open `Tags`.

The runner compares both hooks and prints:

```text
useLiveSuspenseQuery Document A 1
useLiveSuspenseQuery Document B 0
useLiveQuery Document A 1
useLiveQuery Document B 1
```

`1` means that the tag hierarchy rendered. `0` means that the target route
remained suspended.

## Expected behavior

The second `Tags` route should render the tag hierarchy for `Document B`, just
as it does for `Document A` and when using `useLiveQuery`.

## Actual behavior

With `useLiveSuspenseQuery`, the second route does not render its content after
client-side navigation.

## Minimal example

The reproduction uses:

- React 19
- React Router client-side navigation
- React Strict Mode
- `@tanstack/db` collections
- `@tanstack/electric-db-collection`
- `@tanstack/react-db`
- A local Electric-compatible shape endpoint
- A nested query with `materialize()`, joins, and a route parameter

The application domain is intentionally generic: documents, folders, and
tags. It does not depend on the original application.

## Package versions

- `@tanstack/db`: `0.6.17`
- `@tanstack/electric-db-collection`: `0.3.15`
- `@tanstack/react-db`: `0.1.95`
- `react`: `19.2.8`
- `react-dom`: `19.2.8`
- `react-router`: `8.3.0`
- `vite`: `8.2.0`
- `@playwright/test`: `1.62.1`

## Screenshots

Not applicable; the command-line runner reports the rendered target count.

## Desktop

- OS: macOS
- Browser: Chromium via Playwright
- Browser version: installed Playwright Chromium

## Smartphone

Not tested.

## Additional context

The source collections are already synchronized before navigation. The
non-suspending control succeeds for both documents, which isolates the
behavior to the Suspense/live-query lifecycle rather than the nested query
data itself.

The relevant files are:

- `main.jsx` — application and nested query
- `vite.config.mjs` — local Electric-compatible shape endpoint
- `run.mjs` — automated client-navigation reproduction
