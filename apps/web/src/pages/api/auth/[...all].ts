import type { APIRoute } from "astro";
import { createAuth, createDb } from "@quickspense/domain";

export const ALL: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const db = createDb(env.DB);
  const auth = createAuth(db, {
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
  });
  return auth.handler(ctx.request);
};
