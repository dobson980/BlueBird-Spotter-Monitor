# BlueBird availability monitor

Independent health checks for the BlueBird Spotter backend, scheduled every 15 minutes. This repository contains only the watchdog, its tests and GitHub workflows. It does not contain the application, catalogue, infrastructure access or secrets.

Standard GitHub-hosted runners are free in public repositories. Workflow results and sanitized health-check outcomes are public. The monitor reads the authenticated health endpoint; it cannot write articles or deploy Workers. GitHub workflow-failure notifications are the alert path for unreachable endpoints and monitor failures. Data and operational warnings are reported separately as described below.

## Setup

Create main-only staging and production environments, each with its own MONITOR_TOKEN secret. Keep workflow permissions read-only and require approval for outside-contributor workflows. Enable failure email in the maintainer's GitHub Actions notification settings. Only set the repository variable PRODUCTION_LIVE=true after production cutover. Cloudflare now owns scheduled backups and billing collection; the private backend retains an explicit operations fallback. This external monitor remains independent so it can detect failures outside Cloudflare.

Run `node --test tests/scripts/watchdog.test.ts` with the Node version in `.node-version`.

## Reading a run

| Result | Meaning | GitHub outcome |
|---|---|---|
| Healthy | HTTP 200 with a complete, coherent health response and all checks passing | Success |
| Reachable, health warnings | HTTP 503 with the recognized health response and known failing data/operational checks | Success with warning annotation and job summary |
| Unavailable | Network/TLS/redirect/timeout failure, unexpected HTTP 5xx, or HTTP 503 without readable health JSON | Failure with error annotation and summary |
| Monitor error | Missing credentials, HTTP 401/403/429 or another unexpected non-5xx response, incomplete/contradictory health contract, or an unknown failing check | Failure with error annotation and summary |

HTTP 503 alone does not establish an outage: the backend deliberately returns it when any health check is false. Only a complete, consistent 503 response can be classified as degraded. All ten known checks must be present and Boolean; a new failing check requires a monitor update rather than being silently downgraded. This is a health-endpoint assessment, not an end-to-end test of every app route.

Open a run's summary to see the failed aggregate names and explanations: quotes, orbits, backups, operations, sources, usageCollection, usage70, usage90, budget and deadLetters. For example, `sources, deadLetters` means overdue news sources and unresolved news imports/recovery. Open the corresponding BlueBird admin Health and Operations views for private details and recovery steps. Only fixed descriptions and recognized aggregate names are published; raw health bodies, source data, tokens and arbitrary upstream error messages stay out of logs, summaries and annotations.

Degraded runs do **not** trigger GitHub workflow-failure email. Cloudflare's existing incident/recovery emails still handle these warnings, with sustained-incident reminders; this monitor does not verify mail delivery. Outage/monitor-error runs still fail and use GitHub's enabled failure notifications. GitHub controls the email template; the linked run provides the detailed reason. Keep warning delivery configured in Cloudflare and review its Health view instead of treating a green Actions badge as proof that all data is fresh.

The October 22, 2026 update pins patched Node **24.22.1**, classifies degraded health separately, and adds sanitized summaries/annotations. Local classification and CLI tests cover all known warnings, transport/status failures, invalid schemas and redaction. The merge skips push/PR CI to respect the owner's exhausted private allowance. The public `ubuntu-slim` schedule and any explicit acceptance run use free standard runners; no private backend workflow or production deployment is needed.

## Operation

Check workflow activity monthly and during every release. GitHub can delay or skip scheduled runs; schedules are not an availability SLA. Public-repository schedules are disabled after 60 days without repository activity. Complete real maintenance/review and re-enable the workflow if GitHub disables it; do not assume that successful scheduled runs keep the repository active. Review dependency/security changes regularly. No self-writing keepalive commits are configured.

References: [runner billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [schedule limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
