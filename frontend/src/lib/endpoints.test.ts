import { afterEach, describe, expect, it, vi } from "vitest";

import { apiBaseUrl, congestionWebSocketUrl } from "./endpoints";

afterEach(() => vi.unstubAllEnvs());

describe("backend endpoints", () => {
  it("defaults HTTP requests to the current origin", () => {
    vi.stubEnv("VITE_API_URL", undefined);
    expect(apiBaseUrl()).toBe("");
  });

  it.each([
    ["http://localhost:8080", "ws://localhost:8080/ws/congestion"],
    ["https://northstar.example", "wss://northstar.example/ws/congestion"],
  ])("uses the page origin and scheme for %s", (origin, expected) => {
    vi.stubEnv("VITE_API_URL", "");
    vi.stubEnv("VITE_CONGESTION_WS_URL", "");
    expect(congestionWebSocketUrl(origin)).toBe(expected);
  });

  it("supports an external API origin without doubled slashes", () => {
    vi.stubEnv("VITE_API_URL", " https://api.example/ ");
    vi.stubEnv("VITE_CONGESTION_WS_URL", "");
    expect(apiBaseUrl()).toBe("https://api.example");
    expect(congestionWebSocketUrl("https://northstar.example")).toBe("wss://api.example/ws/congestion");
  });

  it("supports a same-origin API path prefix", () => {
    vi.stubEnv("VITE_API_URL", "/backend/");
    vi.stubEnv("VITE_CONGESTION_WS_URL", "");
    expect(congestionWebSocketUrl("https://northstar.example")).toBe("wss://northstar.example/backend/ws/congestion");
  });

  it("gives an explicit WebSocket URL precedence over the API origin", () => {
    vi.stubEnv("VITE_API_URL", "https://api.example");
    vi.stubEnv("VITE_CONGESTION_WS_URL", " wss://stream.example/custom?token=example ");
    expect(congestionWebSocketUrl("https://northstar.example")).toBe("wss://stream.example/custom?token=example");
  });
});
