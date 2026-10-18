import { expect, test } from "@playwright/test";

interface Agent {
  person_id: number;
  x: number;
  z: number;
  target_gate: string;
  phase: string;
}
interface Batch {
  run_id: string;
  sequence: number;
  simulation_time_seconds: number;
  agents: Agent[];
  exited_agents: { person_id: number }[];
  closed_gates: string[];
}

test("closed boundary gates block crossing; people automatically find an open door along the outer circle", async ({ page }, testInfo) => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "Requires a real full stack.");
  test.setTimeout(180_000);
  const batches: Batch[] = [];
  const assignments: { reason: string }[] = [];
  const errors: string[] = [];
  let approvals = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.url().endsWith("/approve")) approvals += 1; });
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/ws/congestion")) return;
    socket.on("framesent", ({ payload }) => {
      const wire = JSON.parse(payload.toString());
      if (wire.message_type === "telemetry") batches.push(wire);
    });
    socket.on("framereceived", ({ payload }) => {
      const wire = JSON.parse(payload.toString());
      if (wire.message_type === "error") errors.push(JSON.stringify(wire));
      if (wire.routing) assignments.push(...wire.routing.assignments);
    });
  });
  await page.setViewportSize({ width: 1680, height: 1100 });
  await page.goto("/");
  await expect(page.getByText("Detector live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "4× speed", exact: true }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(() => batches.at(-1)?.simulation_time_seconds ?? 0, { timeout: 85_000 }).toBeGreaterThan(24 * 60);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  for (const letter of "ABCDEFGH") await page.getByLabel(`Close Gate ${letter}`, { exact: true }).click();
  await expect.poll(() => batches.at(-1)?.closed_gates.length).toBe(8);
  const closure = batches.at(-1)!;
  expect(closure.agents.some((agent) => agent.phase === "gate_approach")).toBe(true);
  expect(closure.agents.some((agent) => agent.phase === "queue")).toBe(true);
  const outsideAtClosure = new Set([
    ...closure.agents.filter((agent) => agent.phase === "exit").map((agent) => agent.person_id),
    ...closure.exited_agents.map((agent) => agent.person_id),
  ]);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(() => batches.at(-1)?.simulation_time_seconds ?? 0, { timeout: 15_000 }).toBeGreaterThan(closure.simulation_time_seconds + 120);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  for (const batch of batches.filter((item) => item.sequence > closure.sequence)) {
    for (const id of [
      ...batch.agents.filter((agent) => agent.phase === "exit").map((agent) => agent.person_id),
      ...batch.exited_agents.map((agent) => agent.person_id),
    ]) expect(outsideAtClosure.has(id)).toBe(true);
  }
  expect(approvals).toBe(0);
  expect(assignments.every((assignment) => assignment.reason === "gate_closed")).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("closed-boundary-gates.png"), fullPage: true });

  // Keep the busiest closed gate blocked. No evaluation or approval is needed
  // to leave its queue and walk around to the nearest available boundary door.
  const queueCounts = new Map<string, number>();
  for (const agent of closure.agents.filter((agent) => agent.phase === "queue")) queueCounts.set(agent.target_gate, (queueCounts.get(agent.target_gate) ?? 0) + 1);
  const blocked = [...queueCounts].sort((a, b) => b[1] - a[1])[0][0];
  const affected = new Set(batches.at(-1)!.agents.filter((agent) => agent.target_gate === blocked && agent.phase !== "exit").map((agent) => agent.person_id));
  expect(affected.size).toBeGreaterThan(0);
  for (const letter of "ABCDEFGH") if (`gate_${letter.toLowerCase()}` !== blocked) await page.getByLabel(`Open Gate ${letter}`, { exact: true }).click();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(() => batches.at(-1)!.agents.filter((agent) => affected.has(agent.person_id) && agent.target_gate === blocked).length).toBe(0);
  const escapedSequence = batches.at(-1)!.sequence;
  await expect.poll(() => batches.at(-1)!.agents.filter((agent) => affected.has(agent.person_id) && agent.phase === "concourse").length, { timeout: 20_000 }).toBeGreaterThan(0);
  for (const agent of batches.at(-1)!.agents.filter((item) => item.phase === "concourse")) {
    const scale = Math.hypot(agent.x / 12, agent.z / 9);
    expect(scale).toBeGreaterThanOrEqual(1.119);
    expect(scale).toBeLessThanOrEqual(1.201);
  }
  await page.screenshot({ path: testInfo.outputPath("automatic-circular-diversion.png"), fullPage: true });
  await expect.poll(() => batches.at(-1)!.agents.some((agent) => affected.has(agent.person_id) && agent.phase === "exit"), { timeout: 50_000 }).toBe(true);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  for (const batch of batches.filter((item) => item.sequence >= escapedSequence)) {
    for (const agent of batch.agents.filter((item) => affected.has(item.person_id))) {
      expect(agent.target_gate).not.toBe(blocked);
      if (agent.phase !== "exit") expect(Math.hypot(agent.x / 12, agent.z / 9)).toBeLessThan(1.332);
    }
  }
  expect(assignments.every((assignment) => assignment.reason === "gate_closed")).toBe(true);
  expect(approvals).toBe(0);
  expect(errors).toEqual([]);
});
