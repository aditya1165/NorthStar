/** Empty means relative HTTP requests, handled by Vite or Nginx's API proxy. */
export function apiBaseUrl(): string {
  return (import.meta.env.VITE_API_URL as string | undefined)?.trim().replace(/\/+$/, "") ?? "";
}

/** Follow the page's HTTPS scheme unless an external endpoint is configured. */
export function congestionWebSocketUrl(origin = window.location.origin): string {
  const configured = (import.meta.env.VITE_CONGESTION_WS_URL as string | undefined)?.trim();
  if (configured) return configured;

  const url = new URL(`${apiBaseUrl()}/ws/congestion`, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
