# Web e2e tests

Playwright journeys against the packaged AIO image (HTTPS origin
`https://fleetshift-sandbox.localhost:8085`, SPA under `/app`). How to add
UI or CLI e2e tests, and how CI runs them:
[docs/testing/end-to-end.md](../../docs/testing/end-to-end.md).

The Nx target uses the shared sandbox runner, which builds the AIO image before
startup and owns diagnostics and cleanup. CI (`e2e.yml`) sets
`FLEETSHIFT_E2E_AIO_PREBUILT=1` after restoring a **this-checkout** image; a
failure there is a problem with the current branch.

`e2e-published.yml` sets `FLEETSHIFT_E2E_AIO_PULL=1` and pulls
`quay.io/stolostron/fleetshift:latest`. That job is a **sanity** of the
**already published** Quay AIO (start, Dex login, masthead/Clusters), not a
re-run of the full UI suite and not the image from current changes. Playwright
project `chromium-sanity` only; no Kind journey. A failure does not indicate a
bug in the current branch. It indicates the live published image failed basic
function and end users are affected; investigate immediately (confirm
`podman run` of `:latest`, OpenShift CI mirror/republish, restore a working
tag). Set `FLEETSHIFT_E2E_KEEP=1` to retain the sandbox after a local run.

```bash
npx nx test:e2e e2e-web
npx nx test:e2e e2e-web -- --ui
npx nx test:e2e e2e-web -- --project=chromium
FLEETSHIFT_E2E_AIO_PULL=1 npx nx test:e2e e2e-web -- --project=chromium-sanity
```

The runner sets `BASE_URL` to the branded HTTPS origin. Playwright uses
`ignoreHTTPSErrors` for the sandbox private CA; do not `update-ca-trust` on
the host. CI asserts Dex port 5556 is not published.

## Local InfraPad adapter journey (opt-in)

Build `../infrapad/ui`'s `@infrapad/ui` (`cd ../infrapad/ui && npm run build
--workspace @infrapad/ui`), then install/refresh FleetShift's local file
package (`npm install --workspace @fleetshift/mock-ui-plugins` from the FleetShift
root). npm may copy `dist` instead of symlinking it, so reinstall after a
sibling rebuild if needed. Build FleetShift's plugin with `npx nx run
plugins:build` when no web watch is running; do not run `web:build` against a
live watch setup.

Start FleetShift's authenticated HTTPS sandbox with `EXTERNAL_UI_CONFIG` set to
`{"infrapad":{"origin":"http://localhost:8089"}}` and ensure the *updated*
InfraPad dummy-auth proxy has been **rebuilt/restarted** on its normal port
8089 with Go and its database running. Verify the origin appears on
`/api/ui/config` and `/ui/config` is accessible on that origin. From the
FleetShift root, run:

```sh
FLEETSHIFT_INFRAPAD_E2E=1 npx nx run e2e-web:test:ct -- tests/infrapad-adapter.spec.ts --project=chromium
```

This inferred Playwright target uses the **already running** sandbox (including
its authenticated setup) rather than rebuilding the AIO image, which would
disrupt a live web watch. If using another browser-facing InfraPad origin, set
`FLEETSHIFT_INFRAPAD_ORIGIN` to the same value. The test is skipped without
`FLEETSHIFT_INFRAPAD_E2E`; normal CI needs neither checkout nor local proxy.
The journey checks browser-readable `/ui/config` and one real `/v1` bearer
request, then stubs documents and Prometheus for deterministic rendering. The
dummy proxy **does not verify** the bearer signature, and this test does not
prove API authorization or Prometheus authentication. Production TLS/CORS and
authenticated Prometheus hosting remain separate deployment work.

