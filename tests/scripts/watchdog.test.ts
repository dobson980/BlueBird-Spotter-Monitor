import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkBackend } from "../../scripts/watchdog.ts";

const origin = "https://api-staging.bluebirdspotter.space";
const token = "fixture-monitor-token";
const respond = (body: unknown, status = 200) =>
  (async () => Response.json(body, { status })) as typeof fetch;

test("checks the authenticated endpoint without redirects and omits unrelated health data", async () => {
  const result = await checkBackend(origin, token, (async (input, init) => {
    assert.equal(String(input), `${origin}/internal/health`);
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json({ ok: true, checks: { quotes: true }, sources: ["private details"] });
  }) as typeof fetch);
  assert.deepEqual(result, { ok: true, checks: { quotes: true } });
});

test("rejects failures and malformed or contradictory successful responses", async () => {
  for (const body of [
    {},
    { ok: "true", checks: { quotes: true } },
    { ok: true, checks: {} },
    { ok: true, checks: [] },
    { ok: true, checks: { quotes: "true" } },
    { ok: false, checks: { quotes: true } },
    { ok: true, checks: { quotes: false } },
  ])
    await assert.rejects(checkBackend(origin, token, respond(body)), /Backend watchdog failed/);
  for (const status of [401, 429, 503])
    await assert.rejects(
      checkBackend(origin, token, respond({}, status)),
      new RegExp(`HTTP ${status}`),
    );
});

test("refuses invalid origin and missing credentials before making a request", async () => {
  const unexpected = (async () => {
    throw new Error("unexpected fetch");
  }) as typeof fetch;
  for (const invalid of [
    "",
    "http://api.example.com",
    "https://user:password@api.example.com",
    `${origin}/other`,
    `${origin}?key=secret`,
    `${origin}#fragment`,
  ])
    await assert.rejects(checkBackend(invalid, token, unexpected), /HTTPS origin/);
  await assert.rejects(checkBackend(origin, "", unexpected), /MONITOR_TOKEN is required/);
});

test("network and body errors do not leak upstream error text", async () => {
  await assert.rejects(
    checkBackend(origin, token, (async () => {
      throw new Error(token);
    }) as typeof fetch),
    { message: "Backend watchdog failed: network, redirect or timeout error" },
  );
  await assert.rejects(
    checkBackend(
      origin,
      token,
      (async () => new Response(`<html>${token}</html>`)) as typeof fetch,
    ),
    { message: "Backend watchdog failed: invalid or incomplete JSON response" },
  );
});

test("the CLI runs with Node alone and exits unsuccessfully on unhealthy responses", () => {
  const dir = mkdtempSync(join(tmpdir(), "bluebird-watchdog-"));
  try {
    writeFileSync(
      join(dir, "watchdog.ts"),
      readFileSync(new URL("../../scripts/watchdog.ts", import.meta.url)),
    );
    writeFileSync(
      join(dir, "mock.mjs"),
      "globalThis.fetch = async () => Response.json(JSON.parse(process.env.TEST_HEALTH));",
    );
    for (const healthy of [true, false]) {
      const result = spawnSync(
        process.execPath,
        ["--import", join(dir, "mock.mjs"), join(dir, "watchdog.ts")],
        {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            API_ORIGIN: origin,
            MONITOR_TOKEN: token,
            TEST_HEALTH: JSON.stringify({ ok: healthy, checks: { quotes: healthy } }),
          },
        },
      );
      assert.equal(result.status, healthy ? 0 : 1, result.stderr);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(token));
      if (healthy)
        assert.deepEqual(JSON.parse(result.stdout), { ok: true, checks: { quotes: true } });
      else assert.match(result.stderr, /unhealthy checks/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
