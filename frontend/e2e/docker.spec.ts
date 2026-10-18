import { expect, test } from "@playwright/test";

interface TelemetrySummary {
  runId: string;
  sequence: number;
  population: number;
  identities: number;
  closedGates: string[];
}

interface PythonSnapshot {
  message_type: "congestion";
  run_id: string;
  sequence: number;
  gates: { gate_id: string; density_per_m2: number }[];
  zones: { gate_id: string | null; status: string }[];
  forecasts: { horizon_minutes: number; predicted_density: number; method: string }[];
  routing: { gate_wait_seconds: Record<string, number | null> };
}

test("Docker stadium streams real Python results and honors gate controls", async ({ page }, testInfo) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Set PLAYWRIGHT_BASE_URL to an already running full stack.");
  test.setTimeout(20_000);

  const pageErrors: string[] = [];
  const protocolErrors: string[] = [];
  const socketUrls: string[] = [];
  const sent = new Map<string, TelemetrySummary>();
  const received: PythonSnapshot[] = [];
  const frameKey = (runId: string, sequence: number) => `${runId}:${sequence}`;

  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Observe the actual transport; do not intercept responses or replace WebSocket.
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/ws/congestion") return;
    socketUrls.push(socket.url());
    socket.on("framesent", ({ payload }) => {
      const wire = JSON.parse(payload.toString());
      if (wire.message_type !== "telemetry") return;
      sent.set(frameKey(wire.run_id, wire.sequence), {
        runId: wire.run_id,
        sequence: wire.sequence,
        population: wire.population,
        identities: new Set([
          ...wire.agents.map((agent: { person_id: number }) => agent.person_id),
          ...wire.exited_agents.map((agent: { person_id: number }) => agent.person_id),
        ]).size,
        closedGates: wire.closed_gates,
      });
    });
    socket.on("framereceived", ({ payload }) => {
      const wire = JSON.parse(payload.toString());
      if (wire.message_type === "congestion") received.push(wire);
      if (wire.message_type === "error") protocolErrors.push(JSON.stringify(wire));
    });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "CrowdGuardian" })).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.getByText("Detector live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(() => received.length).toBeGreaterThan(0);

  const pageUrl = new URL(page.url());
  expect(socketUrls.length).toBeGreaterThan(0);
  for (const value of socketUrls) {
    const socketUrl = new URL(value);
    expect(socketUrl.host).toBe(pageUrl.host);
    expect(socketUrl.protocol).toBe(pageUrl.protocol === "https:" ? "wss:" : "ws:");
  }

  const initial = received[0];
  expect(sent.get(frameKey(initial.run_id, initial.sequence))).toMatchObject({
    population: 4_000,
    identities: 4_000,
  });
  expect(initial.gates).toHaveLength(8);
  expect(initial.zones).toHaveLength(12);
  expect(initial.forecasts).toHaveLength(24);
  expect(initial.gates.every((gate) => Number.isFinite(gate.density_per_m2))).toBe(true);
  expect(initial.forecasts.every((forecast) => Number.isFinite(forecast.predicted_density))).toBe(true);
  expect([...new Set(initial.forecasts.map((forecast) => forecast.horizon_minutes))]
    .sort((left, right) => left - right)).toEqual([5, 10]);

  await page.getByRole("button", { name: "Close Gate D", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Gate D", exact: true })).toBeVisible();
  const closedSnapshot = () => received.find((snapshot) => {
    const telemetry = sent.get(frameKey(snapshot.run_id, snapshot.sequence));
    return telemetry?.closedGates.includes("gate_d") &&
      snapshot.routing.gate_wait_seconds.gate_d === null &&
      snapshot.zones.some((zone) => zone.gate_id === "gate_d" && zone.status === "closed");
  });
  await expect.poll(() => Boolean(closedSnapshot())).toBe(true);
  const closed = closedSnapshot()!;

  await page.getByRole("button", { name: "Open Gate D", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close Gate D", exact: true })).toBeVisible();
  await expect.poll(() => received.some((snapshot) => {
    const telemetry = sent.get(frameKey(snapshot.run_id, snapshot.sequence));
    return snapshot.run_id === closed.run_id && snapshot.sequence > closed.sequence &&
      telemetry && !telemetry.closedGates.includes("gate_d") &&
      Number.isFinite(snapshot.routing.gate_wait_seconds.gate_d) &&
      snapshot.zones.some((zone) => zone.gate_id === "gate_d" && zone.status === "open");
  })).toBe(true);

  await page.screenshot({ path: testInfo.outputPath("docker-stadium.png"), fullPage: true });
  expect(protocolErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
