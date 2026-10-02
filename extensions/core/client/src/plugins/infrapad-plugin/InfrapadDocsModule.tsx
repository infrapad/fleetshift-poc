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

import {
  infrapadOrigin,
  infrapadServices,
  type OpenShiftOAuthConfig,
  openshiftOAuthConfig,
} from "./config";
import {
  acquireOpenShiftToken,
  clearOpenShiftToken,
  openShiftToken,
} from "./openshiftToken";

type Bootstrap =
  | { status: "loading" }
  | { status: "not-configured" }
  | { status: "error"; message: string }
  | { status: "connect"; oauth: OpenShiftOAuthConfig; message?: string }
  | {
      status: "ready";
      services: InfraPadServices;
      oauth: OpenShiftOAuthConfig | null;
    };

async function json(response: Response, name: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${name} unavailable (${response.status})`);
  return response.json();
}

async function loadServices(
  token: string,
  subject: string,
): Promise<Bootstrap> {
  // This is the shell's public configuration endpoint, not its private React context.
  const config = await json(
    await fetch("/api/ui/config"),
    "FleetShift configuration",
  );
  const origin = infrapadOrigin(config);
  if (!origin) return { status: "not-configured" };
  const oauth = openshiftOAuthConfig(config);
  if (
    oauth &&
    (new URL(origin).protocol !== "https:" || origin === location.origin)
  )
    throw new Error(
      "OpenShift InfraPad origin must be a separate HTTPS endpoint",
    );
  const bearer = oauth ? openShiftToken(subject, oauth) : token;
  if (!bearer) return { status: "connect", oauth: oauth! };
  let response: Response;
  try {
    response = await fetch(`${origin}/ui/config`, {
      headers: { Authorization: `Bearer ${bearer}` },
      ...(oauth ? { redirect: "error" as const } : {}),
    });
  } catch (error) {
    // The OAuth proxy's redirect/error is not CORS-readable. A network failure
    // looks the same; never retry with another credential or follow the login.
    if (oauth)
      return {
        status: "connect",
        oauth,
        message:
          "InfraPad could not complete the authenticated request. Check connectivity or reconnect to OpenShift.",
      };
    throw error;
  }
  if (oauth && response.status === 401) {
    clearOpenShiftToken();
    return {
      status: "connect",
      oauth,
      message: "OpenShift authorization expired. Reconnect to continue.",
    };
  }
  return {
    status: "ready",
    oauth,
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
  action = "Retry configuration",
}: {
  title: string;
  detail: string;
  retry?: () => void;
  action?: string;
}) {
  return (
    <EmptyState titleText={title} headingLevel="h1">
      <EmptyStateBody>{detail}</EmptyStateBody>
      {retry && (
        <EmptyStateFooter>
          <Button onClick={retry}>{action}</Button>
        </EmptyStateFooter>
      )}
    </EmptyState>
  );
}

export default function InfrapadDocsModule() {
  const auth = useAuth();
  const token = auth.user?.access_token;
  const subject = auth.user?.profile?.sub ?? "";
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
    loadServices(token, subject).then(
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
  }, [token, subject, attempt]);

  const connect = (oauth: OpenShiftOAuthConfig) => {
    // A proxy redirect may mean a rejected but locally unexpired token. Force
    // a fresh authorization only when the user chooses to reconnect.
    clearOpenShiftToken();
    // Called directly by the button so window.open runs within user activation.
    const pending = acquireOpenShiftToken(subject, oauth);
    setBootstrap({ status: "loading" });
    pending.then(
      () => setAttempt((n) => n + 1),
      (error: unknown) =>
        setBootstrap({
          status: "connect",
          oauth,
          message:
            error instanceof Error
              ? error.message
              : "Unable to connect to OpenShift",
        }),
    );
  };

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
  if (bootstrap.status === "connect") {
    return (
      <ModuleState
        title="Connect to OpenShift"
        detail={
          bootstrap.message ??
          "Authorize embedded InfraPad access with your OpenShift account."
        }
        action="Connect to OpenShift"
        retry={() => connect(bootstrap.oauth)}
      />
    );
  }

  // Only configured service base paths are trusted bearer destinations. Never
  // send an OpenShift bearer to a same-origin FleetShift API path.
  const { services, oauth } = bootstrap;
  const matchesService = (url: URL, base: string) => {
    const target = new URL(base);
    const path = target.pathname.replace(/\/$/, "");
    return (
      url.origin === target.origin &&
      (url.pathname === path || url.pathname.startsWith(`${path}/`))
    );
  };
  const hostFetch: InfraPadFetch = (input, init) => {
    const currentToken = oauth
      ? openShiftToken(subject, oauth)
      : tokenRef.current;
    if (!currentToken) {
      if (oauth)
        setBootstrap({
          status: "connect",
          oauth,
          message: "OpenShift authorization expired. Reconnect to continue.",
        });
      return Promise.reject(
        new Error(
          oauth
            ? "Connect to OpenShift to continue"
            : "FleetShift login required",
        ),
      );
    }
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      (oauth &&
        (url.origin === location.origin || url.protocol !== "https:")) ||
      ![services.infrapadApiBaseUrl, services.prometheusApiBaseUrl].some(
        (base) => matchesService(url, base),
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
    return fetch(input, {
      ...init,
      headers,
      ...(oauth ? { redirect: "error" as const } : {}),
    })
      .then((response) => {
        if (
          oauth &&
          response.status === 401 &&
          matchesService(url, services.infrapadApiBaseUrl)
        ) {
          clearOpenShiftToken();
          setBootstrap({
            status: "connect",
            oauth,
            message: "OpenShift authorization expired. Reconnect to continue.",
          });
        }
        return response;
      })
      .catch((error: unknown) => {
        // Only InfraPad API failures can require a reconnect. Chart failures
        // must remain local to charts (including a separate Thanos denial).
        if (oauth && matchesService(url, services.infrapadApiBaseUrl))
          setBootstrap({
            status: "connect",
            oauth,
            message:
              "InfraPad could not complete the authenticated request. Check connectivity or reconnect to OpenShift.",
          });
        throw error;
      });
  };

  return <InfraPadDocuments services={services} fetch={hostFetch} />;
}
