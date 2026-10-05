import type { APIRoute } from "astro";
import { handleStripeWebhook } from "@/lib/stripeWebhook";

export const prerender = false;
export const POST: APIRoute = ({ request, locals }) => handleStripeWebhook(request, locals, "connected");
