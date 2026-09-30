import { expect, test } from "./fixtures";

// Local-only: requires the sibling package, the rebuilt port-8089 dummy proxy,
// and FleetShift EXTERNAL_UI_CONFIG with the browser-facing InfraPad origin.
// Not part of ordinary CI: the sibling checkout and proxy are not provisioned there.
// eslint-disable-next-line playwright/no-skipped-test
test.skip(
  !process.env.FLEETSHIFT_INFRAPAD_E2E,
  "Requires a running local InfraPad proxy",
);
test.use({ storageState: ".auth/ops.json" });

test("FleetShift navigation, real proxy bearer/CORS, and shared document/chart routes", async ({
  page,
}) => {
  const origin =
    // eslint-disable-next-line playwright/no-conditional-in-test
    process.env.FLEETSHIFT_INFRAPAD_ORIGIN ?? "http://localhost:8089";
  const fleetConfig = await page.request.get("/api/ui/config");
  expect((await fleetConfig.json()).externalConfig?.infrapad?.origin).toBe(
    origin,
  );

  // Browser network request, not Playwright's APIRequestContext: preflight and
  // cross-origin response readability must work for the actual authenticated page.
  const proxyConfig = page.waitForRequest(`${origin}/ui/config`);
  await page.goto("/app/");
  await page.getByRole("link", { name: "Infrapad" }).click();
  const configRequest = await proxyConfig;
  const bearer = configRequest.headers()["authorization"];
  expect(bearer).toMatch(/^Bearer .+/);
  const configResponse = await configRequest.response();
  expect(configResponse?.ok()).toBe(true);
  expect((await configResponse!.json()).services.infrapadApiBaseUrl).toBe(
    "/v1",
  );

  // Before installing any document stubs, send one genuine /v1 request via
  // the normal dummy proxy. A 200 response is readable by the browser (CORS).
  const probe = await page.evaluate(
    async ({ origin, bearer }) => {
      const response = await fetch(`${origin}/v1/documents`, {
        headers: { Authorization: bearer },
      });
      return { status: response.status, body: await response.json() };
    },
    { origin, bearer: bearer! },
  );
  expect(probe.status).toBe(200);
  expect(probe.body).toBeTruthy();
  // The proxy extracts a username; it does not verify the JWT signature.

  const apiRequests: string[] = [];
  await page.route(`${origin}/v1/documents*`, (route) => {
    apiRequests.push(route.request().headers()["authorization"]);
    return route.fulfill({
      json: {
        documents: [
          {
            name: "documents/adapter-journey",
            title: "Adapter journey",
            status: "active",
            blocks: [],
          },
        ],
      },
    });
  });
  await page.route(`${origin}/v1/documents/adapter-journey`, (route) => {
    apiRequests.push(route.request().headers()["authorization"]);
    return route.fulfill({
      json: {
        document: {
          name: "documents/adapter-journey",
          title: "Adapter journey",
          status: "active",
          blocks: [
            {
              blockNumber: 1,
              revisionNumber: 1,
              name: "alerts",
              type: "alerts_matcher",
              content: {
                LabelsMatchers: [{ name: ["AdapterAlert"] }],
                Since: "2026-01-01T00:00:00Z",
              },
            },
          ],
        },
      },
    });
  });
  let chartBearer: string | undefined;
  await page.route("**/api/v1/query_range?**", (route) => {
    chartBearer = route.request().headers()["authorization"];
    return route.fulfill({
      json: { status: "success", data: { resultType: "matrix", result: [] } },
    });
  });
  // Reload the index after installing stubs; the first visit may have fetched
  // genuine data, but the probe above was never intercepted.
  await page.reload();
  await page.getByRole("link", { name: "Adapter journey" }).click();
  await expect(
    page.getByRole("heading", { name: "Adapter journey" }),
  ).toBeVisible();
  await expect.poll(() => chartBearer).toBe(bearer);
  expect(apiRequests).toEqual([bearer, bearer]);
});
