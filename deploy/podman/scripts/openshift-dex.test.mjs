import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeFiles,
  configuredDexMode,
  checkOpenShiftDexMount,
} from "./common.mjs";

test("Compose uses a separate OpenShift data volume only in opt-in mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pd-dex-"));
  try {
    const envFile = join(root, ".env");
    await writeFile(envFile, "# default Dex\n");
    assert.equal(configuredDexMode({}, envFile), "demo");
    assert.ok(
      !composeFiles({ DEV: "true" }, envFile).some((file) =>
        file.endsWith("openshift-dex.yaml"),
      ),
    );
    await writeFile(envFile, "OPENSHIFT_DEX_MODE=openshift\n");
    assert.equal(configuredDexMode({}, envFile), "openshift");
    assert.ok(
      composeFiles({}, envFile).some((file) =>
        file.endsWith("openshift-dex.yaml"),
      ),
    );
    assert.equal(
      configuredDexMode({ OPENSHIFT_DEX_MODE: "openshift" }, envFile),
      "openshift",
    );
    assert.throws(
      () => configuredDexMode({ OPENSHIFT_DEX_MODE: "demo" }, envFile),
      /remove OPENSHIFT_DEX_MODE from .env/,
    );
    assert.throws(
      () => configuredDexMode({ OPENSHIFT_DEX_MODE: "openshfit" }, envFile),
      /OPENSHIFT_DEX_MODE/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenShift start bootstraps only missing credentials, never replaces partial input", async () => {
  const root = await mkdtemp(join(tmpdir(), "pd-dex-"));
  try {
    const envFile = join(root, ".env");
    await writeFile(envFile, "OPENSHIFT_DEX_MODE=openshift\n");
    const vars = { OPENSHIFT_DEX_HOST_DIR: join(root, "client") };
    const config = join(vars.OPENSHIFT_DEX_HOST_DIR, "connector.json");
    const ca = join(vars.OPENSHIFT_DEX_HOST_DIR, "ca.crt");
    const uiConfig = join(vars.OPENSHIFT_DEX_HOST_DIR, "ui-config.json");
    let calls = 0;
    const bootstrap = async ({ outputDir }) => {
      assert.equal(outputDir, vars.OPENSHIFT_DEX_HOST_DIR);
      calls++;
      await mkdir(outputDir, { mode: 0o700, recursive: true });
      await writeFile(config, "{}", { mode: 0o600 });
      await writeFile(ca, "CA", { mode: 0o600 });
      await writeFile(uiConfig, "{}", { mode: 0o600 });
    };
    await checkOpenShiftDexMount(vars, envFile, bootstrap);
    await checkOpenShiftDexMount(vars, envFile, bootstrap);
    assert.equal(calls, 1);

    await rm(ca);
    await assert.rejects(
      checkOpenShiftDexMount(vars, envFile, bootstrap),
      /pd:bootstrap-openshift-dex/,
    );
    assert.equal(calls, 1);
    await rm(config);
    await rm(uiConfig);
    await checkOpenShiftDexMount(vars, envFile, bootstrap); // empty directory is first-run too
    assert.equal(calls, 2);

    await rm(vars.OPENSHIFT_DEX_HOST_DIR, { recursive: true });
    await assert.rejects(
      checkOpenShiftDexMount(vars, envFile, async () => {
        throw new Error("sensitive upstream diagnostic");
      }),
      (error) =>
        /bootstrap failed/.test(error.message) &&
        !error.message.includes("sensitive"),
    );
    await mkdir(vars.OPENSHIFT_DEX_HOST_DIR, { mode: 0o700 });
    await chmod(vars.OPENSHIFT_DEX_HOST_DIR, 0o755);
    await assert.rejects(
      checkOpenShiftDexMount(vars, envFile, bootstrap),
      /private connector.json/,
    );
    assert.equal(calls, 2);

    await writeFile(
      envFile,
      "OPENSHIFT_DEX_MODE=openshift\nOIDC_ISSUER_URL=https://external.example\n",
    );
    await rm(vars.OPENSHIFT_DEX_HOST_DIR, { recursive: true });
    await assert.rejects(
      checkOpenShiftDexMount(vars, envFile, bootstrap),
      /OIDC_ISSUER_URL/,
    );
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
