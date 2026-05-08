type FlashToastType = "success" | "error" | "info";

/**
 * Append toast params to a destination URL so the next page can fire the toast
 * after a full navigation/redirect. The Toaster component reads these params on
 * mount and strips them from the URL via history.replaceState.
 */
export function withFlashToast(
  url: string,
  type: FlashToastType,
  message: string,
): string {
  const u = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
  u.searchParams.set("toast", type);
  u.searchParams.set("toast_msg", message);
  // If the original input was a relative path, return a relative path back.
  if (url.startsWith("/") && !url.startsWith("//")) {
    return `${u.pathname}${u.search}${u.hash}`;
  }
  return u.toString();
}

/**
 * Navigate to `path` with a flash toast that the destination page will show
 * after the redirect. Uses window.location.href so it works for hard
 * navigations (post-form-submit redirects, account deletion, etc.).
 */
export function navigateWithFlashToast(
  path: string,
  type: FlashToastType,
  message: string,
): void {
  if (typeof window === "undefined") return;
  window.location.href = withFlashToast(path, type, message);
}
