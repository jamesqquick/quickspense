import type { APIRoute } from "astro";
import { auth } from "@quickspense/domain";

export const POST: APIRoute = async ({ locals, cookies, redirect }) => {
  const sessionId = cookies.get("session")?.value;
  if (sessionId) {
    const db = locals.runtime.env.DB;
    await auth.deleteSession(db, sessionId);
  }
  cookies.delete("session", { path: "/" });
  return redirect("/login");
};
