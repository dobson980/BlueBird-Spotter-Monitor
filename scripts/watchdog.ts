/** Independent watchdog. Run directly with Node 24; no package install is required. */
export async function checkBackend(origin: string, token: string, request = fetch) {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("API_ORIGIN must be an HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("API_ORIGIN must be an HTTPS origin");
  if (!token) throw new Error("MONITOR_TOKEN is required");

  let response: Response;
  try {
    response = await request(new URL("/internal/health", url), {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error("Backend watchdog failed: network, redirect or timeout error");
  }
  if (!response.ok) throw new Error(`Backend watchdog failed: HTTP ${response.status}`);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("Backend watchdog failed: invalid or incomplete JSON response");
  }
  if (!value || typeof value !== "object" || !("ok" in value) || !("checks" in value))
    throw new Error("Backend watchdog failed: invalid health response");
  const checks = value.checks;
  if (
    typeof value.ok !== "boolean" ||
    !checks ||
    typeof checks !== "object" ||
    Array.isArray(checks) ||
    Object.keys(checks).length === 0 ||
    !Object.entries(checks).every(
      ([name, passed]) => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) && typeof passed === "boolean",
    )
  )
    throw new Error("Backend watchdog failed: invalid health response");
  if (!value.ok || !Object.values(checks).every((passed) => passed === true))
    throw new Error("Backend watchdog failed: unhealthy checks");
  return { ok: true, checks: checks as Record<string, boolean> };
}

if (import.meta.main) {
  try {
    console.log(
      JSON.stringify(
        await checkBackend(process.env.API_ORIGIN || "", process.env.MONITOR_TOKEN || ""),
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Backend watchdog failed");
    process.exitCode = 1;
  }
}
