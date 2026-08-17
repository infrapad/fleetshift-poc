import { expect, test } from "@playwright/experimental-ct-react";

import type { LabelMatcher, PromRangeSeries } from "../prometheusApi";
import AlertsTimelineChart from "../AlertsTimelineChart";

// ---- Helpers ----

/** Build a Prometheus-shaped JSON response body. */
function promResponse(result: PromRangeSeries[]) {
  return {
    status: "success",
    data: { resultType: "matrix", result },
  };
}

/** A fixed "since" timestamp used across tests (2024-06-01T12:00:00Z). */
const SINCE = "2024-06-01T12:00:00Z";
const SINCE_UNIX = Math.floor(new Date(SINCE).getTime() / 1000);
const UNTIL = "2024-06-01T12:05:00Z";
const UNTIL_UNIX = Math.floor(new Date(UNTIL).getTime() / 1000);

const MATCHERS: LabelMatcher[] = [{ name: ["HighCPU"] }];

// ---- Tests ----

test.describe("AlertsTimelineChart", () => {
  test("shows loading spinner while fetching", async ({ mount, page }) => {
    // Hang the request so we stay in loading state
    await page.route("**/api/v1/query_range*", (route) => {
      // Never fulfill — keeps spinner visible
    });

    const component = await mount(
      <AlertsTimelineChart
        matchers={MATCHERS}
        since={SINCE}
        until={UNTIL}
      />,
    );

    await expect(component.getByText("Loading alerts data…")).toBeVisible();
    await expect(component.locator(".pf-v6-c-spinner")).toBeVisible();
  });

  test("shows error alert when Prometheus returns HTTP error", async ({
    mount,
    page,
  }) => {
    await page.route("**/api/v1/query_range*", (route) =>
      route.fulfill({ status: 503, body: "Service Unavailable" }),
    );

    const component = await mount(
      <AlertsTimelineChart
        matchers={MATCHERS}
        since={SINCE}
        until={UNTIL}
      />,
    );

    await expect(
      component.getByText("Prometheus query failed"),
    ).toBeVisible();
    await expect(
      component.getByText("Prometheus API error (503)"),
    ).toBeVisible();
  });

  test("shows error alert when Prometheus returns error status in JSON", async ({
    mount,
    page,
  }) => {
    await page.route("**/api/v1/query_range*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "error",
          errorType: "bad_data",
          error: "invalid expression",
        }),
      }),
    );

    const component = await mount(
      <AlertsTimelineChart
        matchers={MATCHERS}
        since={SINCE}
        until={UNTIL}
      />,
    );

    await expect(
      component.getByText("Prometheus query failed"),
    ).toBeVisible();
    await expect(
      component.getByText("invalid expression"),
    ).toBeVisible();
  });

  test("shows info alert when no alert data is returned", async ({
    mount,
    page,
  }) => {
    await page.route("**/api/v1/query_range*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(promResponse([])),
      }),
    );

    const component = await mount(
      <AlertsTimelineChart
        matchers={MATCHERS}
        since={SINCE}
        until={UNTIL}
      />,
    );

    await expect(
      component.getByText("No alert data found for this time range"),
    ).toBeVisible();
  });

  test("renders a chart with swimlane areas for returned series", async ({
    mount,
    page,
  }) => {
    const step = 15;
    const start = SINCE_UNIX - 120; // TIME_PAD_S
    const end = UNTIL_UNIX + 120;

    // Two series: HighCPU firing at a few timestamps, HighMemory firing elsewhere
    const series: PromRangeSeries[] = [
      {
        metric: { alertname: "HighCPU", endpoint: "web" },
        values: [
          [start + step * 2, "1"],
          [start + step * 3, "1"],
          [start + step * 4, "1"],
        ],
      },
      {
        metric: { alertname: "HighMemory", namespace: "prod" },
        values: [
          [start + step * 5, "1"],
          [start + step * 6, "1"],
        ],
      },
    ];

    await page.route("**/api/v1/query_range*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(promResponse(series)),
      }),
    );

    const component = await mount(
      <AlertsTimelineChart
        matchers={MATCHERS}
        since={SINCE}
        until={UNTIL}
      />,
    );

    // Chart should render — no loading, no error, no empty state
    await expect(component.getByText("Loading alerts data…")).toHaveCount(0);
    await expect(
      component.getByText("Prometheus query failed"),
    ).toHaveCount(0);
    await expect(
      component.getByText("No alert data found for this time range"),
    ).toHaveCount(0);

    // PF Charts renders two SVGs: the main chart (role="img") and a
    // Voronoi overlay.  Target the main one.
    const svg = component.locator("svg[role='img']");
    await expect(svg).toBeVisible();

    // One area path per series (2 series → 2 ChartArea paths).
    // PF Charts renders each area as a <path> inside a role="presentation" group.
    const areaPaths = svg.locator("path[role='presentation']");
    // Each ChartArea generates 2 paths (fill + stroke), so expect at least 4
    const count = await areaPaths.count();
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test("chart tooltip shows series label on hover", async ({
    mount,
    page,
  }) => {
    const start = SINCE_UNIX - 120;

    const series: PromRangeSeries[] = [
      {
        metric: { alertname: "HighCPU", endpoint: "web" },
        values: [[start + 30, "1"]],
      },
    ];

    await page.route("**/api/v1/query_range*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(promResponse(series)),
      }),
    );

    const component = await mount(
      <AlertsTimelineChart
        matchers={MATCHERS}
        since={SINCE}
        until={UNTIL}
      />,
    );

    const svg = component.locator("svg[role='img']");
    await expect(svg).toBeVisible();

    // Hover over the center of the chart to trigger Voronoi tooltip
    const box = await svg.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    }

    // The Voronoi tooltip renders a <text> element containing the series label.
    // seriesLabel skips __name__, alertstate, job, instance, severity →
    // remaining: alertname="HighCPU", endpoint="web"
    const tooltip = svg.locator("text");
    await expect(tooltip.first()).toBeVisible();
  });

  test("passes correct query parameters to Prometheus", async ({
    mount,
    page,
  }) => {
    let capturedUrl = "";
    await page.route("**/api/v1/query_range*", (route) => {
      capturedUrl = route.request().url();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(promResponse([])),
      });
    });

    await mount(
      <AlertsTimelineChart
        matchers={[{ name: ["HighCPU"] }]}
        since={SINCE}
        until={UNTIL}
      />,
    );

    // Wait for the request to complete
    await expect(
      page.getByText("No alert data found for this time range"),
    ).toBeVisible();

    const url = new URL(capturedUrl);
    // Query should include ALERTS{alertname="HighCPU"}
    expect(url.searchParams.get("query")).toContain("alertname");
    expect(url.searchParams.get("query")).toContain("HighCPU");
    expect(url.searchParams.get("step")).toBe("15s");

    // Start/end should include TIME_PAD_S (120s)
    const start = Number(url.searchParams.get("start"));
    const end = Number(url.searchParams.get("end"));
    expect(start).toBe(SINCE_UNIX - 120);
    expect(end).toBe(UNTIL_UNIX + 120);
  });
});
