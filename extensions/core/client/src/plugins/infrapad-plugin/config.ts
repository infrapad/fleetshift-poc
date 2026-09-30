import type { InfraPadServices } from "@infrapad/ui";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// A configured origin is a trust boundary: never infer it from the page URL.
export function infrapadOrigin(config: unknown): string | null {
  const root = object(config);
  if (!root) throw new Error("Invalid FleetShift UI configuration");
  if (!Object.hasOwn(root, "externalConfig")) return null;
  const external = object(root.externalConfig);
  if (!external) throw new Error("Invalid FleetShift external configuration");
  if (!Object.hasOwn(external, "infrapad")) return null;
  const infrapad = object(external.infrapad);
  if (!infrapad || typeof infrapad.origin !== "string") {
    throw new Error("Invalid InfraPad origin in FleetShift configuration");
  }
  const raw = infrapad.origin;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid InfraPad origin in FleetShift configuration");
  }
  if (
    !/^https?:\/\/[^/?#@]+\/?$/i.test(raw) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid InfraPad origin in FleetShift configuration");
  }
  return url.origin;
}

function serviceUrl(value: unknown, origin: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error("Invalid InfraPad service URL in /ui/config");
  }
  try {
    const url = new URL(value, origin);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid service URL");
    }
    return url.href;
  } catch {
    throw new Error("Invalid InfraPad service URL in /ui/config");
  }
}

export function infrapadServices(
  config: unknown,
  origin: string,
): InfraPadServices {
  const services = object(object(config)?.services);
  return {
    infrapadApiBaseUrl: serviceUrl(services?.infrapadApiBaseUrl, origin),
    prometheusApiBaseUrl: serviceUrl(services?.prometheusApiBaseUrl, origin),
  };
}
