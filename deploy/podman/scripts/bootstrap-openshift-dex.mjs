#!/usr/bin/env node
// Register separate Dex and public embedded-UI OAuth clients using the host's
// current oc context. Only the Dex client's secret and CA are mounted into AIO.
import { $, sleep } from "zx";
import { open, mkdir, chmod, readFile, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import tls from "node:tls";

const callback = "https://fleetshift-sandbox.localhost:8085/idp/callback";
const mount = "/run/fleetshift/openshift-dex";
const name = "fleetshift-dex";
const userClient = "fleetshift-infrapad";
const userCallback =
  "https://fleetshift-sandbox.localhost:8085/app/openshift-callback.html";
const defaultDir = fileURLToPath(
  // Retain the existing private output directory so previously bootstrapped
  // clients keep working with the AIO read-only mount.
  new URL("../../aio/.local/openshift-dex/", import.meta.url),
);

export class BootstrapError extends Error {}

export function embeddedOAuthClient() {
  return {
    apiVersion: "oauth.openshift.io/v1",
    kind: "OAuthClient",
    metadata: { name: userClient },
    grantMethod: "auto",
    redirectURIs: [userCallback],
    scopeRestrictions: [{ literals: ["user:full"] }],
  };
}

// Never echo raw oc output or a zx command (which could contain credentials).
async function oc(...args) {
  const verb = args[0] === "-n" ? args[2] : args[0];
  const result = await $({ quiet: true })`oc ${args}`.nothrow();
  if (!result.ok)
    throw new BootstrapError(
      `oc ${verb} failed; check the current context and namespace permissions`,
    );
  return result.stdout;
}

async function ocJSON(...args) {
  return JSON.parse(await oc(...args));
}

async function applyResource(secret) {
  // Input goes to stdin, never through argv, logs, or a shell temporary file.
  const result = await $({
    quiet: true,
    input: JSON.stringify(secret),
  })`oc apply -f -`.nothrow();
  if (!result.ok)
    throw new BootstrapError(
      "oc apply failed; check cluster permissions and existing resources",
    );
}

export async function writePrivate(path, content) {
  const temp = `${path}.tmp`;
  const file = await open(temp, "w", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(content);
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export function httpsOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BootstrapError("cluster API server must be an HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new BootstrapError("cluster API server must be an HTTPS origin");
  }
  return url.origin;
}

export async function loadClusterCA(cluster, apiCAFile, getConfigmap = ocJSON) {
  if (apiCAFile) return readFile(apiCAFile);
  if (cluster["certificate-authority-data"])
    return Buffer.from(cluster["certificate-authority-data"], "base64");
  if (cluster["certificate-authority"])
    return readFile(cluster["certificate-authority"]);
  // Match InfraPad's bootstrap: public cluster CA from the cluster when the
  // kubeconfig has none (including insecure-skip-tls-verify contexts).
  try {
    const cm = await getConfigmap(
      "-n",
      "kube-system",
      "get",
      "configmap",
      "kube-root-ca.crt",
      "-o",
      "json",
    );
    if (typeof cm.data?.["ca.crt"] !== "string" || !cm.data["ca.crt"])
      throw new Error("empty CA");
    return Buffer.from(cm.data["ca.crt"], "utf8");
  } catch {
    throw new BootstrapError(
      "cannot obtain cluster CA from kube-system/kube-root-ca.crt; use --api-ca-file",
    );
  }
}

function options(argv) {
  const values = { outputDir: defaultDir, apiCAFile: null, oauthCAFile: null };
  const flags = {
    "--output-dir": "outputDir",
    "--api-ca-file": "apiCAFile",
    "--oauth-ca-file": "oauthCAFile",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(
        `Usage: node deploy/podman/scripts/bootstrap-openshift-dex.mjs [--output-dir DIR] [--api-ca-file PEM] [--oauth-ca-file PEM]\nUses the current oc context; writes private Dex OAuth credentials under deploy/aio/.local/openshift-dex/.`,
      );
      return null;
    }
    const key = flags[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith("--"))
      throw new BootstrapError("invalid bootstrap option; use --help");
    values[key] = argv[++i];
  }
  return values;
}

function caBundle(pem) {
  // Supplying `ca` to Node overrides its default roots. Preserve the system
  // roots so public OAuth routes work alongside the selected cluster CA.
  return [
    ...(tls.getCACertificates?.("default") ?? tls.rootCertificates),
    pem.toString("utf8"),
  ];
}

async function discovery(api, ca) {
  return new Promise((resolveResult, reject) => {
    const req = https.get(
      `${api}/.well-known/oauth-authorization-server`,
      { ca, timeout: 10_000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("discovery HTTP status"));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (part) => {
          body += part;
          if (body.length > 1_000_000)
            req.destroy(new Error("discovery too large"));
        });
        res.on("end", () => {
          try {
            resolveResult(JSON.parse(body));
          } catch {
            reject(new Error("invalid discovery JSON"));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("discovery timed out")));
    req.on("error", reject);
  });
}

async function verifyOAuthEndpoint(value, key, ca) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new BootstrapError(`invalid OpenShift ${key}`);
  }
  if (
    endpoint.protocol !== "https:" ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new BootstrapError(`invalid OpenShift ${key}`);
  }
  try {
    await new Promise((resolveResult, reject) => {
      const socket = tls.connect({
        host: endpoint.hostname,
        port: Number(endpoint.port || 443),
        servername: endpoint.hostname,
        ca,
        rejectUnauthorized: true,
      });
      socket.setTimeout(10_000, () => socket.destroy(new Error("timeout")));
      socket.once("secureConnect", () => {
        socket.end();
        resolveResult();
      });
      socket.once("error", reject);
    });
  } catch {
    throw new BootstrapError(
      `OpenShift ${key} TLS failed; check OAuth route reachability and --oauth-ca-file`,
    );
  }
}

export async function bootstrapOpenShiftDex({
  outputDir = defaultDir,
  apiCAFile = null,
  oauthCAFile = null,
} = {}) {
  const cfg = await ocJSON("config", "view", "--raw", "--minify", "-o", "json");
  const cluster = cfg.clusters[0].cluster;
  const namespace = cfg.contexts[0].context.namespace || "default";
  const api = httpsOrigin(cluster.server);
  let ca = await loadClusterCA(cluster, apiCAFile);
  if (cluster["insecure-skip-tls-verify"]) {
    console.error(
      "Note: host oc context skips TLS verification; Dex and bootstrap discovery verify the CA, but oc calls still inherit that insecure setting. Verify the CA independently for stronger trust.",
    );
  }
  if (oauthCAFile)
    ca = Buffer.concat([ca, Buffer.from("\n"), await readFile(oauthCAFile)]);
  const trust = caBundle(ca);
  let metadata;
  try {
    metadata = await discovery(api, trust);
  } catch {
    throw new BootstrapError(
      "OpenShift OAuth discovery failed over verified TLS; check API CA, network and proxy",
    );
  }
  for (const key of ["authorization_endpoint", "token_endpoint"]) {
    await verifyOAuthEndpoint(metadata[key], key, trust);
  }
  const authorizeUrl = metadata.authorization_endpoint;
  const authorize = new URL(authorizeUrl);
  if (authorize.hash || authorize.search)
    throw new BootstrapError("invalid OpenShift authorization_endpoint");

  // Public, secretless client: this token is for the signed-in user, not Dex.
  // Never register the Dex SA token as a browser credential.
  await applyResource(embeddedOAuthClient());
  const publicClient = await ocJSON(
    "get",
    "oauthclient",
    userClient,
    "-o",
    "json",
  );
  if (
    publicClient.secret ||
    publicClient.grantMethod !== "auto" ||
    JSON.stringify(publicClient.redirectURIs) !==
      JSON.stringify([userCallback]) ||
    JSON.stringify(publicClient.scopeRestrictions) !==
      JSON.stringify([{ literals: ["user:full"] }])
  )
    throw new BootstrapError(
      "embedded OAuthClient policy differs from the public single-callback client; remove the conflicting client before retrying",
    );

  let sa;
  try {
    sa = await ocJSON("-n", namespace, "get", "sa", name, "-o", "json");
  } catch (error) {
    if (!(error instanceof BootstrapError)) throw error;
    await oc("-n", namespace, "create", "sa", name);
    sa = await ocJSON("-n", namespace, "get", "sa", name, "-o", "json");
  }
  await oc(
    "-n",
    namespace,
    "annotate",
    "sa",
    name,
    `serviceaccounts.openshift.io/oauth-redirecturi.dex=${callback}`,
    "--overwrite",
  );

  // A manually-created service-account-token Secret works on clusters that
  // no longer auto-generate long-lived tokens. This is NOT InfraPad's client.
  const secretName = `${name}-oauth-token`;
  let existing;
  try {
    existing = await ocJSON(
      "-n",
      namespace,
      "get",
      "secret",
      secretName,
      "-o",
      "json",
    );
  } catch (error) {
    if (!(error instanceof BootstrapError)) throw error;
  }
  if (
    existing &&
    existing.metadata?.annotations?.["kubernetes.io/service-account.uid"] !==
      sa.metadata.uid
  ) {
    // Never reuse a token from an old service-account UID.
    await oc("-n", namespace, "delete", "secret", secretName);
  }
  await applyResource({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secretName,
      namespace,
      annotations: { "kubernetes.io/service-account.name": name },
    },
    type: "kubernetes.io/service-account-token",
  });
  let token;
  for (let i = 0; i < 20; i++) {
    const secret = await ocJSON(
      "-n",
      namespace,
      "get",
      "secret",
      secretName,
      "-o",
      "json",
    );
    if (secret.data?.token) {
      token = Buffer.from(secret.data.token, "base64").toString("utf8");
      break;
    }
    await sleep(1000);
  }
  if (!token)
    throw new BootstrapError(
      "service-account OAuth token was not populated; check the cluster token controller",
    );

  const directory = resolve(outputDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writePrivate(join(directory, "ca.crt"), ca);
  await writePrivate(
    join(directory, "connector.json"),
    Buffer.from(
      JSON.stringify({
        apiURL: api,
        clientID: `system:serviceaccount:${namespace}:${name}`,
        clientSecret: token,
        caFile: `${mount}/ca.crt`,
      }),
    ),
  );
  await writePrivate(
    join(directory, "ui-config.json"),
    JSON.stringify({
      infrapad: { origin: "https://localhost:8443" },
      openshiftOAuth: {
        authorizeUrl,
        clientId: userClient,
        scope: "user:full",
      },
    }),
  );
  console.log(
    `OpenShift Dex and public embedded client ready in ${directory} (private). Mount read-only at ${mount}.`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = options(process.argv.slice(2));
    if (args) await bootstrapOpenShiftDex(args);
  } catch (error) {
    // Only our own credential-free diagnostics are safe to display. zx, TLS,
    // and JSON errors can include tokens or other sensitive context.
    console.error(
      error instanceof BootstrapError
        ? `OpenShift Dex bootstrap failed: ${error.message}`
        : `OpenShift Dex bootstrap failed (${error.constructor.name}); check oc context, CA and permissions`,
    );
    process.exitCode = 1;
  }
}
