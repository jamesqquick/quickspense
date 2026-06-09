import { createAuthClient } from "better-auth/client";
import { apiKeyClient } from "@better-auth/api-key/client";

export const authClient = createAuthClient({
  plugins: [apiKeyClient()],
});
