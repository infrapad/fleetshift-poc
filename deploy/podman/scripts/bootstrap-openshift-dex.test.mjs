import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import {
  loadClusterCA,
  writePrivate,
  httpsOrigin,
  embeddedOAuthClient,
} from "./bootstrap-openshift-dex.mjs";

test("host CA selection: embedded, explicit, and kube-system fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "dex-bootstrap-"));
  const path = join(root, "api.crt");
  await writePrivate(path, Buffer.from("manual CA"));
  const calls = [];
  const fromCluster = async (...args) => {
    calls.push(args);
    return { data: { "ca.crt": "cluster CA" } };
  };
  assert.equal(
    (
      await loadClusterCA(
        {
          "certificate-authority-data":
            Buffer.from("embedded CA").toString("base64"),
        },
        null,
        fromCluster,
      )
    ).toString(),
    "embedded CA",
  );
  assert.equal(
    (await loadClusterCA({}, path, fromCluster)).toString(),
    "manual CA",
  );
  assert.equal(
    (
      await loadClusterCA(
        { "insecure-skip-tls-verify": true },
        null,
        fromCluster,
      )
    ).toString(),
    "cluster CA",
  );
  assert.deepEqual(calls, [
    ["-n", "kube-system", "get", "configmap", "kube-root-ca.crt", "-o", "json"],
  ]);
  await writePrivate(path, Buffer.from("updated"));
  assert.equal(await readFile(path, "utf8"), "updated");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("embedded OAuthClient is public and restricted to the FleetShift callback", () => {
  const client = embeddedOAuthClient();
  assert.equal(client.kind, "OAuthClient");
  assert.equal(client.metadata.name, "fleetshift-infrapad");
  assert.equal(client.grantMethod, "auto");
  assert.deepEqual(client.redirectURIs, [
    "https://fleetshift-sandbox.localhost:8085/app/openshift-callback.html",
  ]);
  assert.deepEqual(client.scopeRestrictions, [{ literals: ["user:full"] }]);
  assert.equal(Object.hasOwn(client, "secret"), false);
});

test("API origin must be HTTPS without credentials or paths", () => {
  assert.equal(
    httpsOrigin("https://api.example.test:6443/"),
    "https://api.example.test:6443",
  );
  for (const bad of [
    "http://api.example",
    "https://u:secret@api.example",
    "https://api.example/path",
    "https://api.example/?token=x",
  ]) {
    assert.throws(() => httpsOrigin(bad));
  }
});
