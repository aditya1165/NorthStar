import { expect, test } from "@playwright/test";

const snapshot = {
  elapsed_minutes: 4,
  status: "running",
  incidents: { gate_b_closed: true, metro_delayed: true },
  active_intervention: null,
  zones: [
    {
      zone_id: "north_concourse",
      name: "North Concourse",
      people_count: 960,
      density_estimate: 3.1,
      inflow_per_min: 195,
      outflow_per_min: 76,
      mean_speed_mps: 0.78,
      queue_length: 360,
      opposing_flow_ratio: 0.31,
      risk_level: "high",
      status: "open",
    },
  ],
};

test("shows the operator decision flow", async ({ page }) => {
  await page.route("**/api/state", (route) => route.fulfill({ json: snapshot }));
  await page.route("**/api/forecasts", (route) =>
    route.fulfill({
      json: [
        {
          zone_id: "north_concourse",
          horizon_minutes: 10,
          predicted_density: 5.1,
          predicted_queue_length: 720,
          risk_probability: 0.88,
          time_to_congestion_minutes: 2.4,
          confidence_interval: [4.5, 5.7],
          top_factors: ["inflow exceeds outflow", "Gate B unavailable"],
        },
      ],
    }),
  );
  await page.route("**/api/interventions", (route) =>
    route.fulfill({
      json: [
        {
          intervention_id: "combined-action",
          name: "Open Gate C and redirect sections",
          actions: ["open_gate_c", "redirect_sections_204_206"],
          feasible: true,
          recommended: true,
          rollouts: 5,
          peak_density: 3.2,
          clearance_time_minutes: 23.4,
          people_redirected: 960,
          extra_walk_meters_mean: 74,
          accessibility_violations: 0,
          risk_reduction_percent: 41,
          operational_complexity: 4,
          explanation: "Best safety-disruption trade-off.",
        },
      ],
    }),
  );
  await page.goto("/?mode=live");
  await expect(page.getByText("CrowdGuardian")).toBeVisible();
  await expect(page.getByText("Recommendation ready")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve action" })).toBeEnabled();
});

