import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkBackend, MonitorError } from "../../scripts/watchdog.ts";

const origin = "https://api-staging.bluebirdspotter.space";
const token = "fixture-monitor-token";
const checks = {
  quotes: true,
  orbits: true,
  backups: true,
  operations: true,
  sources: true,
  usageCollection: true,
  usage70: true,
  usage90: true,
  budget: true,
  deadLetters: true,
};
const health = (overrides = {}) => ({ ok: true, checks, ...overrides });
const respond = (body: unknown, status = 200) =>
  (async () => Response.json(body, { status })) as typeof fetch;

test("checks authenticated health without redirects and omits private details", async () => {
  const result = await checkBackend(origin, token, (async (input, init) => {
    assert.equal(String(input), `${origin}/internal/health`);
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      `Bearer ${token}`,
    );
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json(
      health({ sources: [token], checkedAt: "private metadata" }),
    );
  }) as typeof fetch);
  assert.deepEqual(result, {
    status: "healthy",
    httpStatus: 200,
    failedChecks: [],
  });
});

for (const key of Object.keys(checks)) {
  test(`valid 503 for ${key} is reachable with a named warning`, async () => {
    assert.deepEqual(
      await checkBackend(
        origin,
        token,
        respond(
          health({ ok: false, checks: { ...checks, [key]: false } }),
          503,
        ),
      ),
      { status: "degraded", httpStatus: 503, failedChecks: [key] },
    );
  });
}

test("names multiple failed aggregate checks without returning source details", async () => {
  assert.deepEqual(
    await checkBackend(
      origin,
      token,
      respond(
        health({
          ok: false,
          checks: { ...checks, sources: false, deadLetters: false },
          sources: [{ error: token }],
        }),
        503,
      ),
    ),
    {
      status: "degraded",
      httpStatus: 503,
      failedChecks: ["sources", "deadLetters"],
    },
  );
});

test("rejects malformed, incomplete and contradictory health contracts", async () => {
  for (const [body, status] of [
    [{}, 200],
    [health({ ok: "true" }), 200],
    [health({ checks: {} }), 200],
    [health({ checks: [] }), 200],
    [health({ checks: { ...checks, quotes: "true" } }), 200],
    [health({ checks: { ...checks, quotes: undefined } }), 200],
    [health({ ok: false }), 200],
    [health({ checks: { ...checks, quotes: false } }), 200],
    [health({ ok: false, checks: { ...checks, sources: false } }), 200],
    [health(), 503],
    [health({ ok: false }), 503],
    [null, 503],
  ] as const) {
    await assert.rejects(
      checkBackend(origin, token, respond(body, status)),
      /invalid or contradictory/,
    );
  }
});

test("unknown failed check fails closed; unknown passed name is never published", async () => {
  await assert.rejects(
    checkBackend(
      origin,
      token,
      respond(
        health({ ok: false, checks: { ...checks, [token]: false } }),
        503,
      ),
    ),
    (error: MonitorError) =>
      error.kind === "monitor-error" &&
      /unrecognized/.test(error.message) &&
      !error.message.includes(token),
  );
  assert.deepEqual(
    await checkBackend(
      origin,
      token,
      respond(health({ checks: { ...checks, [token]: true } })),
    ),
    { status: "healthy", httpStatus: 200, failedChecks: [] },
  );
});

for (const status of [301, 401, 403, 404, 429, 500, 502, 504]) {
  test(`HTTP ${status} remains a failure with status and category`, async () => {
    await assert.rejects(
      checkBackend(origin, token, respond({ private: token }, status)),
      (error: MonitorError) =>
        error.kind === (status >= 500 ? "unavailable" : "monitor-error") &&
        error.message.includes(`HTTP ${status}`) &&
        !error.message.includes(token),
    );
  });
}

test("refuses invalid origin and missing credentials before requesting", async () => {
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
    await assert.rejects(
      checkBackend(invalid, token, unexpected),
      /HTTPS origin/,
    );
  await assert.rejects(
    checkBackend(origin, "", unexpected),
    /MONITOR_TOKEN is required/,
  );
});

test("network errors and malformed bodies fail without leaking upstream text", async () => {
  await assert.rejects(
    checkBackend(origin, token, (async () => {
      throw new Error(token);
    }) as typeof fetch),
    (error: MonitorError) =>
      error.kind === "unavailable" && !error.message.includes(token),
  );
  for (const status of [200, 503])
    await assert.rejects(
      checkBackend(
        origin,
        token,
        (async () =>
          new Response(`<html>${token}</html>`, { status })) as typeof fetch,
      ),
      (error: MonitorError) =>
        error.kind === (status === 503 ? "unavailable" : "monitor-error") &&
        /invalid or incomplete/.test(error.message) &&
        !error.message.includes(token),
    );
});

test("CLI exit codes, annotations and summaries distinguish healthy, degraded and failed checks", () => {
  const dir = mkdtempSync(join(tmpdir(), "bluebird-watchdog-"));
  try {
    writeFileSync(
      join(dir, "watchdog.ts"),
      readFileSync(new URL("../../scripts/watchdog.ts", import.meta.url)),
    );
    writeFileSync(
      join(dir, "mock.mjs"),
      "globalThis.fetch = async () => new Response(process.env.TEST_HEALTH, { status: Number(process.env.TEST_STATUS) });",
    );
    const cases = [
      {
        status: 200,
        body: JSON.stringify(health({ sources: [token] })),
        kind: "healthy",
        exit: 0,
      },
      {
        status: 503,
        body: JSON.stringify(
          health({
            ok: false,
            checks: { ...checks, sources: false, deadLetters: false },
            sources: [token],
          }),
        ),
        kind: "degraded",
        exit: 0,
      },
      {
        status: 503,
        body: `<html>${token}</html>`,
        kind: "unavailable",
        exit: 1,
      },
      { status: 401, body: token, kind: "monitor-error", exit: 1 },
      {
        status: 200,
        body: JSON.stringify(health({ ok: false })),
        kind: "monitor-error",
        exit: 1,
      },
      {
        status: 503,
        body: JSON.stringify(
          health({ ok: false, checks: { ...checks, [token]: false } }),
        ),
        kind: "monitor-error",
        exit: 1,
      },
    ];
    for (const fixture of cases) {
      const summary = join(dir, "summary.md");
      writeFileSync(summary, "");
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
            TEST_HEALTH: fixture.body,
            TEST_STATUS: String(fixture.status),
            GITHUB_ACTIONS: "true",
            GITHUB_STEP_SUMMARY: summary,
          },
        },
      );
      assert.equal(result.status, fixture.exit, result.stderr);
      assert.equal(
        JSON.parse(result.stdout.split("\n")[0]).status,
        fixture.kind,
      );
      const text = readFileSync(summary, "utf8");
      assert.ok(!`${result.stdout}${result.stderr}${text}`.includes(token));
      if (fixture.kind === "degraded") {
        assert.match(result.stdout, /::warning title=BlueBird degraded::/);
        assert.match(
          text,
          /\*\*sources\*\*: One or more news sources are overdue/,
        );
        assert.match(text, /\*\*deadLetters\*\*: News imports/);
        assert.match(text, /does not verify that those emails were delivered/);
      } else if (fixture.exit)
        assert.match(result.stdout, /::error title=BlueBird /);
      else
        assert.ok(
          !result.stdout.includes("::warning") &&
            !result.stdout.includes("::error"),
        );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
