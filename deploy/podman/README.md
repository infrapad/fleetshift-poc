# Local compose stack

Compose launcher for the all-in-one image (`quay.io/stolostron/fleetshift`)
under `deploy/podman`: podman + docker-compose via Nx (`pd:*` targets). One container runs the TLS edge, API, baked-in
UI, and peer Dex.

This is **not** a multi-service Keycloak/Postgres harness. Packaging internals
and a raw `podman run` are documented in
[deploy/aio/README.md](../aio/README.md). Both paths use the same AIO image and
the same public origin:

```text
https://fleetshift-sandbox.localhost:8085
```

That URL redirects to `/app`. Accept the browser certificate warning (unknown
sandbox CA). Dex is same-origin under `/idp`. Port `5556` is not published.
gRPC remains on `127.0.0.1:50051` (plaintext; known gap).

## Prerequisites

- **podman** — container runtime
- **docker-compose** — `podman-compose` is not supported
- **kind** — for local cluster provisioning
- `.env` file — copy from `.env.template`

Create the kind network once: `podman network create kind`. Linux rootless:
`systemctl --user enable --now podman.socket` and
`export PODMAN_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock`.

## Quick Start

```bash
cp .env.template .env         # leave OIDC_ISSUER_URL unset for peer Dex
  npx nx run cli:build          # build fleetctl Go binaries
  npx nx run pd:dev             # build AIO from source and start
```

Open https://fleetshift-sandbox.localhost:8085 and accept the certificate
warning. Demo users (login is the email): `ops@fleetshift.local` /
`fleetshift-ops` and `dev@fleetshift.local` / `fleetshift-dev`.

If the **demo** `/data` was persisted from a pre-HTTPS AIO run, the AuthMethod issuer is
still `https://127.0.0.1:5556/dex`. Reset that demo volume once (this is destructive):

```bash
 npx nx run pd:clean
 npx nx run pd:dev
```

`start.mjs` copies the sandbox CA to `deploy/podman/.certs/ca.crt` for fleetctl.
Do not install that CA into the host or browser trust store.

```bash
bin/fleetctl auth setup \
  --issuer-url https://fleetshift-sandbox.localhost:8085/idp \
  --client-id fleetshift-cli \
  --key-enrollment-client-id fleetshift-signing \
  --oidc-ca-file deploy/podman/.certs/ca.crt \
  --scopes 'openid,profile,email,audience:server:client_id:fleetshift'
bin/fleetctl auth login
```

### OpenShift-backed Dex with `pd:dev`

This mode uses the **same public Dex issuer** but a **separate named `/data`
volume**, leaving the demo volume and its AuthMethods intact. It is opt-in:

```bash
# Select the intended host oc context before first launch.
oc config current-context
# Add OPENSHIFT_DEX_MODE=openshift to the repo-root .env (leave OIDC_ISSUER_URL unset).
npx nx run pd:dev
```

Alternatively pass `OPENSHIFT_DEX_MODE=openshift` as an Nx key-value argument:
`npx nx run pd:dev OPENSHIFT_DEX_MODE=openshift`. On first launch, if the
connector directory is **absent or empty**, `pd:dev` (or `pd:up`) runs the
host-side bootstrap before building/starting AIO. This registers a dedicated
Dex OAuth service-account client in the **current `oc` context's namespace**.
Verify that context first: bootstrap changes cluster resources. It never
copies a kubeconfig into AIO. It writes ignored, private files under
`deploy/aio/.local/openshift-dex/`; subsequent starts reuse them without
running `oc` again. A partially populated or permissive directory fails
closed instead of being silently overwritten. To reconcile/rotate the client
explicitly, run `npx nx run pd:bootstrap-openshift-dex`.

The Compose overlay mounts this directory **read-only** and swaps `/data` to
`fleetshift-openshift-data`; it does not copy credentials into `.env`. If you
used a custom bootstrap `--output-dir`, set `OPENSHIFT_DEX_HOST_DIR` to its
**absolute host path** in `.env` or as a key-value argument. For API or OAuth
route CA errors, run the bootstrap script explicitly with
`--api-ca-file` / `--oauth-ca-file` as documented in
[deploy/aio/README.md](../aio/README.md), then retry `pd:dev`.

`pd:down` preserves **both** volumes. To return to demo login, remove
`OPENSHIFT_DEX_MODE` from `.env` (or stop passing it), then `npx nx run pd:dev`;
use a fresh browser session to avoid an old login session. **Do not run
`pd:clean` to switch modes**: it deletes data. `pd:clean` refuses to run in
OpenShift mode because Compose's `down -v` would also delete the declared demo
volume. If you intentionally want to reset one mode, remove *only its* volume
manually after `pd:down`.

Open https://fleetshift-sandbox.localhost:8085, accept the sandbox certificate
warning, and sign in with your cluster user. The OpenShift connector client
provides **Dex-issued** FleetShift tokens, not OpenShift user bearers for
InfraPad or Thanos. The `fleetctl` setup above remains the same (the stack
copies the current volume's sandbox CA to `.certs/ca.crt`).

Point at an external issuer by setting `OIDC_ISSUER_URL` in `.env` (peer Dex
then parks; leave `OPENSHIFT_DEX_MODE` unset). Register
`https://fleetshift-sandbox.localhost:8085`, `/app/auth/callback`, and
`/app/silent-renew.html` on that IdP.

AIO enables `gcphcp` from `GCPHCP_GATEWAY_URL` alone. Set it in `.env` when
needed. Do not commit a concrete CLS gateway URL.

## Tasks

All local deployment commands use Nx `pd:*` targets.

| Task | Description |
|------|-------------|
| `podman:up` | Start the AIO stack (prebuilt image) |
| `pd:dev` | Build the AIO image from source, then up (also supports opt-in OpenShift-backed Dex) |
| `pd:bootstrap-openshift-dex` | Explicitly reconcile/rotate Dex's OpenShift OAuth client using the host `oc` context (first launch also bootstraps if files are absent) |
| `podman:down` | Stop containers, preserve data |
| `pd:clean` | Stop + delete demo volume and `.certs` (refuses while OpenShift mode selected) |
| `podman:rebuild` | Stop, rebuild the AIO image, restart |
| `podman:build` | Build the AIO image without restarting |
| `podman:pull` | Pull the latest all-in-one image |
| `podman:logs` | Follow logs from all containers |
| `podman:logs:<service>` | Tail specific service (e.g. `podman:logs:fleetshift-server`) |
| `podman:status` | Show running containers |
| `podman:restart:<service>` | Restart a specific container |
| `podman:rebuild-web` | Rebuild the AIO image (baked UI) and restart |

## Full Stack Dev Mode

`npx nx run pd:dev` builds the AIO image from this repo (`npx nx run image:aio`) and
starts it. After changing Go or UI sources that are baked into the image, run
`npx nx run pd:rebuild`.

### Local Web Watch Mode

For faster frontend iteration, bind-mount host `web/` over the baked UI:

```bash
# Terminal 1 — start the stack with local web assets
npx nx run pd:dev LOCAL_WEB=true

# Terminal 2 — watch & rebuild merged UI assets into monorepo-root web/
npx nx run web:dev
```

Open https://fleetshift-sandbox.localhost:8085 and refresh after rebuilds.

## Configuration

Copy `.env.template` to `.env` and edit. Command-line variables always override
`.env`. This stack uses AIO `OIDC_*` names; Kubernetes uses different ones —
see [deploy/aio/README.md](../aio/README.md) and
[deploy/kubernetes/README.md](../kubernetes/README.md).

Leave `OIDC_UI_SCOPE` unset. Packaging picks Dex-on vs Dex-off from whether
`OIDC_ISSUER_URL` is set, with optional OpenShift-backed peer Dex as above.
Setting the portable scope on Dex-on drops
`aud=fleetshift` from access tokens.
