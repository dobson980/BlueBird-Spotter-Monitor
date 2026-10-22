/** Independent, read-only watchdog. Run directly with the pinned Node version. */
import { appendFileSync } from "node:fs";

const descriptions = {
  quotes: "Quote data is stale or its market state is unknown.",
  orbits: "Saved orbit data is older than the freshness limit.",
  backups: "No recent successful backup was recorded.",
  operations: "The scheduled operations health check needs attention.",
  sources: "One or more news sources are overdue.",
  usageCollection: "Usage collection is missing or overdue.",
  usage70: "Usage has reached the 70% warning threshold.",
  usage90: "Usage has reached the 90% warning threshold.",
  budget: "The configured budget health check failed.",
  deadLetters:
    "News imports have unresolved failures or recovery is still pending.",
} as const;
type Check = keyof typeof descriptions;
type FailureKind = "unavailable" | "monitor-error";

export class MonitorError extends Error {
  kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export async function checkBackend(
  origin: string,
  token: string,
  request = fetch,
) {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new MonitorError(
      "monitor-error",
      "API_ORIGIN must be an HTTPS origin.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new MonitorError(
      "monitor-error",
      "API_ORIGIN must be an HTTPS origin.",
    );
  if (!token)
    throw new MonitorError("monitor-error", "MONITOR_TOKEN is required.");

  let response: Response;
  try {
    response = await request(new URL("/internal/health", url), {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new MonitorError(
      "unavailable",
      "The health request failed: network, TLS, redirect or timeout error. Check endpoint reachability.",
    );
  }
  if (response.status !== 200 && response.status !== 503) {
    const auth = response.status === 401 || response.status === 403;
    throw new MonitorError(
      response.status >= 500 ? "unavailable" : "monitor-error",
      `Health endpoint returned HTTP ${response.status}. ${auth ? "Check the environment's monitoring credential and access policy." : "Check endpoint access and the backend response."}`,
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new MonitorError(
      response.status === 503 ? "unavailable" : "monitor-error",
      `HTTP ${response.status}: invalid or incomplete health JSON. No data-health classification is possible.`,
    );
  }
  const invalid = () =>
    new MonitorError(
      "monitor-error",
      `HTTP ${response.status}: invalid or contradictory health response. Check the backend/monitor contract.`,
    );
  if (
    !value ||
    typeof value !== "object" ||
    !("ok" in value) ||
    !("checks" in value)
  )
    throw invalid();
  const checks = value.checks;
  if (
    typeof value.ok !== "boolean" ||
    !checks ||
    typeof checks !== "object" ||
    Array.isArray(checks) ||
    !Object.values(checks).every((v) => typeof v === "boolean") ||
    !Object.keys(descriptions).every((key) => Object.hasOwn(checks, key))
  )
    throw invalid();
  const allPassed = Object.values(checks).every((v) => v === true);
  if (value.ok !== allPassed || (response.status === 200) !== allPassed)
    throw invalid();
  // Unknown failing checks must not silently become warnings after a backend schema change.
  if (
    Object.entries(checks).some(
      ([key, passed]) => !Object.hasOwn(descriptions, key) && !passed,
    )
  )
    throw new MonitorError(
      "monitor-error",
      "An unrecognized health check failed. Review the backend/monitor contract; no upstream names or values were published.",
    );
  const failedChecks = (Object.keys(descriptions) as Check[]).filter(
    (key) => !(checks as Record<string, boolean>)[key],
  );
  return {
    status: failedChecks.length ? ("degraded" as const) : ("healthy" as const),
    httpStatus: response.status,
    failedChecks,
  };
}

function publish(status: string, message: string, summary: string) {
  console.log(JSON.stringify({ status, message }));
  // All annotation/summary text is locally defined, never response bodies or arbitrary check names.
  if (process.env.GITHUB_ACTIONS === "true" && status !== "healthy")
    console.log(
      `::${status === "degraded" ? "warning" : "error"} title=BlueBird ${status}::${message}`,
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
}

if (import.meta.main) {
  try {
    const result = await checkBackend(
      process.env.API_ORIGIN || "",
      process.env.MONITOR_TOKEN || "",
    );
    const message =
      result.status === "healthy"
        ? "Backend reachable; all health checks passed."
        : `Backend reachable; health warnings: ${result.failedChecks.join(", ")}. Review BlueBird admin Health and Operations.`;
    const details = result.failedChecks
      .map((key) => `- **${key}**: ${descriptions[key]}`)
      .join("\n");
    publish(
      result.status,
      message,
      `## BlueBird: ${result.status === "degraded" ? "reachable — health warnings" : "healthy"}\n\nHTTP ${result.httpStatus}. ${message}\n\n${details}\n\nAvailability is checked externally. Cloudflare incident/recovery emails remain responsible for data and operational warnings. This run does not verify that those emails were delivered.`,
    );
  } catch (error) {
    const failure =
      error instanceof MonitorError
        ? error
        : new MonitorError(
            "monitor-error",
            "Monitor execution failed; inspect the workflow configuration.",
          );
    publish(
      failure.kind,
      failure.message,
      `## BlueBird: ${failure.kind}\n\n${failure.message}\n\nThis run could not establish a valid healthy or degraded backend response. A monitor error does not by itself prove an app outage.`,
    );
    process.exitCode = 1;
  }
}
