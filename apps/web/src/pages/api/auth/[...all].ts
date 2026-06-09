import type { APIRoute } from "astro";
import { createAuth, createDb } from "@quickspense/domain";

export const ALL: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime.env;
  const db = createDb(env.DB);
  const baseURL = env.BETTER_AUTH_URL || ctx.url.origin;
  const auth = createAuth(db, {
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: baseURL,
  });
  return auth.handler(ctx.request);
};
