type ToastType = "success" | "error" | "info";

/**
 * Helper for vanilla `<script>` blocks in Astro pages to fire a toast.
 * The Toaster component mounts client-side via `client:load` and exposes
 * `window.qsToast`. If the script runs before hydration (rare but possible
 * for instant submits), we poll briefly and then fall back to alert().
 */
export function showToast(type: ToastType, message: string): void {
  if (typeof window === "undefined") return;

  if (window.qsToast) {
    window.qsToast(type, message);
    return;
  }

  let attempts = 0;
  const interval = window.setInterval(() => {
    attempts += 1;
    if (window.qsToast) {
      window.clearInterval(interval);
      window.qsToast(type, message);
    } else if (attempts >= 50) {
      // ~5s of waiting. Fall back to alert so the user still sees it.
      window.clearInterval(interval);
      window.alert(message);
    }
  }, 100);
}
