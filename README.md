# BlueBird availability monitor

Independent 15-minute health checks for the BlueBird Spotter backend. This repository contains only the watchdog, its tests and GitHub workflows. It does not contain the application, catalogue, infrastructure access or secrets.

Standard GitHub-hosted runners are free in public repositories. Workflow results and sanitized health-check outcomes are public. The monitor reads the authenticated health endpoint; it cannot write articles or deploy Workers. GitHub workflow-failure notifications are the alert path when Cloudflare is unavailable.

## Setup

Create main-only staging and production environments, each with its own MONITOR_TOKEN secret. Keep workflow permissions read-only and require approval for outside-contributor workflows. Enable failure email in the maintainer's GitHub Actions notification settings. Manually dispatch staging to verify the failure notification; only set the repository variable PRODUCTION_LIVE=true after production cutover. The private backend operations workflow remains responsible for backups and billing collection. Disable its recurring watchdog only after this monitor is verified.

Run `node --test tests/scripts/watchdog.test.ts` with the Node version in `.node-version`.

## Operation

Check workflow activity monthly and during every release. GitHub can delay or skip scheduled runs; schedules are not an availability SLA. Public-repository schedules are disabled after 60 days without repository activity. Complete real maintenance/review and re-enable the workflow if GitHub disables it; do not assume that successful scheduled runs keep the repository active. Review dependency/security changes regularly. No self-writing keepalive commits are configured.

References: [runner billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [schedule limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
