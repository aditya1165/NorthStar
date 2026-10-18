import { expect, test } from "@playwright/test";

test("renders the stadium twin while congestion monitoring connects", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "CrowdGuardian" })).toBeVisible();
  await expect(page.getByText("Stadium simulation")).toBeVisible();
  await expect(page.getByText(/Detector (live|connecting|unavailable)/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("allows an operator to close and reopen any stadium gate", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Close Gate D" }).click();
  await expect(page.getByRole("button", { name: "Open Gate D" })).toBeVisible();

  await page.getByRole("button", { name: "Open Gate D" }).click();
  await expect(page.getByRole("button", { name: "Close Gate D" })).toBeVisible();
});

test("surfaces backend-detected Gate B congestion in the existing UI", async ({ page }) => {
  await page.addInitScript(() => {
    type Listener = (event: Event | MessageEvent) => void;
    class MockCongestionSocket {
      static readonly OPEN = 1;
      readonly OPEN = 1;
      readyState = 0;
      bufferedAmount = 0;
      private listeners = new Map<string, Set<Listener>>();

      constructor() {
        setTimeout(() => {
          this.readyState = 1;
          this.emit("message", new MessageEvent("message", { data: JSON.stringify({ message_type: "ready" }) }));
        }, 0);
      }

      addEventListener(type: string, listener: Listener) {
        const listeners = this.listeners.get(type) ?? new Set<Listener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      send(value: string) {
        const batch = JSON.parse(value) as {
          run_id: string;
          sequence: number;
          simulation_time_seconds: number;
        };
        const gate = (gate_id: string, label: string) => ({
          gate_id,
          label,
          level: gate_id === "gate_b" ? "high" : "normal",
          congested: gate_id === "gate_b",
          people_count: gate_id === "gate_b" ? 180 : 10,
          density_per_m2: gate_id === "gate_b" ? 3.4 : 0.1,
          queue_length: gate_id === "gate_b" ? 126 : 0,
          mean_speed_mps: gate_id === "gate_b" ? 0.3 : 1.2,
          throughput_per_min: gate_id === "gate_b" ? 0 : 90,
          detected_at_seconds: gate_id === "gate_b" ? 5 : null,
          reason: gate_id === "gate_b" ? "Congestion detected" : "Gate approach operating normally",
        });
        this.emit(
          "message",
          new MessageEvent("message", {
            data: JSON.stringify({
              message_type: "congestion",
              run_id: batch.run_id,
              sequence: batch.sequence,
              simulation_time_seconds: batch.simulation_time_seconds,
              gates: ["A", "B", "C", "D", "E", "F", "G", "H"].map((letter) =>
                gate(`gate_${letter.toLowerCase()}`, `Gate ${letter}`),
              ),
            }),
          }),
        );
      }

      close() {
        this.readyState = 3;
        this.emit("close", new Event("close"));
      }

      private emit(type: string, event: Event | MessageEvent) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    Object.defineProperty(window, "WebSocket", { configurable: true, value: MockCongestionSocket });
  });

  await page.goto("/");

  await expect(page.getByText(/Congestion detected · Gate B/)).toBeVisible();
  await expect(page.getByText("Backend detection")).toBeVisible();
  await expect(page.getByText(/Open · available exit · queue 126/)).toBeVisible();
});
