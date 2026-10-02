import type { OpenShiftOAuthConfig } from "./config";

// The shell clears this on FleetShift logout. Do not put bearer values in URLs,
// persistent storage, logs or the public UI configuration.
const storageKey = "fleetshift:openshift-oauth";
const messageType = "fleetshift:openshift-oauth";

interface StoredToken {
  token: string;
  expiresAt: number;
  subject: string;
  clientId: string;
  authorizeUrl: string;
}

export function clearOpenShiftToken() {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    /* Storage disabled. */
  }
}

export function openShiftToken(
  subject: string,
  config: OpenShiftOAuthConfig,
): string | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const value: StoredToken = JSON.parse(raw);
    if (
      typeof value.token === "string" &&
      value.token &&
      value.subject === subject &&
      value.clientId === config.clientId &&
      value.authorizeUrl === config.authorizeUrl &&
      Number.isFinite(value.expiresAt) &&
      value.expiresAt > Date.now() + 60_000
    )
      return value.token;
  } catch {
    // Corrupt/blocked storage must never result in an unauthenticated request.
  }
  clearOpenShiftToken();
  return null;
}

export function acquireOpenShiftToken(
  subject: string,
  config: OpenShiftOAuthConfig,
): Promise<string> {
  if (!subject)
    return Promise.reject(
      new Error("FleetShift identity unavailable. Sign in again."),
    );
  const cached = openShiftToken(subject, config);
  if (cached) return Promise.resolve(cached);

  // Open synchronously in the user's click handler, before any await, to avoid
  // popup blockers. The callback page is same-origin with the opener.
  const state = crypto.randomUUID();
  const redirectUri = `${location.origin}/app/openshift-callback.html`;
  const url = new URL(config.authorizeUrl);
  url.search = new URLSearchParams({
    response_type: "token",
    client_id: config.clientId,
    scope: config.scope,
    redirect_uri: redirectUri,
    state,
  }).toString();
  const popup = window.open(
    url.href,
    "fleetshift-openshift",
    "popup,width=600,height=700",
  );
  if (!popup)
    return Promise.reject(
      new Error("Popup blocked. Allow popups and try connecting again."),
    );

  return new Promise<string>((resolve, reject) => {
    let finished = false;
    const finish = (token?: string, error?: string) => {
      if (finished) return;
      finished = true;
      window.removeEventListener("message", onMessage);
      window.removeEventListener("fleetshift:logout", onLogout);
      clearInterval(poll);
      clearTimeout(timeout);
      popup.close();
      if (token) resolve(token);
      else
        reject(
          new Error(error || "OpenShift connection was cancelled. Try again."),
        );
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== popup) return;
      const data = event.data;
      if (data?.type !== messageType || data.state !== state) return;
      if (typeof data.error === "string") {
        finish(undefined, `OpenShift authorization failed: ${data.error}`);
        return;
      }
      const lifetime = Number(data.expiresIn);
      if (
        typeof data.accessToken !== "string" ||
        !data.accessToken ||
        !Number.isFinite(lifetime) ||
        lifetime <= 60
      ) {
        finish(
          undefined,
          "OpenShift returned an invalid or expired token. Try again.",
        );
        return;
      }
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({
            token: data.accessToken,
            expiresAt: Date.now() + Math.min(lifetime, 3600) * 1000,
            subject,
            clientId: config.clientId,
            authorizeUrl: config.authorizeUrl,
          } satisfies StoredToken),
        );
        finish(data.accessToken);
      } catch {
        finish(
          undefined,
          "Session storage is unavailable. Enable it and try again.",
        );
      }
    };
    const onLogout = () =>
      finish(undefined, "FleetShift session ended. Sign in again.");
    window.addEventListener("message", onMessage);
    window.addEventListener("fleetshift:logout", onLogout);
    const poll = window.setInterval(() => {
      if (popup.closed) finish();
    }, 500);
    const timeout = window.setTimeout(
      () => finish(undefined, "OpenShift connection timed out. Try again."),
      120_000,
    );
  });
}
