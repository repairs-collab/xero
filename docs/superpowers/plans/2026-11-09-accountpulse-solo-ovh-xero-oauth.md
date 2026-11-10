# AccountPulse Solo Commercial Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a working self-service AccountPulse Solo customer journey on OVH: secure signup, standard Xero OAuth, tenant provisioning, 14-day preview, Stripe subscription management, guided onboarding and safe customer-live eligibility, while preserving the live Motts organisation and its existing Custom Connection until a separately approved cutover.

**Architecture:** The Next.js web app, worker, PostgreSQL, job queue, Caddy and voice services run on OVH. Cognito remains the only AWS runtime dependency and provides self-service identity through its hosted signup/login flow. A new standard Xero OAuth app supplies rotating refresh tokens; only AES-256-GCM-encrypted refresh tokens are stored, while access tokens remain in process memory. Each job resolves a Xero client for its `organisationId`, and each Xero webhook resolves its AccountPulse organisation from the event's Xero tenant ID. Stripe Checkout, Billing Portal and signed webhooks are the source of subscription state. A versioned entitlement service gates every customer send. The existing Custom Connection and an `INTERNAL_LEGACY` entitlement remain explicit Motts fallbacks during migration.

**Tech Stack:** TypeScript 6, Node.js 24, Next.js, PostgreSQL 17, Drizzle ORM, Vitest, Playwright, Docker Compose, Caddy, GitHub Actions, Xero OAuth 2.0, Stripe Billing, AWS Cognito (identity only)

**Spec:** [2026-11-09-accountpulse-solo-xero-app-store-design.md](../specs/2026-11-09-accountpulse-solo-xero-app-store-design.md)

**Certification register:** `C:\Users\repai\Documents\Codex\2026-11-09\referenced-chatgpt-conversation-this-is-an\outputs\AccountPulse-Xero-Readiness.md` is maintained by the separate readiness workstream. This implementation produces its evidence but does not edit that register.

## Global Constraints

- Start from deployed runtime commit `82294bb`, whose parent tree is the same as GitHub `main` merge `2007278` but which adds the 44-file native VoIPcloud/runtime change set. Record this reconciliation in the ledger and pull request; do not regress to local `main` (`0dde9b3`) or the older `2007278` tree.
- Preserve every existing production record, the Motts `CUSTOMER` rollout scope, live sending state, sequences, approvals, messages and voice configuration. This plan contains no reset, reseed or destructive migration.
- Do not deploy the web app, worker, PostgreSQL, queue or platform secrets to AWS. Retain only Cognito as an external AWS identity service, and use its hosted self-signup flow so OVH does not require broad AWS infrastructure credentials.
- Do not delete or disable the Motts Custom Connection until OAuth sync reconciliation has passed and the owner separately approves cutover.
- Never persist Xero access tokens. Persist refresh tokens only in versioned AES-256-GCM envelopes and never log OAuth codes, tokens, client secrets, encryption keys or decrypted token material.
- A Xero tenant ID may belong to only one AccountPulse organisation. Every Xero job and webhook must resolve its organisation explicitly; no `memberships[0]`, first-row or single-organisation fallback is allowed in Xero runtime paths.
- Keep standard OAuth and legacy Custom Connection authentication behind the same `XeroClientFactory` interface. OAuth is preferred; legacy is an explicit fallback only.
- Use the exact OAuth scopes `openid profile email offline_access accounting.invoices accounting.contacts.read accounting.settings.read`.
- Maintain test-first development: add a focused failing test, run it to prove the failure, implement the minimum change, rerun it, then run the affected package tests before committing.
- The commercial flow is account-first for security and operability: **Start free trial → Cognito hosted signup/login → Xero OAuth → trial workspace and sync → Stripe subscription → onboarding completion**. It remains fully self-service and avoids storing Cognito administration credentials on OVH.
- A Stripe checkout redirect never activates service. Only a verified, idempotently processed Stripe webhook may change subscription entitlements.
- New Solo organisations start controlled and non-live. Payment cannot publish historical reminders, enable automatic sequences, or bypass the existing approval and pre-send checks.
- Existing organisations receive `INTERNAL_LEGACY` explicitly and remain outside Solo billing, seat, trial and SMS limits.
- When an unconverted trial expires, or a cancelled subscription reaches its actual end date, AccountPulse must call Xero's connection deletion endpoint and mark the local connection disconnected. Token expiry alone is not disconnection. Revocation from Xero, reconnect and explicit customer disconnect must be tested.
- Account-first Cognito onboarding is the chosen application flow, but it is not by itself evidence of compliance with the Xero commercial terms. Public listing remains gated on a supported **Sign Up with Xero** path or written Xero confirmation that AccountPulse has an exception.

## Confirmed public URL contract

The owner confirmed `ap.motts.com.au` as the AccountPulse commercial origin on 2026-11-09. The implementation and readiness workstreams use this non-secret contract consistently:

- Website: `https://ap.motts.com.au`
- Xero OAuth redirect: `https://ap.motts.com.au/xero/callback`
- Launcher/login URL: `https://ap.motts.com.au/start`
- Direct signup URL: `https://ap.motts.com.au/auth/login?mode=signup&returnTo=%2Fonboarding`
- Xero webhook URL: `https://ap.motts.com.au/api/webhooks/xero`

These values are configuration, not hard-coded runtime constants. DNS, TLS, Cognito callback registration, Stripe return URLs and the OVH reverse-proxy host must all be verified before beta deployment. The existing `billchaser.motts.com.au` Motts origin remains unchanged until a separately approved cutover.

## Review Focus

- Tenant isolation and webhook tenant routing
- Refresh-token rotation under concurrent workers
- No access-token persistence or secret leakage
- Compatibility of all existing Xero sync, email reminder and payment-link behaviour
- OVH release rollback, database backup and immutable image promotion
- Zero change to Motts sending status or customer communications
- Subscription webhook ordering, idempotency and fail-closed status mapping
- Self-service provisioning replay protection and no silent account linking by email
- Trial/subscription/onboarding gates on every outbound path

---

## Task 1: Establish the OVH runtime contract

**Files:**

- Modify: `deploy/ovh/docker-compose.yml`
- Create: `deploy/ovh/env.example`
- Modify: `.env.example`
- Modify: `apps/worker/tests/ovh-deployment.test.ts`

- [ ] Add a failing OVH deployment test proving the application containers do not receive `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, AWS Secrets Manager ARNs or ECR image references.
- [ ] Add failing assertions that both `web` and `worker` receive `XERO_OAUTH_CLIENT_ID`, `XERO_OAUTH_CLIENT_SECRET`, `XERO_OAUTH_REDIRECT_URI`, `XERO_TOKEN_ENCRYPTION_KEYS_JSON` and `XERO_TOKEN_ACTIVE_KEY_ID`; that the web container receives Stripe and Cognito browser configuration; and that the worker receives only the provider values needed for delivery.
- [ ] Run `pnpm vitest run apps/worker/tests/ovh-deployment.test.ts` and confirm the new assertions fail against the current Compose file.
- [ ] Update `deploy/ovh/docker-compose.yml` so OVH environment variables are the source of application secrets, remove AWS access-key injection, keep Cognito issuer/client/domain values, and preserve all existing voice safety defaults.
- [ ] Create `deploy/ovh/env.example` with names, safe placeholders and comments for OVH paths, database credentials, Cognito, Xero OAuth, Sinch, webhook verification, session encryption and voice configuration. Do not include real values.
- [ ] Update the root `.env.example` to distinguish local development values from OVH production values and replace `XERO_SECRET_ARN`/`SINCH_SECRET_ARN` examples with hosting-neutral environment references.
- [ ] Run `pnpm vitest run apps/worker/tests/ovh-deployment.test.ts` and confirm it passes.
- [ ] Run `docker compose -f deploy/ovh/docker-compose.yml --env-file deploy/ovh/env.example config --quiet` with documented test placeholders and confirm the file resolves.
- [ ] Commit with `git commit -m "chore: make OVH the AccountPulse runtime contract"`.

## Task 2: Replace the AWS application deployment with an OVH release pipeline

**Files:**

- Modify: `.github/workflows/deploy.yml`
- Create: `deploy/ovh/release.sh`
- Create: `deploy/ovh/rollback.sh`
- Create: `apps/worker/tests/ovh-release.test.ts`
- Modify: `docs/runbooks/deployment.md`

- [ ] Add a failing release test that asserts the primary workflow contains no CDK, CloudFormation, ECS, ECR, RDS or AWS deploy-role steps and does contain immutable SHA image build, staging approval, production approval, OVH transfer, migration, smoke-test and rollback metadata steps.
- [ ] Add a failing test for `release.sh` requiring an exclusive release lock, a pre-migration `pg_dump`, immutable image names, a migration container, health checks and automatic restoration of the previous Compose image values when health checks fail.
- [ ] Run `pnpm vitest run apps/worker/tests/ovh-release.test.ts` and confirm both tests fail.
- [ ] Rewrite `.github/workflows/deploy.yml` to build and test once, export SHA-tagged web and worker images, deploy the same artifacts to the protected `staging` GitHub environment, then promote the same artifacts to the protected `production` environment.
- [ ] Use GitHub environment secrets/variables named `OVH_HOST`, `OVH_PORT`, `OVH_USER`, `OVH_SSH_PRIVATE_KEY`, `OVH_SSH_HOST_KEY`, `OVH_DEPLOY_PATH` and `HOSTNAME`; install the pinned host key before any SSH or transfer action.
- [ ] Implement `deploy/ovh/release.sh` to validate the target directory, take a non-blocking `flock`, save the previous release manifest, back up PostgreSQL, load the exact SHA images, run `worker.mjs migrate`, start the updated services, test `/health/ready`, and restore the previous manifest if startup or health verification fails.
- [ ] Implement `deploy/ovh/rollback.sh` to select a recorded release, refuse unknown paths or mutable tags, preserve the database, restore the previous image manifest and run the same health check.
- [ ] Rewrite `docs/runbooks/deployment.md` around OVH staging/production, GitHub environment approvals, backup locations, release evidence, rollback and Cognito's limited external role. State that decommissioning old AWS app resources is a separate, evidence-led task.
- [ ] Run `pnpm vitest run apps/worker/tests/ovh-release.test.ts apps/worker/tests/ovh-deployment.test.ts`.
- [ ] Run `pnpm lint` on the changed files and validate the workflow YAML with the repository's normal CI parser.
- [ ] Commit with `git commit -m "ci: deploy AccountPulse application releases to OVH"`.

## Task 3: Add tenant-aware Xero OAuth persistence

**Files:**

- Create: `packages/db/src/schema/xero.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/drizzle/0013_accountpulse_xero_oauth.sql`
- Create/Modify: `packages/db/drizzle/meta/0013_snapshot.json`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/src/schema/schema.integration.test.ts`

- [ ] Add failing schema tests for `xero_oauth_transactions`, `xero_pending_authorisations` and `xero_connections`.
- [ ] Assert that `xero_connections.organisation_id` and `xero_connections.tenant_id` are independently unique, status is constrained to `CONNECTED`, `REAUTH_REQUIRED` or `DISCONNECTED`, and an OAuth connection cannot exist without encrypted refresh-token material and granted scopes.
- [ ] Assert that OAuth transactions store only a SHA-256 state hash, user binding, optional existing-organisation binding, flow purpose (`NEW_SOLO` or `CONNECT_EXISTING`), return path, expiry and consumed timestamp; raw state and authorization codes must have no columns.
- [ ] Assert that pending authorisations contain encrypted refresh-token material, candidate tenants, scopes, user binding, optional existing-organisation binding, flow purpose and a short expiry, but no access-token column.
- [ ] Add refresh-lease columns `refresh_lease_id` and `refresh_lease_expires_at` to `xero_connections` so token rotation can be serialized across worker processes without holding a database transaction open during a network request.
- [ ] Run `pnpm vitest run --project integration packages/db/src/schema/schema.integration.test.ts` and confirm the new tests fail.
- [ ] Implement the three Drizzle tables in `packages/db/src/schema/xero.ts` with foreign keys, indexes, uniqueness and check constraints, then export them from `schema/index.ts`.
- [ ] Generate the migration with `pnpm db:generate`, rename the generated SQL/tag to `0013_accountpulse_xero_oauth`, and inspect both up migration and snapshot for non-destructive changes only.
- [ ] Run `pnpm vitest run --project integration packages/db/src/schema/schema.integration.test.ts` and confirm all schema tests pass.
- [ ] Commit with `git commit -m "feat: add Xero OAuth tenant persistence"`.

## Task 4: Implement refresh-token envelope encryption

**Files:**

- Create: `packages/integrations/src/xero/token-encryption.ts`
- Create: `packages/integrations/src/xero/token-encryption.test.ts`
- Modify: `packages/integrations/src/xero/index.ts`

- [ ] Write failing tests for an `AesGcmTokenCipher` that encrypts and decrypts with a 32-byte active key, embeds `version`, `keyId`, `iv`, `ciphertext` and `tag`, and produces different ciphertext for the same token on repeated encryption.
- [ ] Add failing tests for unknown key IDs, malformed base64, modified ciphertext/tag, keys of the wrong size and plaintext/ciphertext appearing in thrown errors.
- [ ] Run `pnpm vitest run packages/integrations/src/xero/token-encryption.test.ts` and confirm failure.
- [ ] Implement `AesGcmTokenCipher.fromEnvironment({ keysJson, activeKeyId })` using Node `crypto` AES-256-GCM and strict base64/length validation.
- [ ] Export `TokenCipher` and `EncryptedTokenEnvelope` interfaces plus the implementation through `packages/integrations/src/xero/index.ts`.
- [ ] Rerun the focused test, then `pnpm vitest run packages/integrations/src/xero`.
- [ ] Commit with `git commit -m "feat: encrypt stored Xero refresh tokens"`.

## Task 5: Implement the standard Xero OAuth protocol client

**Files:**

- Create: `packages/integrations/src/xero/oauth.ts`
- Create: `packages/integrations/src/xero/oauth.test.ts`
- Modify: `packages/integrations/src/xero/token-cache.ts`
- Modify: `packages/integrations/src/xero/token-cache.test.ts`
- Modify: `packages/integrations/src/xero/index.ts`

- [ ] Add failing tests for `XeroOAuthClient.createAuthorizationUrl(state)` using the exact standard OAuth scopes, response type `code`, configured redirect URI and an unmodified state value.
- [ ] Add failing tests for `exchangeAuthorizationCode`, `refreshAccessToken`, `listConnections` and `deleteConnection`, covering Basic client authentication, rotating refresh tokens, tenant-specific connection deletion, malformed responses, `invalid_grant`, missing `offline_access`, timeouts and non-2xx responses.
- [ ] Define `XeroOAuthTokens` with `accessToken`, `refreshToken`, `expiresInSeconds`, `scopes` and optional identity-token metadata; do not add persistence methods to this client.
- [ ] Run `pnpm vitest run packages/integrations/src/xero/oauth.test.ts` and confirm the tests fail.
- [ ] Implement the protocol client against `https://identity.xero.com/connect/authorize`, `https://identity.xero.com/connect/token` and `https://api.xero.com/connections` using the existing `HttpClient` abstraction.
- [ ] Keep `XeroClientCredentialsTokenIssuer` and its tests as the named legacy Custom Connection implementation, but split `requiredXeroOAuthScopes` from `requiredLegacyXeroScopes` so neither flow silently accepts the other's grant.
- [ ] Run `pnpm vitest run packages/integrations/src/xero/oauth.test.ts packages/integrations/src/xero/token-cache.test.ts`.
- [ ] Commit with `git commit -m "feat: add standard Xero OAuth protocol support"`.

## Task 6: Add the Xero connection repository and refresh leases

**Files:**

- Create: `packages/db/src/repositories/xero-connection-repository.ts`
- Create: `packages/db/src/repositories/xero-connection-repository.integration.test.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/web.ts`

- [ ] Write failing integration tests for creating and consuming a hashed OAuth transaction exactly once, including wrong user, wrong organisation, expired state and replay attempts.
- [ ] Write failing tests for creating an expiring pending authorisation, listing candidate tenants, finalising the chosen tenant idempotently, rejecting a tenant already owned by another organisation, and deleting pending token material after finalisation.
- [ ] Write failing tests for `findByOrganisationId`, `findOrganisationIdByTenantId`, disconnect/reconnect, and status changes to `REAUTH_REQUIRED` without exposing decrypted token data.
- [ ] Write a two-client concurrency test proving only one unexpired refresh lease can be acquired and proving completion/release requires the matching lease ID.
- [ ] Run `pnpm vitest run --project integration packages/db/src/repositories/xero-connection-repository.integration.test.ts` and confirm failure.
- [ ] Implement `PostgresXeroConnectionRepository` with the tested atomic operations. Use conditional `UPDATE ... RETURNING` for leases; never use an in-memory mutex as the cross-process guarantee.
- [ ] Export the repository through the regular and web database entry points.
- [ ] Rerun the focused integration test and then all `packages/db` integration tests.
- [ ] Commit with `git commit -m "feat: manage Xero OAuth connections safely"`.

## Task 7: Build a rotating, memory-only Xero OAuth session provider

**Files:**

- Create: `packages/integrations/src/xero/session-provider.ts`
- Create: `packages/integrations/src/xero/session-provider.test.ts`
- Modify: `packages/integrations/src/xero/index.ts`

- [ ] Define `XeroAuthorisedSession` as `{ accessToken: string; tenantId: string | null }` and `XeroSessionProvider.getSession(): Promise<XeroAuthorisedSession>`.
- [ ] Write failing tests that cache access tokens only in memory until 60 seconds before expiry, decrypt the current refresh token only when refreshing, store only the newly encrypted rotating refresh token, and never pass access tokens to store methods.
- [ ] Write failing concurrent-provider tests in which one provider acquires the database lease and the other waits for the stored token version to change rather than submitting the old refresh token twice.
- [ ] Add failing recovery tests for an expired lease, `invalid_grant` marking the connection `REAUTH_REQUIRED`, bounded wait timeout, and lease release after transient provider failure.
- [ ] Run `pnpm vitest run packages/integrations/src/xero/session-provider.test.ts` and confirm failure.
- [ ] Implement `XeroOAuthSessionProvider`, a small abstract `XeroRefreshTokenStore` interface satisfied by `PostgresXeroConnectionRepository`, and `LegacyXeroSessionProvider` wrapping the existing `XeroTokenCache` with `tenantId: null`.
- [ ] Rerun the focused test and all Xero integration-package tests.
- [ ] Commit with `git commit -m "feat: rotate Xero OAuth sessions safely"`.

## Task 8: Make the Xero API client tenant-aware

**Files:**

- Modify: `packages/integrations/src/xero/client.ts`
- Modify: `packages/integrations/src/xero/client.test.ts`
- Modify: `packages/integrations/src/xero/token-cache.test.ts`

- [ ] Replace the test fixture's `XeroTokenProvider` with `XeroSessionProvider` and add a failing test proving an OAuth session adds the exact `Xero-Tenant-Id` header to every Accounting API request.
- [ ] Preserve and rerun the existing failing/passing assertion that a legacy Custom Connection sends no tenant header.
- [ ] Add a failing test proving request-specific headers cannot overwrite `Authorization` or `Xero-Tenant-Id`.
- [ ] Run `pnpm vitest run packages/integrations/src/xero/client.test.ts` and confirm the OAuth/header-protection tests fail.
- [ ] Update `XeroClient` to obtain one authorised session per request and place protected authentication headers after caller-supplied conditional headers.
- [ ] Run all `packages/integrations/src/xero` tests and `pnpm --filter @bc5000/integrations typecheck`.
- [ ] Commit with `git commit -m "feat: route Xero API calls by tenant"`.

## Task 9: Add authenticated Xero connect, tenant selection and disconnect flows

**Files:**

- Create: `apps/web/src/server/xero-oauth-service.ts`
- Create: `apps/web/src/app/xero/connect/route.ts`
- Create: `apps/web/src/app/xero/callback/route.ts`
- Create: `apps/web/src/app/(protected)/settings/integrations/xero/select/page.tsx`
- Create: `apps/web/src/app/(protected)/settings/integrations/xero/select/actions.ts`
- Modify: `apps/web/src/app/(protected)/settings/integrations/actions.ts`
- Modify: `apps/web/src/app/(protected)/settings/integrations/integration-settings.ts`
- Modify: `apps/web/src/app/(protected)/settings/integrations/page.tsx`
- Modify: `apps/web/src/server/runtime.ts`
- Create: `apps/web/tests/xero-oauth.integration.test.ts`
- Modify: `apps/web/tests/integration-settings.integration.test.ts`

- [ ] Write failing tests proving only an active Admin membership can start, finalise or disconnect a Xero connection.
- [ ] Test that connect stores only a SHA-256 state hash bound to the session user and organisation, and redirects to Xero with the required scopes.
- [ ] Test callback failures for state mismatch, replay, expiry, wrong user, denied consent, malformed tokens, missing scopes and no Xero tenants.
- [ ] Test the single-candidate path finalises immediately; the multiple-candidate path stores an encrypted short-lived pending authorisation and renders a tenant-selection page without exposing token material.
- [ ] Test tenant selection rejects a tenant owned by another AccountPulse organisation and shows the existing Solo organisation plus an Enterprise waitlist message rather than creating a second Solo organisation.
- [ ] Test repeat delivery of the same consumed authorization event and same tenant is idempotent.
- [ ] Run `pnpm vitest run --project integration apps/web/tests/xero-oauth.integration.test.ts apps/web/tests/integration-settings.integration.test.ts` and confirm failure.
- [ ] Add `getXeroOAuthConfiguration()` and `getXeroTokenCipher()` to `apps/web/src/server/runtime.ts`, with strict startup validation and no default production credentials.
- [ ] Implement the route/service flow, storing refresh tokens only through `TokenCipher` and `PostgresXeroConnectionRepository`; discard access tokens after the `/connections` lookup.
- [ ] Replace the Xero Secrets Manager ARN form with Connect/Reconnect/Disconnect controls and connection health. Leave the existing Sinch configuration unchanged for this phase.
- [ ] Audit `XERO_CONNECTED`, `XERO_RECONNECTED`, `XERO_TENANT_SELECTED`, `XERO_DISCONNECTED` and rejected tenant-conflict events without token or code values.
- [ ] Rerun the focused tests, then all web integration tests and `pnpm --filter @bc5000/web typecheck`.
- [ ] Commit with `git commit -m "feat: connect AccountPulse organisations to Xero"`.

## Task 10: Resolve a Xero client per organisation in the worker

**Files:**

- Create: `apps/worker/src/xero-client-factory.ts`
- Create: `apps/worker/src/xero-client-factory.test.ts`
- Modify: `apps/worker/src/entrypoint.ts`
- Modify: `apps/worker/src/runtime-config.ts`
- Modify: `apps/worker/src/runtime-config.test.ts`
- Modify: `apps/worker/tests/xero-sync.integration.test.ts`
- Modify: `apps/worker/tests/provider-connection-test.integration.test.ts`

- [ ] Write failing factory tests proving OAuth is preferred for an organisation with an active OAuth connection, a Motts-style legacy `provider_connections` record uses the Custom Connection fallback, and an organisation with neither returns `XERO_CONNECTION_REQUIRED`.
- [ ] Add a failing test proving two organisation IDs receive different tenant IDs and refresh-token records even when jobs run concurrently.
- [ ] Add failing runtime tests making `XERO_OAUTH_CLIENT_ID`, `XERO_OAUTH_CLIENT_SECRET`, encryption keys and active key mandatory, while `XERO_API_CREDENTIALS` is optional and parsed only for legacy organisations.
- [ ] Run the focused worker tests and confirm failure.
- [ ] Implement `OrganisationXeroClientFactory.forOrganisation(organisationId)` using `PostgresXeroConnectionRepository`, `XeroOAuthSessionProvider` and the legacy token cache.
- [ ] Change every Xero-dependent worker registration—initial sync, incremental sync, invoice refresh, nightly reconciliation, reminder calculation, reminder execution and provider test—to resolve the client from the payload's `organisationId` before invoking the handler.
- [ ] Do not change handler business logic or send-mode checks; only change Xero dependency construction.
- [ ] Run the focused tests, all Xero sync/reminder worker integration tests, and `pnpm --filter @bc5000/worker typecheck`.
- [ ] Commit with `git commit -m "feat: isolate Xero clients by AccountPulse organisation"`.

## Task 11: Route Xero webhooks by tenant ID

**Files:**

- Modify: `packages/integrations/src/xero/webhook.ts`
- Modify: `packages/integrations/src/xero/webhook.test.ts`
- Modify: `apps/web/src/server/webhook-handlers.ts`
- Modify: `apps/web/src/server/webhook-runtime.ts`
- Modify: `apps/web/src/app/api/webhooks/xero/route.ts`
- Modify: `apps/web/tests/webhooks.integration.test.ts`

- [ ] Add failing parser tests requiring a `tenantId` on accepted Xero events while preserving an empty signed intent-to-receive payload.
- [ ] Add failing handler tests with events for two tenants in one payload and assert that each is recorded/queued under the matching AccountPulse organisation.
- [ ] Add failing tests proving an unknown tenant is safely ignored and reported without returning a non-2xx response that would cause Xero to disable the webhook.
- [ ] Add a failing test proving Xero webhook routing never reads `WEBHOOK_ORGANISATION_ID` or falls back to the first organisation.
- [ ] Run `pnpm vitest run packages/integrations/src/xero/webhook.test.ts` and the focused web webhook integration test; confirm failure.
- [ ] Add tenant IDs to parsed events, resolve them through `PostgresXeroConnectionRepository.findOrganisationIdByTenantId`, and enqueue each accepted event with a tenant-specific singleton key.
- [ ] Keep the app-level Xero webhook key and HMAC verification unchanged. Keep Sinch and voice webhook routing unchanged in this phase.
- [ ] Rerun the focused tests, all webhook tests and web typecheck.
- [ ] Commit with `git commit -m "feat: route Xero webhooks to the correct tenant"`.

## Task 12: Add a non-destructive Motts OAuth cutover rehearsal

**Files:**

- Create: `apps/worker/src/operations/xero-oauth-readiness.ts`
- Create: `apps/worker/src/operations/xero-oauth-readiness.test.ts`
- Modify: `apps/worker/src/entrypoint.ts`
- Create: `docs/runbooks/xero-oauth-cutover.md`

- [ ] Write failing tests for `xero-oauth-readiness --organisation-id <id>` that report legacy connection presence, OAuth connection status, tenant match, required scopes, last successful sync, reconciliation status and invoice totals without changing data.
- [ ] Add a failing test proving the command never changes `sendMode`, `rolloutScope`, `liveSendAcknowledged`, sequences, approvals, messages or connection enablement.
- [ ] Run the focused readiness test and confirm failure.
- [ ] Implement the read-only command and JSON/human-readable report with no secret/token fields.
- [ ] Document the Motts cutover: create the new standard Xero app credentials, configure redirect/webhook URLs, connect as Admin, run initial sync, compare invoice count and amount, run readiness, wait through one token refresh, confirm webhook delivery, then request separate approval before disabling the legacy provider record.
- [ ] State explicitly that disconnecting Xero is reversible, but deleting legacy credentials or changing live sending is outside this command.
- [ ] Rerun the readiness test and the existing operational reset/sending safeguard tests.
- [ ] Commit with `git commit -m "feat: rehearse Xero OAuth cutover without production changes"`.

## Task 13: Support self-service Cognito identities before organisation creation

**Files:**

- Modify: `packages/auth/src/cognito.ts`
- Modify: `packages/auth/src/cognito.test.ts`
- Modify: `packages/auth/src/session.ts`
- Modify: `packages/auth/src/session.test.ts`
- Modify: `apps/web/src/app/auth/login/route.ts`
- Modify: `apps/web/src/app/auth/callback/route.ts`
- Modify: `apps/web/src/app/auth/callback/route.test.ts`
- Modify: `apps/web/src/server/membership-loader.ts`
- Modify: `apps/web/src/server/runtime.ts`
- Create: `apps/web/src/server/self-service-identity.ts`
- Create: `apps/web/tests/self-service-identity.integration.test.ts`

- [ ] Add failing Cognito tests requiring verified ID-token claims `sub`, `email`, `email_verified` and optional `name`, while rejecting missing/unverified email claims and preserving issuer, audience, nonce and PKCE checks.
- [ ] Add failing session tests for `requireIdentitySession`, which accepts a known, enabled user with zero memberships, while the existing `requireSession` continues to require at least one active membership.
- [ ] Add failing integration tests proving the Cognito callback creates or updates a provisional user by Cognito subject only, never silently links a different subject by matching email, and sends conflicts to an account-recovery page.
- [ ] Add a failing login-route test for `mode=signup` using Cognito's supported hosted-signup hint and returning to `/onboarding`.
- [ ] Run the focused auth and web tests and confirm failure.
- [ ] Extend `exchangeCognitoCode` to return only verified identity claims and implement `requireIdentitySession` without weakening any protected application route.
- [ ] Implement idempotent provisional-user creation keyed by Cognito subject. Normalise email casing for comparison, but treat an existing different subject as a security conflict rather than a merge.
- [ ] Add `requireWebIdentitySession()` for onboarding routes; keep `requireWebSession()` unchanged for the operational application.
- [ ] Rerun focused tests, the complete auth suite and web typecheck.
- [ ] Commit with `git commit -m "feat: support self-service AccountPulse identities"`.

## Task 14: Add Solo subscriptions, onboarding and legacy entitlements to the data model

**Files:**

- Create: `packages/db/src/schema/commerce.ts`
- Create: `packages/db/src/schema/onboarding.ts`
- Modify: `packages/db/src/schema/organisation.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/drizzle/0014_accountpulse_solo_commerce.sql`
- Create/Modify: `packages/db/drizzle/meta/0014_snapshot.json`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/src/schema/schema.integration.test.ts`

- [ ] Add failing schema tests for the stable plan code `SOLO_AU_2000`, organisation edition `INTERNAL_LEGACY` or `SOLO`, subscriptions, idempotent subscription events and versioned onboarding state.
- [ ] Prove the migration assigns every pre-existing organisation `INTERNAL_LEGACY` without changing send mode, rollout scope, acknowledgement, maintenance or operational state.
- [ ] Define subscription states exactly as `TRIALING`, `ACTIVE`, `PAST_DUE`, `CANCEL_AT_PERIOD_END`, `CANCELLED` and `INCOMPLETE`; constrain unknown values at the database boundary.
- [ ] Include Stripe customer/subscription IDs, billing period, cancellation timestamps, event ordering timestamp and trial expiry, with uniqueness that prevents one Stripe subscription from owning multiple organisations.
- [ ] Define onboarding checklist fields for Xero connection, sync reconciliation, business details, verified admin mobile, test SMS, sequence review, subscription, reply-number readiness and completion version.
- [ ] Run the focused schema integration test and confirm failure.
- [ ] Implement the additive schemas and generate/inspect `0014_accountpulse_solo_commerce.sql`. Existing rows must remain `INTERNAL_LEGACY`; only the provisioning service may create `SOLO` rows.
- [ ] Rerun schema and migration tests against both an empty database and a fixture containing a live Motts-style organisation.
- [ ] Commit with `git commit -m "feat: add Solo commerce and onboarding state"`.

## Task 15: Implement Stripe Checkout, Portal and signed webhook primitives

**Files:**

- Modify: `packages/integrations/package.json`
- Create: `packages/integrations/src/stripe/client.ts`
- Create: `packages/integrations/src/stripe/client.test.ts`
- Create: `packages/integrations/src/stripe/status.ts`
- Create: `packages/integrations/src/stripe/status.test.ts`
- Create: `packages/integrations/src/stripe/index.ts`
- Modify: `packages/integrations/package.json`

- [ ] Add the official pinned Stripe Node SDK and expose a new `@bc5000/integrations/stripe` export; do not implement payment cryptography or card collection in AccountPulse.
- [ ] Write failing tests for creating a Checkout Session with one recurring `SOLO_AU_2000` price, AUD tax configuration, organisation/user metadata, allowlisted success/cancel URLs and an idempotency key.
- [ ] Write failing tests for creating a Billing Portal session only for the organisation's stored Stripe customer.
- [ ] Write failing webhook tests for raw-body signature verification, timestamp tolerance and rejection of missing/invalid signatures.
- [ ] Write table-driven failing tests mapping Stripe statuses exactly: `trialing→TRIALING`, `active→ACTIVE`, `past_due|unpaid→PAST_DUE`, scheduled cancellation→`CANCEL_AT_PERIOD_END`, `canceled|paused|incomplete_expired→CANCELLED`, and incomplete payment states→`INCOMPLETE`. Unknown statuses must fail closed.
- [ ] Run the focused Stripe tests and confirm failure.
- [ ] Implement the smallest typed Stripe adapter. Keep all price IDs, secrets, tax behaviour and portal configuration in environment/runtime configuration, not organisation records.
- [ ] Rerun Stripe tests and integrations-package typecheck.
- [ ] Commit with `git commit -m "feat: add Stripe subscription integration"`.

## Task 16: Process Stripe subscriptions idempotently and expose customer billing

**Files:**

- Create: `apps/web/src/server/subscription-service.ts`
- Create: `apps/web/src/app/api/webhooks/stripe/route.ts`
- Create: `apps/web/src/app/(protected)/settings/billing/actions.ts`
- Create: `apps/web/src/app/(protected)/settings/billing/page.tsx`
- Modify: `apps/web/src/server/runtime.ts`
- Modify: `apps/web/src/app/(protected)/settings/page.tsx`
- Create: `apps/web/tests/subscriptions.integration.test.ts`
- Create: `apps/web/tests/stripe-webhook.integration.test.ts`
- Create: `apps/worker/src/handlers/subscription-lifecycle.ts`
- Create: `apps/worker/tests/subscription-lifecycle.integration.test.ts`
- Modify: `packages/jobs/src/names.ts`
- Modify: `packages/jobs/src/payloads.ts`
- Modify: `packages/jobs/src/schedules.ts`
- Modify: `apps/worker/src/entrypoint.ts`

- [ ] Write failing tests proving an Admin can create one Checkout Session for their organisation, an Operator cannot, and repeated clicks reuse the same pending customer/idempotency key instead of creating duplicate subscriptions.
- [ ] Write failing webhook tests for duplicate event IDs, out-of-order events, wrong price/currency, organisation metadata mismatch and a valid subscription lifecycle from checkout through active, past due, recovery, scheduled cancellation and cancellation.
- [ ] Assert that a Checkout success redirect never activates entitlement; only the signed webhook transaction does.
- [ ] Assert that payment failure pauses new provider submissions immediately, scheduled cancellation pauses future sequence work immediately, and resumption requires a later valid Stripe state plus an explicit AccountPulse resume action.
- [ ] Add failing tests for Billing Portal ownership, redacted audit records and Motts `INTERNAL_LEGACY` never receiving a Stripe customer or subscription.
- [ ] Add failing lifecycle tests proving a scheduled cancellation pauses new sends immediately but keeps read-only paid access until period end; when the cancellation actually takes effect, the worker deletes the Xero connection remotely, marks it disconnected locally and records an auditable retention deadline.
- [ ] Run the focused web integration tests and confirm failure.
- [ ] Implement the transactional subscription service and Stripe route using the raw request body, unique event ID, event creation time and last-applied ordering timestamp.
- [ ] Add Billing settings showing plan, trial/status, next period, cancellation, included SMS description and Checkout/Portal actions without exposing Stripe IDs.
- [ ] Add strict `getStripeConfiguration()` validation for `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SOLO_PRICE_ID`, `STRIPE_PORTAL_CONFIGURATION_ID` and `PUBLIC_BASE_URL`.
- [ ] Rerun focused tests, all web integration tests and web typecheck.
- [ ] Commit with `git commit -m "feat: manage AccountPulse Solo subscriptions"`.

## Task 17: Provision a Solo trial idempotently from Xero OAuth

**Files:**

- Create: `apps/web/src/server/solo-provisioning-service.ts`
- Modify: `apps/web/src/server/xero-oauth-service.ts`
- Modify: `apps/web/src/app/xero/connect/route.ts`
- Modify: `apps/web/src/app/xero/callback/route.ts`
- Modify: `apps/web/src/app/(protected)/settings/integrations/xero/select/actions.ts`
- Create: `apps/web/src/app/start/page.tsx`
- Create: `apps/web/src/app/onboarding/page.tsx`
- Create: `apps/web/tests/solo-provisioning.integration.test.ts`
- Modify: `apps/web/tests/xero-oauth.integration.test.ts`

- [ ] Add failing tests for the public `/start` page directing a new customer to Cognito hosted signup and returning the authenticated provisional user to `/onboarding`.
- [ ] Add a failing `NEW_SOLO` Xero flow test that binds state to the provisional Cognito subject without an organisation ID, exchanges the code, selects one tenant and fetches its Xero organisation name, timezone and base currency.
- [ ] Prove finalisation atomically creates one `SOLO` organisation, one Admin membership, one connected Xero tenant, one 14-day `TRIALING` subscription record, onboarding version 1 and one initial-sync job.
- [ ] Prove retries of the same authorization event and tenant return the same organisation and never duplicate membership, subscription, sync or audit events.
- [ ] Prove a subject that already owns a Solo organisation cannot create another and instead sees the existing organisation plus Enterprise waitlist.
- [ ] Prove a tenant owned by another subject/organisation is rejected without linking by email or leaking the owner's details.
- [ ] Assert every new organisation starts with `sendMode=dry-run`, `rolloutScope=CONTROLLED`, `liveSendAcknowledged=false`, automatic sequences disabled and no customer-live work published.
- [ ] Run the focused provisioning/OAuth tests and confirm failure.
- [ ] Implement `SoloProvisioningService` as one database transaction followed by an idempotent queue publish. On queue failure, retain the valid tenant and show a retryable sync state.
- [ ] Implement `/start` and `/onboarding` entry points using identity sessions for provisional users and normal sessions after membership creation.
- [ ] Add a certification-facing **Sign Up with Xero** entry that either completes the supported Xero-first identity handoff without silent email linking or is disabled behind a release gate until written Xero approval of the account-first exception is recorded. Do not mark the build App Store-ready merely because `/start` works.
- [ ] Rerun focused tests, Xero tests and web typecheck.
- [ ] Commit with `git commit -m "feat: provision self-service AccountPulse Solo trials"`.

## Task 18: Implement the guided onboarding checklist

**Files:**

- Create: `apps/web/src/app/(protected)/onboarding/page.tsx`
- Create: `apps/web/src/app/(protected)/onboarding/actions.ts`
- Create: `apps/web/src/app/(protected)/onboarding/onboarding-service.ts`
- Modify: `apps/web/src/components/app-shell.tsx`
- Modify: `apps/web/src/app/(protected)/settings/sending/page.tsx`
- Modify: `apps/web/src/app/(protected)/settings/test-sms/page.tsx`
- Create: `apps/web/tests/onboarding.integration.test.ts`
- Create: `apps/web/e2e/onboarding.spec.ts`

- [ ] Write failing service tests for the ordered checklist: Xero connected; initial sync reconciled; business/support details confirmed; Australian admin mobile verified; test SMS completed; reminder sequence reviewed; subscription active; reply number ready.
- [ ] Add failing tests that steps are derived from evidence where possible and cannot be checked manually to bypass Xero reconciliation, mobile verification, Stripe status or number readiness.
- [ ] Add failing tests for a 14-day no-card trial: Xero sync and reminder previews work; up to ten test SMS parts can target only the verified Administrator's Australian mobile; customer-live SMS, automatic sending and permanent number assignment remain unavailable.
- [ ] Add failing tests that trial expiry makes the Solo workspace read-only, pauses scheduled sends and shows Subscribe/Export/Disconnect actions without deleting data.
- [ ] Add failing expiry tests proving an unconverted expired trial deletes its Xero connection remotely, marks the local connection disconnected, and queues local tenant data for policy-driven deletion after 30 days without deleting protected billing/audit records early.
- [ ] Add a failing test that subscription activation preserves trial configuration/history and leaves reminder sequences in Review mode.
- [ ] Run focused service tests and confirm failure.
- [ ] Implement the onboarding service and responsive page with clear progress, blockers, retry actions and links to the existing Xero, test sending, sequence and billing screens.
- [ ] Add an onboarding status item to the app shell until complete; do not block Inbox/Outbox review pages unnecessarily.
- [ ] Implement the browser test from hosted-login return (mocked identity provider) through Xero connection, sync, trial preview, checkout webhook, number readiness and completed checklist.
- [ ] Rerun focused tests, the Playwright onboarding test and web typecheck.
- [ ] Commit with `git commit -m "feat: guide Solo customers through onboarding"`.

## Task 19: Enforce subscription and onboarding entitlements on every outbound path

**Files:**

- Create: `packages/domain/src/entitlements.ts`
- Create: `packages/domain/src/entitlements.test.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/db/src/repositories/entitlement-repository.ts`
- Create: `packages/db/src/repositories/entitlement-repository.integration.test.ts`
- Modify: `apps/worker/src/services/pre-send-revalidation.ts`
- Modify: `apps/worker/src/handlers/reminder-execute.ts`
- Modify: `apps/worker/src/handlers/operator-reply-execute.ts`
- Modify: `apps/worker/src/handlers/test-sms-execute.ts`
- Modify: `apps/worker/src/handlers/automatic-reminder-dispatch.ts`
- Modify: `apps/worker/tests/reminder-execute.integration.test.ts`
- Modify: `apps/worker/tests/operator-reply-execute.integration.test.ts`
- Modify: `apps/worker/tests/test-sms-execute.integration.test.ts`

- [ ] Define a pure `AccountEntitlements` decision with edition, subscription status, trial expiry, onboarding completion and capabilities for read, preview, verified-admin test, customer send and automatic dispatch.
- [ ] Add table-driven failing tests for `INTERNAL_LEGACY`, active Solo, trialing Solo, expired trial, past due, cancel-at-period-end, cancelled and incomplete states.
- [ ] Add failing integration tests at every outbound entry point proving no unpaid/trial/expired/incomplete Solo organisation can submit customer-live SMS or Xero email, even with stale queued jobs or forged UI requests.
- [ ] Add failing tests that trial test SMS is limited to ten parts and only the verified Administrator mobile, while platform-funded verification OTPs are not counted as customer sends.
- [ ] Add failing tests that active payment alone does not dispatch backlog, enable automation or bypass number readiness/onboarding.
- [ ] Add regression tests proving Motts `INTERNAL_LEGACY` behaviour, live state and existing safeguards are unchanged.
- [ ] Run focused domain and worker tests and confirm failure.
- [ ] Implement one repository-backed entitlement decision and call it inside final pre-send revalidation, not only in UI or scheduling code.
- [ ] Return stable blocker reasons such as `SUBSCRIPTION_REQUIRED`, `TRIAL_EXPIRED`, `PAYMENT_PAST_DUE`, `ONBOARDING_INCOMPLETE` and `REPLY_NUMBER_NOT_READY`, retaining blocked work for review rather than discarding it.
- [ ] Rerun focused tests, all sending-safeguard tests and worker typecheck.
- [ ] Commit with `git commit -m "feat: enforce Solo subscription entitlements"`.

## Task 20: Assign reply numbers and enforce the included 2,000 SMS parts

**Files:**

- Create: `packages/db/src/schema/sms-commerce.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/drizzle/0015_accountpulse_sms_commerce.sql`
- Create/Modify: `packages/db/drizzle/meta/0015_snapshot.json`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Create: `packages/db/src/repositories/sms-commerce-repository.ts`
- Create: `packages/db/src/repositories/sms-commerce-repository.integration.test.ts`
- Create: `packages/domain/src/sms-allowance.ts`
- Create: `packages/domain/src/sms-allowance.test.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/integrations/src/sms/index.ts`
- Modify: `packages/integrations/package.json`
- Modify: `apps/worker/src/services/delivery-service.ts`
- Modify: `apps/worker/src/services/inbound-reply-service.ts`
- Modify: `apps/web/src/app/(protected)/settings/billing/page.tsx`
- Create: `apps/web/tests/sms-allowance.integration.test.ts`
- Modify: `apps/web/tests/inbox.integration.test.ts`

- [ ] Add failing schema/repository tests for a pre-provisioned numeric Australian SMS number pool, one active number assignment per paid organisation, unique number ownership and provisioning states `AVAILABLE`, `RESERVED`, `READY`, `QUARANTINED` and `RELEASED`.
- [ ] Add failing tests proving paid onboarding reserves and assigns a number idempotently, trial accounts receive no permanent number, cancellation does not immediately reassign a number, and quarantine prevents another tenant receiving replies intended for the former tenant.
- [ ] Add an append-only SMS usage ledger with `RESERVE`, `COMMIT`, `RELEASE` and `ADJUST` entries, billing-period keys, outbound-message/source references, signed part deltas and unique idempotency keys.
- [ ] Add failing domain tests for 2,000 included parts, 80% warning, overage disabled by default, customer-set AUD cap, unknown outcomes remaining reserved, provider-accepted failures remaining committed and pre-dispatch cancellations releasing reservations.
- [ ] Add failing integration tests showing automated reminders, manual reminders, escalations, Inbox replies and customer test sends consume allowance; inbound replies and platform verification OTPs do not.
- [ ] Add failing tests that use the existing GSM-7/UCS-2 renderer's final `segmentCount`, re-check it immediately before provider submission, and block changed content when the new count exceeds available entitlement.
- [ ] Add failing cross-tenant inbound tests resolving the AccountPulse organisation from the dedicated destination number before matching the debtor mobile/conversation.
- [ ] Run focused domain, database, delivery and Inbox tests and confirm failure.
- [ ] Implement the additive schema/repository, provider-neutral `SmsProvider` boundary and Sinch adapter. Keep actual provider credentials platform-owned and never store them in tenant records.
- [ ] Reserve parts atomically with the send claim, commit after provider acceptance, release before dispatch cancellation, and retain reservations for unknown outcomes until reconciliation.
- [ ] Show current-period included, reserved, committed and overage parts on Billing, and stable `SMS_ALLOWANCE_EXHAUSTED`/`SMS_OVERAGE_CAP_REACHED` blockers in approvals/outbox.
- [ ] Make reply-number `READY` evidence satisfy the final onboarding step; payment alone must not mark it ready.
- [ ] Rerun focused tests, all messaging/Inbox/Outbox tests and package typechecks.
- [ ] Commit with `git commit -m "feat: enforce Solo SMS allowance and number tenancy"`.

## Task 21: Verify the complete commercial journey and prepare the controlled release

**Files:**

- Modify if evidence changes are needed: `docs/runbooks/deployment.md`
- Modify if evidence changes are needed: `docs/runbooks/xero-oauth-cutover.md`

- [ ] Run `pnpm install --frozen-lockfile`.
- [ ] Run `pnpm audit --prod --audit-level high` and record any accepted exception with package, advisory, exposure and owner.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm test:integration` against a clean PostgreSQL 17 database.
- [ ] Run `pnpm test:e2e` with Cognito, Xero, Stripe and Sinch test doubles, including the complete new-customer onboarding journey.
- [ ] Run `pnpm build`.
- [ ] Resolve `deploy/ovh/docker-compose.yml` for staging and production with secret-free validation values and confirm no application service requires AWS credentials.
- [ ] Search the built source and logs for OAuth codes, `access_token`, `refresh_token`, Stripe signatures/secrets, client-secret values and encryption-key values; fail the release if any can be logged or rendered.
- [ ] Self-review every spec requirement covered by this plan, type/interface consistency, refresh failure modes, tenant isolation, migration reversibility and whether any implementation is disproportionate.
- [ ] Deploy the immutable build to OVH staging only, create a brand-new Cognito customer, connect a Xero demo organisation, run initial and incremental sync, wait for a refresh-token rotation, deliver a signed Xero webhook, and disconnect/reconnect.
- [ ] Reconcile initial and incremental Xero results for paid, partially paid, voided and multi-currency invoices, and document that AccountPulse creates no Xero accounting transactions, so account/tax mapping is not applicable to this use case.
- [ ] Revoke AccountPulse from Xero's side, prove jobs fail closed into `REAUTH_REQUIRED`, reconnect, and prove queued work resumes only after explicit review.
- [ ] In Stripe test mode, start Checkout, prove the success return alone grants nothing, deliver signed active/past-due/recovery/cancel events, open Billing Portal, and reconcile AccountPulse status to Stripe.
- [ ] Complete onboarding with a test Sinch number, send to the verified Administrator during trial, prove a debtor number is blocked, activate the subscription, assign the number, send one approved customer reminder, receive its reply in the correct tenant Inbox, and reconcile SMS parts to the provider record.
- [ ] Create a second staging tenant and repeat Xero webhook, outbound SMS and inbound reply tests to prove no cross-tenant data or number routing.
- [ ] Exercise OVH backup, restore and application rollback using a disposable staging database; capture recovery time, backup identifier and immutable release SHA.
- [ ] Capture MFA, at-rest/in-transit encryption and redacted-log evidence without recording credentials or customer data.
- [ ] Run the Motts readiness command in production before any Motts OAuth connection change and archive the output with invoice reconciliation evidence.
- [ ] Ask for explicit production promotion and Motts cutover approval. Production promotion must not reset data, alter sending state or disable the legacy connection.
- [ ] After approval, deploy the same tested image SHA to OVH production, perform `/health/ready`, login, queue and Xero connection smoke tests, and save the release SHA, workflow URL, backup path, migration result and reconciliation evidence.

## Commercial Foundation Completion Criteria

- OVH is the authoritative deploy target for AccountPulse application services; the main release workflow no longer deploys those services to AWS.
- Cognito login still works, but no application container receives AWS access keys.
- A logged-in AccountPulse Admin can connect, select, reconnect and disconnect one Xero tenant using standard OAuth.
- Refresh tokens rotate safely across worker processes and remain encrypted at rest; access tokens are memory-only.
- Every Xero job and webhook resolves the correct AccountPulse organisation from explicit organisation/tenant identifiers.
- A new customer can create a Cognito identity, connect one Xero organisation, receive an idempotently provisioned 14-day trial workspace and complete initial sync without staff intervention.
- The customer can subscribe through Stripe Checkout, manage billing through Stripe Portal and see webhook-sourced subscription status; checkout redirects cannot grant access.
- The guided onboarding checklist is evidence-backed, survives retries and clearly distinguishes trial preview, paid subscription and customer-live readiness.
- A paid organisation receives one isolated Australian reply number and an auditable 2,000-part allowance; usage and replies reconcile to the provider without crossing tenants.
- Trial, unpaid, cancelled and incomplete organisations cannot send customer-live reminders from any UI, queue or worker path; Motts `INTERNAL_LEGACY` remains unchanged.
- Expired unconverted trials and subscriptions at their effective end are disconnected from Xero through the provider API, not left connected until token expiry.
- App Store submission remains blocked until Sign Up with Xero is supported or Xero supplies a written exception to the commercial-terms requirement.
- Motts continues operating unchanged through the legacy Custom Connection until an evidence-backed, separately approved cutover.
- All unit, integration, browser, build, Compose, Stripe test-mode and staging acceptance checks pass.


