import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/experimental-ct-react";

import { AdapterHarness } from "./adapterHarness";

test("OpenShift popup supplies a user bearer to InfraPad, not the Dex token", async ({
  mount,
  page,
}) => {
  await page.route("**/api/ui/config", (route) =>
    route.fulfill({
      json: {
        externalConfig: {
          infrapad: { origin: "https://localhost:8089" },
          openshiftOAuth: {
            authorizeUrl: "https://oauth.example.test/oauth/authorize",
            clientId: "fleetshift-infrapad",
            scope: "user:full",
          },
        },
      },
    }),
  );
  const bearers: string[] = [];
  await page.route("https://localhost:8089/ui/config", (route) => {
    bearers.push(route.request().headers().authorization ?? "");
    return route.fulfill({
      json: {
        services: {
          infrapadApiBaseUrl: "https://localhost:8089/v1",
          prometheusApiBaseUrl: "https://localhost:8089/metrics",
        },
      },
    });
  });
  await page.route("https://localhost:8089/v1/**", (route) => {
    bearers.push(route.request().headers().authorization ?? "");
    return route.fulfill({ json: { documents: [] } });
  });
  await page
    .context()
    .route("https://oauth.example.test/oauth/authorize**", (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get("response_type")).toBe("token");
      expect(url.searchParams.get("scope")).toBe("user:full");
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.hash = new URLSearchParams({
        access_token: "openshift-user-token",
        expires_in: "3600",
        state: url.searchParams.get("state")!,
      }).toString();
      return route.fulfill({
        contentType: "text/html",
        body: `<script>location.replace(${JSON.stringify(callback.href)})</script>`,
      });
    });
  await page.context().route("**/app/openshift-callback.html", async (route) =>
    route.fulfill({
      contentType: "text/html",
      body: await readFile(
        new URL(
          "../../../../../../../client/web/src/openshift-callback.html",
          import.meta.url,
        ),
        "utf8",
      ),
    }),
  );
  await mount(<AdapterHarness token="dex-token" />);
  await expect(
    page.getByRole("button", { name: "Connect to OpenShift" }),
  ).toBeVisible();
  expect(bearers).toEqual([]);
  await page.getByRole("button", { name: "Connect to OpenShift" }).click();
  await expect.poll(() => bearers.length).toBeGreaterThan(0);
  expect(
    bearers.every((value) => value === "Bearer openshift-user-token"),
  ).toBe(true);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("fleetshift:openshift-oauth"),
    ),
  ).toContain("openshift-user-token");
});

test("opaque proxy redirect offers a fresh OpenShift connection instead of retrying a stale bearer", async ({
  mount,
  page,
}) => {
  const oauth = {
    authorizeUrl: "https://oauth.example.test/oauth/authorize",
    clientId: "fleetshift-infrapad",
    scope: "user:full",
  };
  await page.route("**/api/ui/config", (route) =>
    route.fulfill({
      json: {
        externalConfig: {
          infrapad: { origin: "https://localhost:8089" },
          openshiftOAuth: oauth,
        },
      },
    }),
  );
  const configBearers: string[] = [];
  await page.route("https://localhost:8089/ui/config", (route) => {
    configBearers.push(route.request().headers().authorization ?? "");
    if (configBearers.length === 1)
      return route.fulfill({
        status: 302,
        headers: { Location: "https://oauth.example.test/login" },
      });
    return route.fulfill({
      json: {
        services: {
          infrapadApiBaseUrl: "https://localhost:8089/v1",
          prometheusApiBaseUrl: "https://localhost:8089/metrics",
        },
      },
    });
  });
  await page.route("https://localhost:8089/v1/**", (route) =>
    route.fulfill({ json: { documents: [] } }),
  );
  let authorizations = 0;
  await page
    .context()
    .route("https://oauth.example.test/oauth/authorize**", (route) => {
      const url = new URL(route.request().url());
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.hash = new URLSearchParams({
        access_token:
          ++authorizations === 1 ? "stale-user-token" : "fresh-user-token",
        expires_in: "3600",
        state: url.searchParams.get("state")!,
      }).toString();
      return route.fulfill({
        contentType: "text/html",
        body: `<script>location.replace(${JSON.stringify(callback.href)})</script>`,
      });
    });
  await page.context().route("**/app/openshift-callback.html", async (route) =>
    route.fulfill({
      contentType: "text/html",
      body: await readFile(
        new URL(
          "../../../../../../../client/web/src/openshift-callback.html",
          import.meta.url,
        ),
        "utf8",
      ),
    }),
  );
  await mount(<AdapterHarness token="dex-token" />);
  await expect(
    page.getByRole("button", { name: "Connect to OpenShift" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Connect to OpenShift" }).click();
  await expect(
    page.getByText(/InfraPad could not complete the authenticated request/),
  ).toBeVisible();
  expect(configBearers).toEqual(["Bearer stale-user-token"]);
  await page.getByRole("button", { name: "Connect to OpenShift" }).click();
  await expect.poll(() => configBearers.length).toBe(2);
  expect(configBearers).toEqual([
    "Bearer stale-user-token",
    "Bearer fresh-user-token",
  ]);
});

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
