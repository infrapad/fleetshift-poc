import "@infrapad/ui/styles.css";

import {
  InfraPadDocuments,
  type InfraPadFetch,
  type InfraPadServices,
} from "@infrapad/ui";
import {
  Bullseye,
  Button,
  EmptyState,
  EmptyStateBody,
  EmptyStateFooter,
  Spinner,
} from "@patternfly/react-core";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "react-oidc-context";

import { infrapadOrigin, infrapadServices } from "./config";

type Bootstrap =
  | { status: "loading" }
  | { status: "not-configured" }
  | { status: "error"; message: string }
  | { status: "ready"; services: InfraPadServices };

async function json(response: Response, name: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${name} unavailable (${response.status})`);
  return response.json();
}

async function loadServices(token: string): Promise<Bootstrap> {
  // This is the shell's public configuration endpoint, not its private React context.
  const config = await json(
    await fetch("/api/ui/config"),
    "FleetShift configuration",
  );
  const origin = infrapadOrigin(config);
  if (!origin) return { status: "not-configured" };
  const response = await fetch(`${origin}/ui/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    status: "ready",
    services: infrapadServices(
      await json(response, "InfraPad configuration"),
      origin,
    ),
  };
}

function ModuleState({
  title,
  detail,
  retry,
}: {
  title: string;
  detail: string;
  retry?: () => void;
}) {
  return (
    <EmptyState titleText={title} headingLevel="h1">
      <EmptyStateBody>{detail}</EmptyStateBody>
      {retry && (
        <EmptyStateFooter>
          <Button onClick={retry}>Retry configuration</Button>
        </EmptyStateFooter>
      )}
    </EmptyState>
  );
}

export default function InfrapadDocsModule() {
  const auth = useAuth();
  const token = auth.user?.access_token;
  // The shared client can outlive a token rotation. Never capture a bootstrap token
  // in its request function, and never let missing tokens fall back to plain fetch.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [attempt, setAttempt] = useState(0);
  const [bootstrap, setBootstrap] = useState<Bootstrap>({ status: "loading" });

  useEffect(() => {
    if (!token) return;
    let active = true;
    setBootstrap({ status: "loading" });
    loadServices(token).then(
      (result) => {
        if (active) setBootstrap(result);
      },
      (error: unknown) => {
        if (active)
          setBootstrap({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Unable to load InfraPad configuration",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [token, attempt]);

  if (auth.isLoading)
    return (
      <Bullseye>
        <Spinner size="xl" />
      </Bullseye>
    );
  if (!token) {
    return (
      <ModuleState
        title="FleetShift login required"
        detail="Sign in to FleetShift to use InfraPad."
      />
    );
  }
  if (bootstrap.status === "loading")
    return (
      <Bullseye>
        <Spinner size="xl" />
      </Bullseye>
    );
  if (bootstrap.status === "not-configured") {
    return (
      <ModuleState
        title="InfraPad is not configured"
        detail="Set externalConfig.infrapad.origin in FleetShift's public UI configuration."
      />
    );
  }
  if (bootstrap.status === "error") {
    return (
      <ModuleState
        title="Unable to load InfraPad configuration"
        detail={bootstrap.message}
        retry={() => setAttempt((n) => n + 1)}
      />
    );
  }

  // Only the deployment-configured services are trusted bearer destinations.
  const services = bootstrap.services;
  const hostFetch: InfraPadFetch = (input, init) => {
    const currentToken = tokenRef.current;
    if (!currentToken)
      return Promise.reject(new Error("FleetShift login required"));
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      ![services.infrapadApiBaseUrl, services.prometheusApiBaseUrl].some(
        (base) => {
          const target = new URL(base);
          return (
            url.origin === target.origin &&
            (url.pathname === target.pathname.replace(/\/$/, "") ||
              url.pathname.startsWith(`${target.pathname.replace(/\/$/, "")}/`))
          );
        },
      )
    ) {
      return Promise.reject(
        new Error("Unconfigured InfraPad request destination"),
      );
    }
    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set("Authorization", `Bearer ${currentToken}`);
    return fetch(input, { ...init, headers });
  };

  return <InfraPadDocuments services={services} fetch={hostFetch} />;
}
