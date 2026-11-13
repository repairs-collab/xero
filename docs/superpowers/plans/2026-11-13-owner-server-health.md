# Owner Server Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, owner-only OVH server health HUD to AccountPulse.

**Architecture:** A host timer writes a sanitized JSON snapshot to an atomic file. The web container receives only that directory as a read-only mount; an owner-authorized page parses, grades, and displays the snapshot without exposing a shell, Docker socket, secrets, or host paths.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Bash/systemd, Docker Compose

**Spec:** `docs/superpowers/specs/2026-11-13-owner-server-health-design.md`

## Global Constraints

- The feature is visible only in `/platform-admin` to the platform `OWNER` role.
- The web app must remain read-only and must not receive a Docker socket or command-execution capability.
- The snapshot and UI must never expose credentials, environment values, host paths, IPs, command lines, or customer data.
- Missing or stale data must fail closed to an explicit unavailable state.
- No deployment, push, merge, paid service, or live mutation is part of this plan.

## Review Focus

- A malformed or oversized snapshot must render unavailable, not crash the owner page.
- A snapshot containing extra secret-looking fields must not render them.
- A stale snapshot must not look healthy.
- A non-owner must not gain a new route around the existing owner authorization boundary.
- Optional/unknown containers must not alter the fixed core-service health decision.

---

### Task 1: Snapshot reader and health grading

**Files:**
- Create: `apps/web/src/server/server-health.ts`
- Create: `apps/web/src/server/server-health.test.ts`

**Interfaces:**
- Produces: `loadServerHealthSnapshot(options?)` and `evaluateServerHealth(snapshot, now)` returning a sanitized owner-safe view model.

- [ ] Write failing tests for valid parsing, warning/critical thresholds, stale data, malformed data, extra fields, and unapproved services.
- [ ] Run the focused test and confirm failures are caused by the missing module.
- [ ] Implement the smallest strict reader and evaluator that satisfies the tests.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Owner page and presentation

**Files:**
- Create: `apps/web/src/components/platform-admin/server-health-hud.tsx`
- Create: `apps/web/src/components/platform-admin/server-health-hud.test.tsx`
- Create: `apps/web/src/app/platform-admin/system/page.tsx`
- Create: `apps/web/src/app/platform-admin/system/page.test.tsx`
- Modify: `apps/web/src/components/platform-admin-shell.tsx`
- Modify: `apps/web/src/components/platform-admin-shell.test.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: owner-safe view model from Task 1.
- Produces: `/platform-admin/system`, authorized through `requirePlatformOwnerPage('/platform-admin/system')`.

- [ ] Write failing tests for owner authorization, explicit healthy/warning/critical/unavailable presentation, safe fields, and owner navigation.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement the page, component, navigation item, and responsive styles.
- [ ] Run focused tests and confirm they pass.

### Task 3: OVH collector and read-only deployment wiring

**Files:**
- Create: `deploy/ovh/collect-server-health.sh`
- Create: `deploy/ovh/accountpulse-server-health.service`
- Create: `deploy/ovh/accountpulse-server-health.timer`
- Create: `deploy/ovh/install-server-health-monitor.sh`
- Modify: `deploy/ovh/docker-compose.yml`
- Modify: `deploy/ovh/env.example`
- Modify: `infra/test/deployment-workflow.test.ts`
- Modify: `docs/runbooks/deployment.md`

**Interfaces:**
- Produces: schema-version-1 snapshot at the protected host path and read-only web-container mount.

- [ ] Write a failing deployment-contract test proving the web container receives only the snapshot directory read-only and never the Docker socket.
- [ ] Run the focused infrastructure test and confirm the failure.
- [ ] Add the collector, timer, installer, Compose wiring, environment default, and runbook instructions.
- [ ] Run focused tests, web typecheck, scoped lint, and the relevant full unit suite.
- [ ] Commit only the files listed in this plan.

