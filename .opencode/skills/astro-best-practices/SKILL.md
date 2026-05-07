---
name: astro-best-practices
description: Best practices and conventions for writing Quickspense application code on Astro 5 SSR + Cloudflare Workers + D1 + Drizzle ORM in a pnpm monorepo (apps/web, apps/worker, packages/domain). Covers server-first data fetching in `.astro` frontmatter, Astro API route handlers under `apps/web/src/pages/api/`, Zod schemas exported from `@quickspense/domain`, `Astro.locals.user` auth, Drizzle/D1 query patterns via `createDb(locals.runtime.env.DB)` and the `@quickspense/domain` services namespace, React component data flow (props from server, no useEffect fetching), Workflows (background processing via service binding to apps/worker), MCP server patterns, design tokens in `apps/web/src/styles/global.css`, named exports, shared types from `@quickspense/domain`, and file placement across the monorepo. Use this skill whenever writing or modifying `.astro` pages, files under `apps/web/src/pages/api/`, Drizzle queries, validation schemas, React components that talk to the server, MCP tools or Workflow steps in `apps/worker`, or any code handling authenticated user requests in this repo. Also trigger on "add an API endpoint", "create a page", "fetch data", "mutation handler", "auth check", "Drizzle query", "new table", "new component", "add MCP tool", "add workflow step", or any task touching server-side request handling, schema changes, or styling decisions in Quickspense.
---

# Quickspense — Development Best Practices

Patterns and conventions for contributing to Quickspense.
The stack is **Astro 5 (SSR) + Cloudflare Workers + D1 + Drizzle ORM**,
laid out as a **pnpm monorepo**:

```
apps/web/        Astro SSR web app (Worker)
apps/worker/     Background Worker — Workflows + MCP server
packages/domain/ Shared business logic, Drizzle schema, Zod schemas, types
migrations/      D1 SQL migrations (shared)
```

Apply these rules when writing new code or modifying existing code in this
repo. Prefer following an established pattern in the codebase over inventing
a new one; if a rule below conflicts with what you find in `apps/` or
`packages/`, surface the discrepancy rather than silently picking one.

---

## 1. Server-first by default

Astro runs on the server at the edge. Use it.

- **Fetch data in `.astro` frontmatter**, never in a `useEffect` on mount
  unless the data genuinely can't be known until the user interacts.
- **Pass data as props** from the `.astro` page down to React components.
  The React component should receive ready-to-render data, not fetch it
  itself.
- **Access `Astro.locals.user` directly** in `.astro` files; never re-fetch
  the session from a client component.

```astro
---
// Good: fetch on the server, pass as props
import { expenses, createDb } from "@quickspense/domain";

const user = Astro.locals.user!;
const db = createDb(Astro.locals.runtime.env.DB);
const data = await expenses.listExpenses(db, user.id);
---
<ExpenseList client:load expenses={data} />
```

```tsx
// Bad: fetching on mount
useEffect(() => {
  fetch('/api/expenses').then(...)
}, []);
```

---

## 2. Use Astro API routes for mutations

All create / update / delete operations must go through typed **Astro API
route handlers** (`apps/web/src/pages/api/**/*.ts`), not inline `fetch`
calls to arbitrary URLs.

Every handler must:

1. Check `locals.user` first — return `401` immediately if missing
   (middleware should already enforce this for `/api/*`, but defense in
   depth is cheap).
2. Instantiate the DB with `createDb(locals.runtime.env.DB)`.
3. Parse and validate the request body with a **Zod schema imported from
   `@quickspense/domain`**. Do not read raw fields off `request.json()`.
4. Call into a service namespace from `@quickspense/domain`
   (`expenses.*`, `categories.*`, `receipts.*`, etc.) for the actual
   data work. Do not write Drizzle queries inline in API routes.
5. Return a typed JSON response and set `Content-Type: application/json`.
   Match the existing pattern: `new Response(JSON.stringify(...), { status, headers })`.

```ts
// apps/web/src/pages/api/expenses/[id].ts
import type { APIRoute } from "astro";
import {
  expenses,
  updateExpenseSchema,
  createDb,
} from "@quickspense/domain";

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  try {
    const user = locals.user!;
    const db = createDb(locals.runtime.env.DB);
    const expenseId = params.id!;

    const parsed = updateExpenseSchema.safeParse(await request.json());
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const updated = await expenses.updateExpense(
      db,
      expenseId,
      user.id,
      parsed.data,
    );
    return new Response(JSON.stringify(updated), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "NotFoundError") {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("Update expense error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
```

---

## 3. Keep React components UI-only

A React component (`*.tsx`) is a **UI + interactivity layer**, not a data
layer.

- Receive all initial data as props from the `.astro` page.
- Only call API routes for **user-triggered mutations** (button clicks,
  form submits) or **live updates** (polling for processing status).
- Do not call API routes on initial mount just to load data that could
  have been server-rendered.

```tsx
// Good: props come from the server
export function ExpenseList({ expenses }: { expenses: Expense[] }) { ... }

// Bad: fetches its own initial data
export function ExpenseList() {
  const [expenses, setExpenses] = useState([]);
  useEffect(() => { fetch('/api/expenses').then(...) }, []);
}
```

---

## 4. Schemas and types live in `@quickspense/domain`

All cross-cutting Zod schemas, TypeScript types, and the Drizzle schema
live in `packages/domain` and are imported by name from
`@quickspense/domain`. Do not inline Zod schemas inside route handlers,
and do not duplicate types between `apps/web` and `apps/worker`.

| What you're adding | Where it goes |
|---|---|
| Request body Zod schema | `packages/domain/src/schema.ts` (or a sibling file re-exported from `index.ts`) |
| Cross-cutting TypeScript type | `packages/domain/src/types.ts` |
| New DB table / column | `packages/domain/src/db/` + new migration in `migrations/` |
| Domain service function (e.g. `expenses.updateExpense`) | `packages/domain/src/services/<area>.ts` |
| Typed domain error class | `packages/domain/src/errors.ts` |

After adding to `packages/domain`, make sure it is re-exported from
`packages/domain/src/index.ts` so consumers can import it via the package
name.

---

## 5. Database access

- Always instantiate the DB inside the request with
  `createDb(locals.runtime.env.DB)` (web) or
  `createDb(env.DB)` (worker / Workflow / MCP). Never import a singleton.
- Encapsulate multi-step or reused queries in
  `packages/domain/src/services/*.ts` and call them from route handlers,
  Workflows, or MCP tools. This keeps query logic out of `apps/`
  entirely.
- Drizzle schema lives in `packages/domain/src/db/` (and re-exported via
  `schema` from `@quickspense/domain`). Never write Drizzle queries inside
  React components or `.astro` files — move them to a domain service.

```ts
// Good: domain service that accepts db
export async function listExpenses(
  db: Database,
  userId: string,
  filters?: ListExpensesInput,
) { ... }

// Bad: Drizzle query inline in an API route or .astro page
```

---

## 6. Access control

- API routes for `/api/*` rely on `apps/web/src/middleware.ts` populating
  `locals.user`. The handler must still **assume nothing** and verify
  `locals.user` is present before touching data.
- All resource access must be scoped by `user.id`. Domain service
  functions accept `userId` and filter by it; never trust client-supplied
  `userId` from the request body or query string.
- Bearer-token routes (the MCP server in `apps/worker`) must validate the
  token and resolve a `userId` from it before any DB access.

---

## 7. Prefer `crypto.randomUUID()` for IDs

The project uses `crypto.randomUUID()` throughout. Do not introduce
`nanoid` or `Math.random()`-based IDs.

---

## 8. Workflows (background processing)

Receipt processing and other long-running work runs as a **Cloudflare
Workflow** in `apps/worker`. The web app triggers it via a **service
binding** to the worker.

- **D1 is the source of truth.** Persist intent (e.g. a receipt row in
  the `pending` state) before kicking off the Workflow.
- Workflow steps must be **idempotent** so retries are safe. Wrap each
  external call (R2, Workers AI, etc.) in its own `step.do(...)` so
  Workflow's automatic retry can resume from the failed step.
- A Workflow failure must never leave the DB in an inconsistent state —
  end every Workflow with a final step that flips the row to a terminal
  state (`completed` or `failed`) so the UI can render correctly.

---

## 9. MCP server (`apps/worker`)

The MCP server exposes tools and resources that wrap the same
`@quickspense/domain` services used by the web app.

- Tools must be authenticated. Resolve `userId` from the bearer token
  before doing any DB work.
- Tool input schemas must be Zod schemas from `@quickspense/domain` —
  the same ones the web API routes use. Don't duplicate.
- Tool error messages are user-facing (an LLM may show them to the
  user). Keep them short and free of SQL or stack traces; the same
  rules from "Error handling and user-facing messages" below apply.

---

## 10. Client-side state

- No state management library. Use `useState` / `useRef` / `useReducer`
  local to the component.
- Lift state only as far up as needed within the React tree. If two
  components need the same data, consider whether it should be
  server-rendered and passed as props instead.

---

## 11. Styling

- Tailwind v4 syntax. Design tokens are defined in
  `apps/web/src/styles/global.css` under `@theme` (e.g. `--color-primary-500`,
  `--color-surface-900`, `--font-sans`).
- Use the project's semantic color tokens (`text-primary-500`,
  `bg-surface-900`, etc.) over arbitrary Tailwind palette colors when a
  semantic token exists. Add new tokens to `@theme` rather than
  hardcoding hex values inline.

---

## 12. TypeScript

- Prefer **named exports** over default exports for all components,
  helpers, and types.
- Cross-cutting types live in `packages/domain/src/types.ts` (or a sibling
  file re-exported from `index.ts`). App-local types can live next to the
  component or page that owns them.
- Use `satisfies` or explicit return types on exported functions so
  callers get type-checked props/return values.

---

## 13. File placement cheat sheet

| What you're adding | Where it goes |
|---|---|
| New page | `apps/web/src/pages/*.astro` |
| New API endpoint | `apps/web/src/pages/api/**/*.ts` |
| Interactive React component | `apps/web/src/components/*.tsx` |
| Astro (server-only) component | `apps/web/src/components/*.astro` |
| Shared layout | `apps/web/src/layouts/*.astro` |
| Web-only helper (no domain logic) | `apps/web/src/lib/*.ts` |
| Reusable DB query / domain logic | `packages/domain/src/services/*.ts` |
| Request body Zod schema | `packages/domain/src/schema.ts` |
| Shared TypeScript type | `packages/domain/src/types.ts` |
| Domain error class | `packages/domain/src/errors.ts` |
| New DB table / column | `packages/domain/src/db/` + new file in `migrations/` |
| Design token | `apps/web/src/styles/global.css` (`@theme` block) |
| Background job step | `apps/worker/src/` (Workflow) |
| MCP tool / resource | `apps/worker/src/` |

---

## 14. Error handling and user-facing messages

User-facing error messages must never include raw server errors (SQL
statements, stack traces, driver messages, table or column names). The
goal is that a stranger could read the message without losing trust in
the app and without learning anything about the internals.

### Rule 1 — Wrap server-side DB writes and external calls

In API route handlers (`apps/web/src/pages/api/**/*.ts`), Workflow steps
(`apps/worker/src/`), and MCP tools, wrap every `db.insert` / `db.update`
/ `db.delete` and every external `fetch` (Stripe, mail, AI, R2, etc.) in
a `try/catch`. On failure:

- `console.error` with a prefix that identifies the handler, e.g.
  `console.error("[updateExpense] insert failed:", error)`.
- Return a clean JSON response:
  `new Response(JSON.stringify({ error: "<friendly message>" }), { status: 500, headers: { "Content-Type": "application/json" } })`.
- Use the typed domain errors from `@quickspense/domain` (`NotFoundError`,
  `ConflictError`, `ValidationError`, `UnauthorizedError`,
  `ForbiddenError`) where they apply, and translate them to the right
  status code in the route handler:

```ts
} catch (e: unknown) {
  if (e instanceof Error && e.name === "NotFoundError") {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  console.error("[updateExpense] failed:", e);
  return new Response(
    JSON.stringify({ error: "Internal server error" }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );
}
```

The friendly message must:

- Be short — one sentence, ≤ ~120 characters.
- Be safe for any user to read.
- Suggest a next step when possible ("Please try again", "Refresh the
  page").
- Never include SQL, table names, column names, or stack traces.

### Rule 2 — Validate before you persist

Catch the bad-input class of error before it ever reaches D1.

- Use a Zod schema from `@quickspense/domain` for every request body.
  Do not read raw fields off `request.json()`.
- Verify foreign-key parents exist (e.g. `category_id` →
  `categories.id`) with an explicit lookup and a `NotFoundError` /
  `ValidationError` **before** the `insert`.
- Coerce empty strings to `null` for nullable text columns
  (`description: description?.trim() || null`) so D1 doesn't reject on
  `NOT NULL` or FK constraints when the client sends `""`.

### Rule 3 — Never display raw server errors in the UI

In React components, all `setError(...)` calls and toast messages that
consume server-returned messages must guard against leaking raw
server text. If a future helper like `friendlyActionErrorMessage` is
added to `apps/web/src/lib/`, route through it. Until then, the rule
is: only display server-returned `error` strings that you control
(i.e., the ones produced by Rule 1's `try/catch`). Anything else gets a
generic, action-specific fallback like "We couldn't update the
expense. Please try again."

Anti-pattern — passes the raw thrown message straight to the UI:

```tsx
setError(err instanceof Error ? err.message : "Update failed");
```

Error containers should also include `break-words` (or equivalent) as a
layout safety belt so any message that does slip through wraps cleanly.

### Pre-merge checklist

When adding or modifying an API route, Workflow step, MCP tool, or any
UI that triggers a server mutation, confirm before requesting review:

- [ ] Every `db.insert` / `db.update` / `db.delete` and every external
      `fetch` is wrapped in `try/catch` returning a friendly JSON
      `Response` (or rethrowing a typed `DomainError`).
- [ ] Every error displayed to the user is either a server-controlled
      friendly message or an action-specific generic fallback — never a
      raw thrown `Error.message`.
- [ ] No client-facing error string mentions SQL, table/column names,
      stack traces, or driver-specific text.
- [ ] All Zod schemas come from `@quickspense/domain` — none inline in
      route handlers or components.
