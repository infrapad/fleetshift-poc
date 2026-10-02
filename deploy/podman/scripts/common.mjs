import { $, sleep } from "zx";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { parseEnv } from "node:util";
import {
  BootstrapError,
  bootstrapOpenShiftDex,
} from "./bootstrap-openshift-dex.mjs";

$.verbose = true;

export const scriptDir = dirname(fileURLToPath(import.meta.url));
export const composeDir = resolve(scriptDir, "..");
export const deployDir = resolve(composeDir, "..");
export const rootDir = resolve(deployDir, "..");

// Nx forwards KEY=value arguments after the target command; expose them to scripts.
const nxEnvironmentKeys = new Set([
  "DEV",
  "LOCAL_WEB",
  "NX_CACHE",
  "BUILD",
  "PODMAN_SOCKET",
  "DOCKER_HOST",
  "FLEETSHIFT_SERVER_HTTP_PORT",
  "OIDC_ISSUER_URL",
  "OPENSHIFT_DEX_MODE",
  "OPENSHIFT_DEX_HOST_DIR",
]);
export function importKeyValueArgs(args) {
  const positional = [];
  for (const arg of args) {
    const separator = arg.indexOf("=");
    if (separator > 0 && nxEnvironmentKeys.has(arg.slice(0, separator))) {
      process.env[arg.slice(0, separator)] = arg.slice(separator + 1);
    } else {
      positional.push(arg);
    }
  }
  return positional;
}

export async function ensurePodmanReady() {
  // Compose uses Podman's API socket rather than a Docker daemon.
  if (process.platform === "linux") {
    try {
      await $`systemctl --user is-active podman.socket`;
    } catch {
      throw new Error(
        "Podman API socket is not running. Start it with: systemctl --user enable --now podman.socket",
      );
    }
  }

  if (!process.env.PODMAN_SOCKET) {
    try {
      process.env.PODMAN_SOCKET = (
        await $`podman info --format {{.Host.RemoteSocket.Path}}`
      ).stdout
        .trim()
        .replace(/^unix:\/\//, "");
    } catch {
      if (process.platform === "linux") {
        process.env.PODMAN_SOCKET = `/run/user/${process.getuid()}/podman/podman.sock`;
      }
    }
  }

  if (!process.env.PODMAN_SOCKET) {
    throw new Error(
      "Could not determine Podman socket path. Is Podman running?",
    );
  }

  if (process.platform === "linux") {
    const socket = await $`test -S ${process.env.PODMAN_SOCKET}`.nothrow();
    if (!socket.ok)
      throw new Error(
        `Podman API socket not found at ${process.env.PODMAN_SOCKET}. Start it with: systemctl --user enable --now podman.socket`,
      );
    if (!process.env.DOCKER_HOST)
      process.env.DOCKER_HOST = `unix://${process.env.PODMAN_SOCKET}`;
  }
}

// The compose CLI reads .env, but the launcher needs its mode before invoking
// compose (and before starting an expensive build). Explicit Nx args / shell
// env take precedence over .env, as they do for compose interpolation.
function composeEnvironment(envFile = resolve(rootDir, ".env")) {
  try {
    return parseEnv(readFileSync(envFile, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

export function configuredDexMode(env = process.env, envFile) {
  const fileMode = composeEnvironment(envFile).OPENSHIFT_DEX_MODE;
  const mode = env.OPENSHIFT_DEX_MODE ?? fileMode ?? "";
  // env_file values go directly into the container: without the OpenShift
  // overlay, a CLI demo override would still pass .env's openshift mode.
  if (fileMode === "openshift" && mode !== "openshift")
    throw new Error(
      "To return to demo, remove OPENSHIFT_DEX_MODE from .env first",
    );
  if (mode !== "" && mode !== "demo" && mode !== "openshift")
    throw new Error(
      "Invalid OPENSHIFT_DEX_MODE; use openshift or omit it for demo Dex",
    );
  return mode === "openshift" ? "openshift" : "demo";
}

export function composeFiles(env = process.env, envFile) {
  // Keep the default volume untouched: the overlay replaces only the /data
  // mount for OpenShift mode and adds the private read-only connector mount.
  const files = ["-f", resolve(composeDir, "compose.yaml")];
  if (env.DEV === "true")
    files.push("-f", resolve(composeDir, "overrides/dev.yaml"));
  if (env.LOCAL_WEB === "true")
    files.push("-f", resolve(composeDir, "overrides/local-web.yaml"));
  if (env.NX_CACHE === "true")
    files.push("-f", resolve(composeDir, "overrides/nx-cache.yaml"));
  if (configuredDexMode(env, envFile) === "openshift")
    files.push("-f", resolve(composeDir, "overrides/openshift-dex.yaml"));
  return files;
}

export async function checkOpenShiftDexMount(
  env = process.env,
  envFile,
  bootstrap = bootstrapOpenShiftDex,
) {
  if (configuredDexMode(env, envFile) !== "openshift") return;
  const configured = composeEnvironment(envFile);
  if (env.OIDC_ISSUER_URL || configured.OIDC_ISSUER_URL)
    throw new Error(
      "OPENSHIFT_DEX_MODE=openshift conflicts with OIDC_ISSUER_URL; unset it in .env",
    );
  const hostDir = resolve(
    composeDir,
    env.OPENSHIFT_DEX_HOST_DIR ??
      configured.OPENSHIFT_DEX_HOST_DIR ??
      "../aio/.local/openshift-dex",
  );
  const invalidMount = () =>
    new Error(
      `OpenShift mode requires private connector.json, ca.crt and ui-config.json under ${hostDir}; run npx nx run pd:bootstrap-openshift-dex to repair the mount`,
    );

  let firstRun = false;
  try {
    const dir = await stat(hostDir);
    if (!dir.isDirectory() || dir.mode & 0o077) throw invalidMount();
    firstRun = (await readdir(hostDir)).length === 0;
  } catch (error) {
    if (error.code === "ENOENT") firstRun = true;
    else throw invalidMount();
  }
  if (firstRun) {
    // Only a missing/empty directory is bootstrapped automatically. Never
    // overwrite partial credentials or repair unsafe permissions implicitly.
    console.log(
      "==> OpenShift Dex files absent; bootstrapping with the current host oc context",
    );
    try {
      await bootstrap({ outputDir: hostDir });
    } catch (error) {
      if (error instanceof BootstrapError)
        throw new Error(`OpenShift Dex bootstrap failed: ${error.message}`);
      // Do not log arbitrary oc/TLS errors: they may contain credentials.
      throw new Error(
        "OpenShift Dex bootstrap failed; check the oc context, CA, and cluster permissions",
      );
    }
  }
  try {
    const dir = await stat(hostDir);
    if (!dir.isDirectory() || dir.mode & 0o077) throw invalidMount();
    for (const name of ["connector.json", "ca.crt", "ui-config.json"]) {
      const file = await stat(join(hostDir, name));
      if (!file.isFile() || file.mode & 0o077) throw invalidMount();
    }
  } catch {
    throw invalidMount();
  }
}

export function compose(...args) {
  if (configuredDexMode() === "openshift") {
    // Public endpoints only; the secret-bearing connector file is never
    // exposed to Compose environment interpolation or /api/ui/config.
    const configured = composeEnvironment();
    const hostDir = resolve(
      composeDir,
      process.env.OPENSHIFT_DEX_HOST_DIR ??
        configured.OPENSHIFT_DEX_HOST_DIR ??
        "../aio/.local/openshift-dex",
    );
    try {
      process.env.OPENSHIFT_UI_CONFIG = readFileSync(
        join(hostDir, "ui-config.json"),
        "utf8",
      );
    } catch {
      throw new Error(
        "OpenShift UI config missing; run npx nx run pd:bootstrap-openshift-dex",
      );
    }
  }
  if (!process.env.COMPOSE_PROVIDER_CHECKED) {
    if (
      spawnSync("command", ["-v", "docker-compose"], {
        shell: true,
        stdio: "ignore",
      }).status !== 0
    ) {
      throw new Error(
        "docker-compose is not installed. Install: brew install docker-compose (podman-compose is not supported)",
      );
    }
    process.env.COMPOSE_PROVIDER_CHECKED = "true";
  }
  return $`podman compose ${composeFiles()} --env-file ${resolve(rootDir, ".env")} ${args}`;
}

export async function copySandboxCA() {
  // Dex creates its CA during startup, so copy it with a bounded retry loop.
  const destination = resolve(composeDir, ".certs/ca.crt");
  await $`mkdir -p ${dirname(destination)}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await compose(
        "cp",
        "fleetshift-server:/data/sandbox/pki/ca.crt",
        destination,
      );
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error("sandbox CA was not ready before timeout");
}
