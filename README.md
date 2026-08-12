# `useLiveSuspenseQuery` leaves a derived collection pending after parameterized nested-query re-evaluation

## Describe the bug

A derived collection created by a parameterized nested query renders for its
first document but remains pending when the parameter changes to a second
document. The identical query succeeds with `useLiveQuery`.

## To reproduce

```sh
pnpm install
pnpm run repro
```

The example displays a Documents view and a Tags view. The Tags view evaluates
a query for the selected document:

```text
Document -> folder membership -> folder -> tag
```

The test changes the selected document through the UI and performs:

1. Select Documents.
2. Select Document A.
3. Select Details, then Tags.
4. Return to Documents.
5. Select Document B.
6. Select Details, then Tags.

Output:

```text
useLiveSuspenseQuery Document A 1
useLiveSuspenseQuery Document B 0
useLiveQuery Document A 1
useLiveQuery Document B 1
```

The number is the count of rendered tag views. The first two lines use
`useLiveSuspenseQuery`; the last two are the `useLiveQuery` control.

## Expected behavior

Both Document A and Document B should render their tag view.

## Actual behavior

The second `useLiveSuspenseQuery` view does not render within the test
interval, while the non-Suspense control renders both views.

## Setup

The query uses `@tanstack/db`, `@tanstack/electric-db-collection`, and
`@tanstack/react-db` with a deterministic, local Electric-compatible shape
endpoint. View changes are local React state changes triggered by buttons. The
same query is run once with `useLiveSuspenseQuery` and once with `useLiveQuery`
as a control.

Versions:

- `@tanstack/db`: `0.6.17`
- `@tanstack/electric-db-collection`: `0.3.15`
- `@tanstack/react-db`: `0.1.95`
- `react`: `19.2.8`
- `vite`: `8.2.0`
