# `useLiveSuspenseQuery` does not resolve after an optimistic create and immediate parameterized query

## Describe the bug

After an item is optimistically inserted into an Electric-backed collection,
an immediate transition to a parameterized detail view can leave the
`useLiveSuspenseQuery` view unresolved. The identical flow succeeds with
`useLiveQuery`.

## To reproduce

```sh
pnpm install
pnpm run repro
```

The example performs:

1. Open the create view.
2. Click `Save`, which optimistically inserts a report.
3. Immediately render the parameterized `Permissions` view for that report.

Output:

```text
useLiveSuspenseQuery 0
useLiveQuery 1
```

The number is the count of rendered permission views. The command exits
nonzero when the Suspense variant fails to render.

## Expected behavior

The created report should be available to the parameterized query immediately
after the optimistic insert.

## Actual behavior

`useLiveSuspenseQuery` does not render the created report, while the identical
query using `useLiveQuery` does render it.

## Setup

The reproduction uses React state, an optimistic collection insert, a
parameterized `findOne()` query, and a deterministic local
Electric-compatible shape endpoint. The domain is intentionally generic:
reports and permissions.

Versions:

- `@tanstack/db`: `0.11.1`
- `@tanstack/electric-db-collection`: `0.5.2`
- `@tanstack/react-db`: `0.5.1`
- `react`: `19.2.8`
- `vite`: `8.3.2`
