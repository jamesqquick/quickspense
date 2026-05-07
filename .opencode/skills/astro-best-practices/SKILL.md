---
name: astro-best-practices
description: Best practices and conventions for writing Quickspense application code on Astro 5 SSR + Cloudflare Workers + D1 + Drizzle ORM in a pnpm monorepo (apps/web, apps/worker, packages/domain). Covers server-first data fetching in `.astro` frontmatter, Astro Actions for client → server mutations (`apps/web/src/actions/`), Astro API route handlers reserved for webhooks and external integrations, Zod schemas exported from `@quickspense/domain`, `Astro.locals.user` auth, Drizzle/D1 query patterns via `createDb(locals.runtime.env.DB)` and the `@quickspense/domain` services namespace, React component data flow (props from server, no useEffect fetching), Workflows (background processing via service binding to apps/worker), MCP server patterns, design tokens in `apps/web/src/styles/global.css`, named exports, shared types from `@quickspense/domain`, and file placement across the monorepo. Use this skill whenever writing or modifying `.astro` pages, Astro Actions, files under `apps/web/src/pages/api/`, Drizzle queries, validation schemas, React components that talk to the server, MCP tools or Workflow steps in `apps/worker`, or any code handling authenticated user requests in this repo. Also trigger on "add an Astro action", "add an API endpoint", "create a page", "fetch data", "mutation handler", "auth check", "Drizzle query", "new table", "new component", "add MCP tool", "add workflow step", or any task touching server-side request handling, schema changes, or styling decisions in Quickspense.
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

## 2. Use Astro Actions for client → server mutations

All create / update / delete operations triggered from the browser must
go through typed **Astro Actions** (`apps/web/src/actions/index.ts` or
files re-exported from it), not raw `fetch` calls from React components
to API routes.

Actions give us:

- End-to-end type safety from the React component to the Drizzle service
  call. The `actions.foo({ ... })` callsite is fully typed against the
  Zod `input` schema and the action's return type.
- Automatic request validation. Zod parsing runs before the handler body,
  and validation failures come back as a structured `error` object (no
  manual `safeParse` boilerplate).
- A consistent error shape (`ActionError` with `code` + `message`) that
  React components can pattern-match on without inventing a JSON contract
  per endpoint.

> **API routes are reserved.** New `apps/web/src/pages/api/**/*.ts`
> handlers should be added only for **webhooks** (Stripe, email, etc.)
> and **external integrations** that can't go through Actions because
> the caller isn't our own React code. Existing `/api/*` mutation
> endpoints are legacy; prefer migrating to Actions when touching them.

Every action must:

1. Check `locals.user` first and throw `ActionError({ code: "UNAUTHORIZED" })`
   if missing. Middleware should already enforce this for authenticated
   pages, but defense in depth is cheap.
2. Declare an `input:` Zod schema. Import the schema from
   `@quickspense/domain` whenever the same shape is reused server-side
   (Workflows, MCP tools); only inline a one-off schema when the input
   is genuinely action-local.
3. Instantiate the DB with `createDb(locals.runtime.env.DB)`.
4. Call into a service namespace from `@quickspense/domain`
   (`expenses.*`, `categories.*`, `receipts.*`, etc.) for the actual
   data work. Do not write Drizzle queries inline in actions.
5. Translate typed `DomainError` subclasses (`NotFoundError`,
   `ConflictError`, `ValidationError`) into `ActionError` with the
   matching code so the client can react appropriately.
6. Return the resource (or the minimal typed payload the UI needs).
   Don't return raw Drizzle row objects with internal fields the client
   shouldn't see.

```ts
// apps/web/src/actions/index.ts
import { defineAction, ActionError } from "astro:actions";
import {
  expenses,
  updateExpenseSchema,
  createDb,
} from "@quickspense/domain";

export const server = {
  expense: {
    update: defineAction({
      accept: "json",
      input: updateExpenseSchema.extend({
        id: z.string().uuid(),
      }),
      handler: async ({ id, ...patch }, { locals }) => {
        const user = locals.user;
        if (!user) {
          throw new ActionError({
            code: "UNAUTHORIZED",
            message: "You need to sign in to update expenses.",
          });
        }

        const db = createDb(locals.runtime.env.DB);

        try {
          return await expenses.updateExpense(db, id, user.id, patch);
        } catch (e) {
          if (e instanceof Error && e.name === "NotFoundError") {
            throw new ActionError({
              code: "NOT_FOUND",
              message: "We couldn't find that expense.",
            });
          }
          console.error("[expense.update] failed:", e);
          throw new ActionError({
            code: "INTERNAL_SERVER_ERROR",
            message: "We couldn't update the expense. Please try again.",
          });
        }
      },
    }),
  },
};
```

### When to use an API route instead

Add an `apps/web/src/pages/api/**/*.ts` handler when:

- The caller is **not our React code** — e.g. Stripe webhooks
  (`/api/webhooks/stripe`), inbound email, OAuth callbacks, third-party
  pings.
- The endpoint is consumed by an **external client** that can't speak
  Actions — e.g. an integration that posts JSON to a stable URL.
- You need **streaming** or response shapes Actions don't model well
  (e.g. CSV export with `Content-Type: text/csv`, raw file downloads).

API routes follow the pattern already in
`apps/web/src/pages/api/expenses/[id].ts` (try/catch, typed
`APIRoute`, JSON `Response`, schemas from `@quickspense/domain`). Don't
introduce a new variant; if you find yourself reaching for an API route
for a normal browser-initiated mutation, that's the signal to use an
Action instead.

---

## 3. Keep React components UI-only

A React component (`*.tsx`) is a **UI + interactivity layer**, not a data
layer.

- Receive all initial data as props from the `.astro` page.
- For **user-triggered mutations** (button clicks, form submits), import
  `actions` from `astro:actions` and call the typed action. Don't write
  raw `fetch('/api/...')` calls for things our own UI initiates.
- For **live updates** (polling for processing status, etc.), call an
  Action on an interval — don't reach for a separate API route.
- Do not call any server endpoint on initial mount just to load data
  that could have been server-rendered in the `.astro` page.

```tsx
// Good: props come from the server, mutations go through actions
import { actions } from "astro:actions";

export function ExpenseRow({ expense }: { expense: Expense }) {
  async function save(patch: Partial<Expense>) {
    const { data, error } = await actions.expense.update({
      id: expense.id,
      ...patch,
    });
    if (error) {
      // error is a typed ActionError; pattern-match on error.code
      setError(actionFallback(error, "We couldn't save your changes."));
      return;
    }
    onUpdated(data);
  }
  // ...
}

// Bad: raw fetch to a hand-rolled API route
async function save(patch) {
  const res = await fetch(`/api/expenses/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  // untyped, no validation, custom error contract
}

// Bad: fetches its own initial data on mount
export function ExpenseList() {
  const [expenses, setExpenses] = useState([]);
  useEffect(() => { fetch('/api/expenses').then(...) }, []);
}
```

---

## 4. Schemas and types live in `@quickspense/domain`

All cross-cutting Zod schemas, TypeScript types, and the Drizzle schema
live in `packages/domain` and are imported by name from
`@quickspense/domain`. Action `input:` schemas, MCP tool input schemas,
and any API-route validation should reference these shared schemas
rather than redefining them. Do not duplicate types between `apps/web`
and `apps/worker`.

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
  `packages/domain/src/services/*.ts` and call them from Astro Actions,
  API route handlers, Workflows, or MCP tools. This keeps query logic
  out of `apps/` entirely.
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

// Bad: Drizzle query inline in an Action, API route, or .astro page
```

---

## 6. Access control

- Astro Actions and `/api/*` routes both rely on
  `apps/web/src/middleware.ts` populating `locals.user`. Handlers must
  still **assume nothing** and verify `locals.user` is present before
  touching data, throwing `ActionError({ code: "UNAUTHORIZED" })` (in
  Actions) or returning `401` (in API routes).
- All resource access must be scoped by `user.id`. Domain service
  functions accept `userId` and filter by it; never trust
  client-supplied `userId` from the action input, request body, or
  query string.
- Bearer-token routes (the MCP server in `apps/worker`) must validate
  the token and resolve a `userId` from it before any DB access.

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
  the same ones the Astro Actions in `apps/web/src/actions/` use.
  Don't duplicate.
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
| Browser-initiated mutation (create / update / delete) | `apps/web/src/actions/index.ts` (Astro Action) |
| Webhook / external integration endpoint | `apps/web/src/pages/api/**/*.ts` (API route) |
| File download / streaming response (e.g. CSV export) | `apps/web/src/pages/api/**/*.ts` (API route) |
| Interactive React component | `apps/web/src/components/*.tsx` |
| Astro (server-only) component | `apps/web/src/components/*.astro` |
| Shared layout | `apps/web/src/layouts/*.astro` |
| Web-only helper (no domain logic) | `apps/web/src/lib/*.ts` |
| Reusable DB query / domain logic | `packages/domain/src/services/*.ts` |
| Request / action input Zod schema | `packages/domain/src/schema.ts` |
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

In Astro Actions (`apps/web/src/actions/`), API route handlers
(`apps/web/src/pages/api/**/*.ts`), Workflow steps
(`apps/worker/src/`), and MCP tools, wrap every `db.insert` /
`db.update` / `db.delete` and every external `fetch` (Stripe, mail,
AI, R2, etc.) in a `try/catch`. On failure:

- `console.error` with a prefix that identifies the handler, e.g.
  `console.error("[expense.update] failed:", error)`.
- In **Actions**, throw an `ActionError` with a `code` and a friendly
  `message`. The `code` should map to the Astro Actions error vocabulary
  (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `BAD_REQUEST`,
  `CONFLICT`, `INTERNAL_SERVER_ERROR`). The client receives this as
  `{ error }` and can pattern-match.
- In **API routes**, return a clean JSON response:
  `new Response(JSON.stringify({ error: "<friendly message>" }), { status: 500, headers: { "Content-Type": "application/json" } })`.
- Use the typed domain errors from `@quickspense/domain`
  (`NotFoundError`, `ConflictError`, `ValidationError`,
  `UnauthorizedError`, `ForbiddenError`) where they apply, and
  translate them to the right `ActionError` code (or HTTP status, in
  API routes).

```ts
// In an Astro Action
} catch (e: unknown) {
  if (e instanceof Error && e.name === "NotFoundError") {
    throw new ActionError({
      code: "NOT_FOUND",
      message: "We couldn't find that expense.",
    });
  }
  console.error("[expense.update] failed:", e);
  throw new ActionError({
    code: "INTERNAL_SERVER_ERROR",
    message: "We couldn't update the expense. Please try again.",
  });
}

// In an API route (webhook / external integration)
} catch (e: unknown) {
  if (e instanceof Error && e.name === "NotFoundError") {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  console.error("[stripeWebhook] failed:", e);
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

- For Astro Actions, declare an `input:` Zod schema (preferably one
  imported from `@quickspense/domain`). Astro will reject malformed
  input before your handler runs, and the client receives a typed
  `error` with `code: "BAD_REQUEST"` and per-field details.
- For API routes (webhooks, external integrations), parse `request.json()`
  with a Zod schema from `@quickspense/domain` and return `400` on
  failure. Never read raw fields off `request.json()`.
- Verify foreign-key parents exist (e.g. `category_id` →
  `categories.id`) with an explicit lookup and a `NotFoundError` /
  `ValidationError` **before** the `insert` — Zod can't catch
  referential integrity.
- Coerce empty strings to `null` for nullable text columns
  (`description: description?.trim() || null`) so D1 doesn't reject on
  `NOT NULL` or FK constraints when the client sends `""`.

### Rule 3 — Never display raw server errors in the UI

In React components calling Actions, destructure `{ data, error }` from
`actions.foo(...)` and only display `error.message` when it's a
server-controlled `ActionError` produced by Rule 1's `try/catch`. Any
other error surface (network failure, unexpected exception, raw `Error`
from a non-Action call) gets a generic, action-specific fallback like
"We couldn't update the expense. Please try again."

If a helper like `friendlyActionErrorMessage` is added to
`apps/web/src/lib/`, route every error display through it.

```tsx
const { data, error } = await actions.expense.update({ id, ...patch });
if (error) {
  // error is a typed ActionError when produced by our Action's throw.
  // We trust error.message because Rule 1 made it user-safe; the
  // fallback covers the unexpected-exception path.
  setError(error.message ?? "We couldn't update the expense. Please try again.");
  return;
}
```

Anti-pattern — passes the raw thrown message straight to the UI:

```tsx
setError(err instanceof Error ? err.message : "Update failed");
```

Error containers should also include `break-words` (or equivalent) as a
layout safety belt so any message that does slip through wraps cleanly.

### Pre-merge checklist

When adding or modifying an Astro Action, API route, Workflow step,
MCP tool, or any UI that triggers a server mutation, confirm before
requesting review:

- [ ] Browser-initiated mutations go through Astro Actions, not raw
      `fetch` to API routes. Webhooks and streaming responses are the
      only sanctioned API-route use cases.
- [ ] Every `db.insert` / `db.update` / `db.delete` and every external
      `fetch` is wrapped in `try/catch` that throws a friendly
      `ActionError` (in Actions) or returns a JSON `Response` (in API
      routes).
- [ ] Every error displayed to the user is either a server-controlled
      friendly message or a UI-specific generic fallback — never a raw
      thrown `Error.message`.
- [ ] No client-facing error string mentions SQL, table/column names,
      stack traces, or driver-specific text.
- [ ] All cross-cutting Zod schemas come from `@quickspense/domain` —
      none inline in actions, route handlers, or components (action-local
      one-off shapes are the exception).
