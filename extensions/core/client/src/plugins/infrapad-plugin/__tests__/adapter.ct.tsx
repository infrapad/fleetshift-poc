import { expect, test } from "@playwright/experimental-ct-react";

import { AdapterHarness } from "./adapterHarness";

test("absent origin is explicitly not configured", async ({ mount, page }) => {
  await page.route("**/api/ui/config", (route) =>
    route.fulfill({ json: { externalConfig: {} } }),
  );
  await mount(<AdapterHarness token="test-token" />);
  await expect(page.getByText("InfraPad is not configured")).toBeVisible();
});

test("malformed and unavailable configuration can be retried", async ({
  mount,
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/ui/config", (route) => {
    attempts++;
    return route.fulfill(
      attempts === 1
        ? {
            json: {
              externalConfig: {
                infrapad: { origin: "https://bad.example/path" },
              },
            },
          }
        : {
            json: {
              externalConfig: { infrapad: { origin: "http://localhost:8089" } },
            },
          },
    );
  });
  await page.route("http://localhost:8089/ui/config", (route) =>
    route.fulfill({ status: 503 }),
  );
  await mount(<AdapterHarness token="test-token" />);
  await expect(
    page.getByText("Invalid InfraPad origin in FleetShift configuration"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry configuration" }).click();
  await expect(
    page.getByText("InfraPad configuration unavailable (503)"),
  ).toBeVisible();
  expect(attempts).toBe(2);
});

test("malformed service URLs never mount the shared UI", async ({
  mount,
  page,
}) => {
  await page.route("**/api/ui/config", (route) =>
    route.fulfill({
      json: {
        externalConfig: { infrapad: { origin: "http://localhost:8089" } },
      },
    }),
  );
  await page.route("http://localhost:8089/ui/config", (route) =>
    route.fulfill({
      json: {
        services: {
          infrapadApiBaseUrl: "/v1",
          prometheusApiBaseUrl: "javascript:alert(1)",
        },
      },
    }),
  );
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/v1/")) apiRequests.push(request.url());
  });
  await mount(<AdapterHarness token="test-token" />);
  await expect(
    page.getByText("Invalid InfraPad service URL in /ui/config"),
  ).toBeVisible();
  expect(apiRequests).toEqual([]);
});

test("without a token no InfraPad requests are sent", async ({
  mount,
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/ui/config") || request.url().includes("/v1/"))
      requests.push(request.url());
  });
  await mount(<AdapterHarness />);
  await expect(page.getByText("FleetShift login required")).toBeVisible();
  expect(requests).toEqual([]);
});
