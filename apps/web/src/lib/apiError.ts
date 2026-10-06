export function getApiErrorMessage(data: unknown, fallback: string): string {
  if (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "string" &&
    data.error.length > 0
  ) {
    return data.error;
  }
  return fallback;
}
