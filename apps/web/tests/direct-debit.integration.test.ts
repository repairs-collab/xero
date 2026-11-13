import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabase,
  directDebitRequests,
  memberships,
  migrateDatabase,
  organisations,
  subscriptions,
  users
} from '@bc5000/db';
import * as databaseSchema from '@bc5000/db';

import { createPostgresSubscriptionRepository } from '../src/server/subscription-repository.js';

const client = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://bc5000:bc5000@localhost:5432/bc5000'
);
const now = new Date('2026-11-09T12:00:00.000Z');

beforeAll(async () => migrateDatabase(client.db));
afterAll(async () => client.pool.end());

const seed = async (withInitialCardEvidence = false) => {
  const organisationId = randomUUID();
  const userId = randomUUID();
  const stripeCustomerId = `cus_${organisationId}`;
  const stripeSubscriptionId = `sub_${organisationId}`;
  await client.db.insert(organisations).values({
    id: organisationId,
    xeroOrganisationId: randomUUID(),
    name: 'Direct debit integration test',
    timeZone: 'Australia/Sydney',
    baseCurrency: 'AUD',
    edition: 'SOLO'
  });
  await client.db.insert(users).values({
    id: userId,
    cognitoSubject: randomUUID(),
    email: `${userId}@example.invalid`,
    displayName: 'Billing administrator'
  });
  await client.db.insert(memberships).values({
    organisationId,
    userId,
    role: 'ADMIN'
  });
  await client.db.insert(subscriptions).values({
    organisationId,
    planCode: 'SOLO_AU_2000',
    status: 'ACTIVE',
    stripeProviderStatus: 'active',
    stripeCustomerId,
    stripeSubscriptionId,
    currentPeriodStart: new Date('2026-11-09T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-12-09T00:00:00.000Z'),
    ...(withInitialCardEvidence
      ? {
          initialCardStripeSubscriptionId: stripeSubscriptionId,
          initialCardInvoiceId: `in_${organisationId}`,
          initialCardPaymentSucceededAt: new Date(
            '2026-11-09T10:00:00.000Z'
          )
        }
      : {})
  });
  return {
    organisationId,
    userId,
    stripeCustomerId,
    stripeSubscriptionId
  };
};

describe('request-only direct debit persistence', () => {
  it('requires explicit owner reconciliation before a legacy mandate can be replaced', async () => {
    const seeded = await seed(true);
    const repository = createPostgresSubscriptionRepository(client.db, {
      now: () => now
    });
    const legacyId = randomUUID();
    const stripePaymentMethodId = `pm_${legacyId}`;
    const stripeMandateId = `mandate_legacy_${legacyId}`;
    await client.db.insert(directDebitRequests).values({
      id: legacyId,
      organisationId: seeded.organisationId,
      status: 'LEGACY_UNBOUND',
      legacyStatus: 'ACTIVE',
      requestedByUserId: seeded.userId,
      requestedAt: now,
      setupSessionId: `cs_legacy_${legacyId}`,
      setupIntentId: `seti_legacy_${legacyId}`,
      stripePaymentMethodId,
      stripeMandateId,
      mandateConfirmedAt: now,
      activatedByUserId: seeded.userId,
      activatedAt: now
    });
    await expect(
      client.db
        .update(directDebitRequests)
        .set({ stripeSubscriptionId: seeded.stripeSubscriptionId })
        .where(eq(directDebitRequests.id, legacyId))
    ).rejects.toMatchObject({
      cause: { constraint: 'direct_debit_requests_episode_ck' }
    });
    await expect(
      client.db
        .update(directDebitRequests)
        .set({
          stripeSubscriptionId: seeded.stripeSubscriptionId,
          status: 'ACTIVE',
          legacyStatus: null,
          setupAttemptVersion: 1,
          setupSessionExpiresAt: new Date('2026-11-10T12:00:00.000Z')
        })
        .where(eq(directDebitRequests.id, legacyId))
    ).rejects.toMatchObject({
      cause: { code: 'P0001' }
    });

    await expect(
      repository.loadBillingAccount(seeded.organisationId, seeded.userId)
    ).resolves.toMatchObject({
      directDebitStatus: 'RECONCILIATION_REQUIRED'
    });
    await expect(
      repository.loadDirectDebitRequest(seeded.organisationId)
    ).resolves.toBeNull();
    await expect(
      repository.loadDirectDebitRequesterEmail(seeded.organisationId)
    ).resolves.toBeNull();
    await expect(
      repository.markDirectDebitSetupPending({
        organisationId: seeded.organisationId,
        directDebitRequestId: legacyId,
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        actorUserId: seeded.userId,
        setupAttemptVersion: 1,
        setupSessionId: `cs_fresh_${legacyId}`,
        setupSessionExpiresAt: new Date('2026-11-10T12:00:00.000Z'),
        occurredAt: now
      })
    ).rejects.toThrow('DIRECT_DEBIT_RECONCILIATION_REQUIRED');
    await expect(
      repository.activateDirectDebit({
        organisationId: seeded.organisationId,
        directDebitRequestId: legacyId,
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        activatedByUserId: seeded.userId,
        activatedAt: now,
        stripePaymentMethodId,
        stripeMandateId
      })
    ).rejects.toThrow('DIRECT_DEBIT_RECONCILIATION_REQUIRED');

    await expect(
      repository.requestDirectDebit({
        organisationId: seeded.organisationId,
        requestedByUserId: seeded.userId,
        requestedAt: now
      })
    ).rejects.toThrow('DIRECT_DEBIT_RECONCILIATION_REQUIRED');

    await expect(
      repository.reconcileLegacyDirectDebit({
        organisationId: seeded.organisationId,
        directDebitRequestId: legacyId,
        reconciledByUserId: seeded.userId,
        reconciledAt: now,
        outcome: 'LEGACY_DEFAULT_REMOVED',
        providerReference: `${seeded.stripeCustomerId}|${seeded.stripeSubscriptionId}|${stripePaymentMethodId}`
      })
    ).resolves.toMatchObject({
      id: legacyId,
      providerReconciledByUserId: seeded.userId,
      providerReconciledAt: now,
      providerReconciliationReference: `${seeded.stripeCustomerId}|${seeded.stripeSubscriptionId}|${stripePaymentMethodId}`
    });
    await expect(
      repository.loadBillingAccount(seeded.organisationId, seeded.userId)
    ).resolves.toMatchObject({ directDebitStatus: null });

    const request = await repository.requestDirectDebit({
      organisationId: seeded.organisationId,
      requestedByUserId: seeded.userId,
      requestedAt: now
    });
    expect(request.id).not.toBe(legacyId);
    expect(request).toMatchObject({
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      status: 'REQUESTED',
      setupSessionId: null,
      setupIntentId: null,
      stripeMandateId: null
    });
    await expect(
      repository.loadDirectDebitRequesterEmail(seeded.organisationId)
    ).resolves.toBe(`${seeded.userId}@example.invalid`);
  });

  it('runs the current repository fail-closed on a real published-0037 upgrade', async () => {
    const connection = await client.pool.connect();
    const schemaName = `direct_debit_forward_${randomUUID().replaceAll('-', '_')}`;
    const organisationId = randomUUID();
    const userId = randomUUID();
    const paidAt = new Date('2026-11-09T10:00:00.000Z');
    try {
      await connection.query(`create schema "${schemaName}"`);
      await connection.query(`set search_path to "${schemaName}"`);
      await connection.query(`
        create table organisations (
          id uuid primary key
        );
        create table users (
          id uuid primary key,
          email text not null,
          disabled_at timestamp with time zone
        );
        create table memberships (
          organisation_id uuid not null,
          user_id uuid not null,
          role varchar(16) not null,
          disabled_at timestamp with time zone,
          primary key (organisation_id, user_id)
        );
        create table audit_events (
          id uuid default gen_random_uuid() primary key,
          organisation_id uuid not null,
          actor_user_id uuid,
          event_type varchar(64) not null,
          entity_type varchar(64) not null,
          entity_id text not null,
          correlation_id text,
          before_value jsonb,
          after_value jsonb,
          occurred_at timestamp with time zone not null default now()
        );
      `);
      const applyMigration = async (name: string) => {
        const migration = await readFile(
          new URL(`../../../packages/db/drizzle/${name}.sql`, import.meta.url),
          'utf8'
        );
        for (const statement of migration.split('--> statement-breakpoint')) {
          await connection.query(
            statement.replaceAll('"public".', `"${schemaName}".`)
          );
        }
      };
      await applyMigration('0014_accountpulse_solo_commerce');
      await applyMigration('0023_reconcile_ambiguous_cancellations');
      await applyMigration('0024_lyrical_may_parker');
      await applyMigration('0035_same_azazel');

      await connection.query(
        `insert into organisations (id, edition) values ($1, 'SOLO')`,
        [organisationId]
      );
      await connection.query(
        `insert into users (id, email) values ($1, $2)`,
        [userId, `${userId}@example.invalid`]
      );
      await connection.query(
        `insert into memberships (organisation_id, user_id, role)
         values ($1, $2, 'ADMIN')`,
        [organisationId, userId]
      );
      await connection.query(
        `insert into subscriptions (
           organisation_id, plan_code, status, stripe_provider_status,
           trusted_stripe_provider_status, stripe_customer_id,
           stripe_subscription_id, current_period_start, current_period_end,
           initial_card_invoice_id, initial_card_payment_succeeded_at
         ) values (
           $1, 'SOLO_AU_2000', 'ACTIVE', 'active', 'active', 'cus_forward',
           'sub_forward', $2, $3, 'in_forward', $2
         )`,
        [
          organisationId,
          paidAt,
          new Date('2026-12-09T10:00:00.000Z')
        ]
      );
      await connection.query(
        `insert into subscription_events (
           organisation_id, stripe_event_id, event_type,
           stripe_event_created_at, payload_hash, outcome
         ) values (
           $1, 'evt_forward', 'checkout.session.completed', $2,
           repeat('f', 64), 'APPLIED'
         )`,
        [organisationId, paidAt]
      );
      await connection.query(
        `insert into direct_debit_requests (
           organisation_id, status, requested_by_user_id, requested_at,
           setup_session_id, setup_intent_id, stripe_payment_method_id,
           stripe_mandate_id, mandate_confirmed_at, activated_by_user_id,
           activated_at
         ) values (
           $1, 'ACTIVE', $2, $3, 'cs_legacy_forward', 'seti_legacy_forward',
           'pm_legacy_forward', 'mandate_legacy_forward', $3, $2, $3
         )`,
        [organisationId, userId, paidAt]
      );
      await applyMigration('0037_watery_tombstone');
      const firstLegacy = await connection.query<{ id: string }>(
        `select id from direct_debit_requests where organisation_id = $1`,
        [organisationId]
      );
      const firstLegacyId = firstLegacy.rows[0]!.id;
      const secondLegacyId = randomUUID();
      await connection.query(
        `update subscriptions
            set stripe_subscription_id = 'sub_forward_current',
                initial_card_stripe_subscription_id = 'sub_forward_current',
                initial_card_invoice_id = 'in_forward_current'
          where organisation_id = $1`,
        [organisationId]
      );
      await connection.query(
        `insert into direct_debit_requests (
           id, organisation_id, stripe_subscription_id, status,
           requested_by_user_id, requested_at, setup_attempt_version
         ) values ($1, $2, 'sub_forward_current', 'REQUESTED', $3, $4, 0)`,
        [secondLegacyId, organisationId, userId, now]
      );
      await applyMigration('0038_flawless_talon');
      await connection.query(
        `update direct_debit_requests
            set provider_reconciled_at = $1,
                provider_reconciled_by_user_id = $2,
                provider_reconciliation_outcome = 'NO_LEGACY_DEFAULT'
          where id = $3`,
        [now, userId, secondLegacyId]
      );
      const migrations = await readdir(
        new URL('../../../packages/db/drizzle/', import.meta.url)
      );
      const reconciliationMigration = migrations.find((name) =>
        /^0040_.*\.sql$/.test(name)
      );
      expect(reconciliationMigration).toBeDefined();
      await applyMigration(reconciliationMigration!.replace(/\.sql$/, ''));

      const scopedDatabase = drizzle(connection, { schema: databaseSchema });
      const repository = createPostgresSubscriptionRepository(scopedDatabase, {
        now: () => now
      });
      await expect(
        repository.loadBillingAccount(organisationId, userId)
      ).resolves.toMatchObject({
        directDebitStatus: 'RECONCILIATION_REQUIRED'
      });
      await expect(
        repository.loadDirectDebitRequesterEmail(organisationId)
      ).resolves.toBeNull();
      await expect(
        repository.requestDirectDebit({
          organisationId,
          requestedByUserId: userId,
          requestedAt: now
        })
      ).rejects.toThrow('DIRECT_DEBIT_RECONCILIATION_REQUIRED');
      await expect(
        connection.query(
          `insert into direct_debit_requests (
             organisation_id, stripe_subscription_id, status,
             requested_by_user_id, requested_at, setup_attempt_version
           ) values ($1, 'sub_forward_current', 'REQUESTED', $2, $3, 0)`,
          [organisationId, userId, now]
        )
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        repository.reconcileLegacyDirectDebit({
          organisationId,
          directDebitRequestId: secondLegacyId,
          reconciledByUserId: userId,
          reconciledAt: now,
          outcome: 'NO_LEGACY_DEFAULT',
          providerReference:
            'cus_forward|sub_forward_current|none'
        })
      ).resolves.toMatchObject({
        id: secondLegacyId,
        legacyStatus: 'REQUESTED',
        providerReconciliationOutcome: 'NO_LEGACY_DEFAULT',
        providerReconciliationReference:
          'cus_forward|sub_forward_current|none'
      });
      await expect(
        repository.reconcileLegacyDirectDebit({
          organisationId,
          directDebitRequestId: secondLegacyId,
          reconciledByUserId: userId,
          reconciledAt: now,
          outcome: 'NO_LEGACY_DEFAULT',
          providerReference:
            'cus_forward|sub_forward_current|none'
        })
      ).rejects.toThrow('DIRECT_DEBIT_RECONCILIATION_NOT_REQUIRED');
      await expect(
        repository.requestDirectDebit({
          organisationId,
          requestedByUserId: userId,
          requestedAt: now
        })
      ).rejects.toThrow('DIRECT_DEBIT_RECONCILIATION_REQUIRED');
      await expect(
        repository.reconcileLegacyDirectDebit({
          organisationId,
          directDebitRequestId: firstLegacyId,
          reconciledByUserId: userId,
          reconciledAt: new Date(now.getTime() + 1_000),
          outcome: 'LEGACY_DEFAULT_REMOVED',
          providerReference:
            'cus_forward|sub_forward|pm_legacy_forward'
        })
      ).resolves.toMatchObject({ id: firstLegacyId });
      await expect(
        repository.requestDirectDebit({
          organisationId,
          requestedByUserId: userId,
          requestedAt: now
        })
      ).resolves.toMatchObject({ status: 'REQUESTED' });
      const reconciliationAudit = await connection.query<{
        entity_id: string;
        after_value: {
          providerReconciliationReference: string;
        };
      }>(
        `select entity_id, after_value
           from audit_events
          where event_type = 'DIRECT_DEBIT_PROVIDER_RECONCILED'
          order by occurred_at`,
        []
      );
      expect(reconciliationAudit.rows).toHaveLength(2);
      expect(reconciliationAudit.rows[0]).toMatchObject({
        entity_id: secondLegacyId,
        after_value: {
          providerReconciliationReference:
            'cus_forward|sub_forward_current|none'
        }
      });
      expect(reconciliationAudit.rows[1]).toMatchObject({
        entity_id: firstLegacyId,
        after_value: {
          providerReconciliationReference:
            'cus_forward|sub_forward|pm_legacy_forward'
        }
      });
    } finally {
      await connection.query('set search_path to public');
      await connection.query(`drop schema if exists "${schemaName}" cascade`);
      connection.release();
    }
  }, 15_000);

  it('keeps migrated card evidence only when Checkout identity matches the current subscription episode', async () => {
    const connection = await client.pool.connect();
    const schemaName = `card_episode_forward_${randomUUID().replaceAll('-', '_')}`;
    const crossEpisodeOrganisationId = randomUUID();
    const validEpisodeOrganisationId = randomUUID();
    const crossEpisodeUserId = randomUUID();
    const validEpisodeUserId = randomUUID();
    const paidAt = new Date('2026-11-09T10:00:00.000Z');
    const periodEnd = new Date('2026-12-09T10:00:00.000Z');
    try {
      await connection.query(`create schema "${schemaName}"`);
      await connection.query(`set search_path to "${schemaName}"`);
      await connection.query(`
        create table organisations (id uuid primary key);
        create table users (
          id uuid primary key,
          email text not null,
          disabled_at timestamp with time zone
        );
        create table memberships (
          organisation_id uuid not null,
          user_id uuid not null,
          role varchar(16) not null,
          disabled_at timestamp with time zone,
          primary key (organisation_id, user_id)
        );
        create table audit_events (
          id uuid default gen_random_uuid() primary key,
          organisation_id uuid not null,
          actor_user_id uuid,
          event_type varchar(64) not null,
          entity_type varchar(64) not null,
          entity_id text not null,
          correlation_id text,
          before_value jsonb,
          after_value jsonb,
          occurred_at timestamp with time zone not null default now()
        );
      `);
      const applyMigration = async (name: string) => {
        const migration = await readFile(
          new URL(`../../../packages/db/drizzle/${name}.sql`, import.meta.url),
          'utf8'
        );
        for (const statement of migration.split('--> statement-breakpoint')) {
          await connection.query(
            statement.replaceAll('"public".', `"${schemaName}".`)
          );
        }
      };
      await applyMigration('0014_accountpulse_solo_commerce');
      await applyMigration('0023_reconcile_ambiguous_cancellations');
      await applyMigration('0024_lyrical_may_parker');
      await applyMigration('0035_same_azazel');

      await connection.query(
        `insert into organisations (id, edition)
         values ($1, 'SOLO'), ($2, 'SOLO')`,
        [crossEpisodeOrganisationId, validEpisodeOrganisationId]
      );
      await connection.query(
        `insert into users (id, email)
         values ($1, $3), ($2, $4)`,
        [
          crossEpisodeUserId,
          validEpisodeUserId,
          `${crossEpisodeUserId}@example.invalid`,
          `${validEpisodeUserId}@example.invalid`
        ]
      );
      await connection.query(
        `insert into memberships (organisation_id, user_id, role)
         values ($1, $2, 'ADMIN'), ($3, $4, 'ADMIN')`,
        [
          crossEpisodeOrganisationId,
          crossEpisodeUserId,
          validEpisodeOrganisationId,
          validEpisodeUserId
        ]
      );
      await connection.query(
        `insert into subscriptions (
           organisation_id, plan_code, status, stripe_provider_status,
           trusted_stripe_provider_status, stripe_customer_id,
           stripe_subscription_id, current_period_start, current_period_end,
           initial_card_invoice_id, initial_card_payment_succeeded_at
         ) values
           ($1, 'SOLO_AU_2000', 'ACTIVE', 'active', 'active',
            'cus_cross_episode', 'sub_cross_current', $3, $4,
            'in_cross_old', $3),
           ($2, 'SOLO_AU_2000', 'ACTIVE', 'active', 'active',
            'cus_valid_episode', 'sub_valid_current', $3, $4,
            'in_valid_current', $3)`,
        [
          crossEpisodeOrganisationId,
          validEpisodeOrganisationId,
          paidAt,
          periodEnd
        ]
      );
      await connection.query(
        `insert into subscription_events (
           organisation_id, stripe_event_id, event_type,
           stripe_event_created_at, payload_hash, outcome
         ) values
           ($1, 'evt_cross_old', 'checkout.session.completed', $3,
            repeat('a', 64), 'APPLIED'),
           ($2, 'evt_valid_current', 'checkout.session.completed', $3,
            repeat('b', 64), 'APPLIED')`,
        [crossEpisodeOrganisationId, validEpisodeOrganisationId, paidAt]
      );

      await applyMigration('0037_watery_tombstone');
      await applyMigration('0038_flawless_talon');
      await applyMigration('0039_amused_stranger');
      await connection.query(
        `insert into solo_checkout_attempts (
           id, organisation_id, requested_stripe_customer_id,
           billing_cadence, initiating_user_id, price_id,
           automatic_tax_enabled, public_origin, request_fingerprint,
           expires_at, stripe_session_id, stripe_session_status,
           stripe_customer_id, stripe_subscription_id, created_at, updated_at
         ) values
           ($1, $2, 'cus_cross_episode', 'MONTHLY', $3, 'price_monthly',
            true, 'https://ap.motts.com.au', repeat('c', 64), $8,
            'cs_cross_old', 'complete', 'cus_cross_episode', 'sub_cross_old',
            $7, $7),
           ($4, $5, 'cus_valid_episode', 'MONTHLY', $6, 'price_monthly',
            true, 'https://ap.motts.com.au', repeat('d', 64), $8,
            'cs_valid_current', 'complete', 'cus_valid_episode',
            'sub_valid_current', $7, $7)`,
        [
          randomUUID(),
          crossEpisodeOrganisationId,
          crossEpisodeUserId,
          randomUUID(),
          validEpisodeOrganisationId,
          validEpisodeUserId,
          paidAt,
          periodEnd
        ]
      );

      const migrations = await readdir(
        new URL('../../../packages/db/drizzle/', import.meta.url)
      );
      const reconciliationMigration = migrations.find((name) =>
        /^0040_.*\.sql$/.test(name)
      );
      const episodeEvidenceMigration = migrations.find((name) =>
        /^0042_.*\.sql$/.test(name)
      );
      expect(reconciliationMigration).toBeDefined();
      expect(episodeEvidenceMigration).toBeDefined();
      await applyMigration(reconciliationMigration!.replace(/\.sql$/, ''));
      await applyMigration(episodeEvidenceMigration!.replace(/\.sql$/, ''));

      const evidence = await connection.query<{
        organisation_id: string;
        initial_card_stripe_subscription_id: string | null;
        initial_card_invoice_id: string | null;
        legacy_initial_card_stripe_subscription_id: string | null;
        legacy_initial_card_invoice_id: string | null;
      }>(
        `select organisation_id, initial_card_stripe_subscription_id,
                initial_card_invoice_id,
                legacy_initial_card_stripe_subscription_id,
                legacy_initial_card_invoice_id
           from subscriptions
          order by organisation_id`
      );
      expect(
        evidence.rows.find(
          (row) => row.organisation_id === crossEpisodeOrganisationId
        )
      ).toMatchObject({
        initial_card_stripe_subscription_id: null,
        initial_card_invoice_id: null,
        legacy_initial_card_stripe_subscription_id: 'sub_cross_current',
        legacy_initial_card_invoice_id: 'in_cross_old'
      });
      expect(
        evidence.rows.find(
          (row) => row.organisation_id === validEpisodeOrganisationId
        )
      ).toMatchObject({
        initial_card_stripe_subscription_id: 'sub_valid_current',
        initial_card_invoice_id: 'in_valid_current',
        legacy_initial_card_stripe_subscription_id: null,
        legacy_initial_card_invoice_id: null
      });
      const quarantineAudit = await connection.query<{
        before_value: {
          stripeCustomerId: string;
          stripeSubscriptionId: string;
          invoiceId: string;
        };
        after_value: {
          reason: string;
          eligibleForDirectDebit: boolean;
        };
      }>(
        `select before_value, after_value
           from audit_events
          where organisation_id = $1
            and event_type = 'INITIAL_CARD_EVIDENCE_QUARANTINED'
            and correlation_id = 'migration:0042'`,
        [crossEpisodeOrganisationId]
      );
      expect(quarantineAudit.rows).toEqual([
        {
          before_value: {
            stripeCustomerId: 'cus_cross_episode',
            stripeSubscriptionId: 'sub_cross_current',
            invoiceId: 'in_cross_old',
            paymentSucceededAt: '2026-11-09T10:00:00+00:00'
          },
          after_value: {
            reason: 'CHECKOUT_EPISODE_IDENTITY_NOT_PROVEN',
            eligibleForDirectDebit: false
          }
        }
      ]);

      const scopedDatabase = drizzle(connection, { schema: databaseSchema });
      const repository = createPostgresSubscriptionRepository(scopedDatabase, {
        now: () => now
      });
      await expect(
        repository.requestDirectDebit({
          organisationId: crossEpisodeOrganisationId,
          requestedByUserId: crossEpisodeUserId,
          requestedAt: now
        })
      ).rejects.toThrow('DIRECT_DEBIT_CARD_PAYMENT_REQUIRED');
      await expect(
        repository.requestDirectDebit({
          organisationId: validEpisodeOrganisationId,
          requestedByUserId: validEpisodeUserId,
          requestedAt: now
        })
      ).resolves.toMatchObject({
        organisationId: validEpisodeOrganisationId,
        stripeSubscriptionId: 'sub_valid_current',
        status: 'REQUESTED'
      });
    } finally {
      await connection.query('set search_path to public');
      await connection.query(`drop schema if exists "${schemaName}" cascade`);
      connection.release();
    }
  }, 15_000);

  it('requires a positive paid card Checkout before allowing an idempotent request', async () => {
    const seeded = await seed();
    const repository = createPostgresSubscriptionRepository(client.db, {
      now: () => now
    });

    await expect(
      repository.requestDirectDebit({
        organisationId: seeded.organisationId,
        requestedByUserId: seeded.userId,
        requestedAt: now
      })
    ).rejects.toThrow('DIRECT_DEBIT_CARD_PAYMENT_REQUIRED');

    await expect(
      repository.applyOperationalEvent({
        eventId: `evt_paid_invoice_only_${seeded.organisationId}`,
        eventType: 'invoice.paid',
        eventCreatedAt: new Date('2026-11-09T11:00:00.000Z'),
        payloadHash: 'a'.repeat(64),
        stripeCustomerId: seeded.stripeCustomerId,
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        providerObjectType: 'INVOICE',
        providerObjectId: `in_out_of_band_${seeded.organisationId}`,
        providerStatus: 'paid',
        amountMinor: 0,
        currency: 'aud',
        caseKind: 'PAYMENT_FAILURE',
        targetStatus: 'RESOLVED',
        suspensionPolicy: 'NEVER',
        heldTemplate: 'PAYMENT_RECOVERED',
        resolveExistingOnly: true
      })
    ).resolves.toBe('APPLIED');

    const [afterInvoiceOnly] = await client.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organisationId, seeded.organisationId));
    expect(afterInvoiceOnly?.initialCardInvoiceId).toBeNull();
    await expect(
      repository.requestDirectDebit({
        organisationId: seeded.organisationId,
        requestedByUserId: seeded.userId,
        requestedAt: now
      })
    ).rejects.toThrow('DIRECT_DEBIT_CARD_PAYMENT_REQUIRED');

    await expect(
      repository.applyCheckoutCompleted({
        organisationId: seeded.organisationId,
        eventId: `evt_initial_card_checkout_${seeded.organisationId}`,
        eventType: 'checkout.session.completed',
        eventCreatedAt: new Date('2026-11-09T11:05:00.000Z'),
        payloadHash: 'c'.repeat(64),
        stripeCustomerId: seeded.stripeCustomerId,
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        initialCardInvoiceId: `in_initial_${seeded.organisationId}`,
        initialCardPaymentSucceededAt: new Date(
          '2026-11-09T11:05:00.000Z'
        )
      })
    ).resolves.toBe('APPLIED');

    const [subscription] = await client.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organisationId, seeded.organisationId));
    expect(subscription).toMatchObject({
      initialCardInvoiceId: `in_initial_${seeded.organisationId}`,
      initialCardPaymentSucceededAt: new Date('2026-11-09T11:05:00.000Z')
    });

    const input = {
      organisationId: seeded.organisationId,
      requestedByUserId: seeded.userId,
      requestedAt: now
    };
    await expect(repository.requestDirectDebit(input)).resolves.toMatchObject({
      status: 'REQUESTED'
    });
    await expect(repository.requestDirectDebit(input)).resolves.toMatchObject({
      status: 'REQUESTED',
      requestedAt: now
    });
  });

  it('requires setup before signed mandate evidence and exact evidence before activation', async () => {
    const seeded = await seed(true);
    const repository = createPostgresSubscriptionRepository(client.db, {
      now: () => now
    });
    const request = await repository.requestDirectDebit({
      organisationId: seeded.organisationId,
      requestedByUserId: seeded.userId,
      requestedAt: now
    });

    const mandateInput = {
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      setupAttemptVersion: 1,
      eventId: `evt_mandate_${seeded.organisationId}`,
      eventType: 'setup_intent.succeeded' as const,
      eventCreatedAt: new Date('2026-11-09T12:15:00.000Z'),
      payloadHash: 'b'.repeat(64),
      stripeCustomerId: seeded.stripeCustomerId,
      setupIntentId: `seti_${seeded.organisationId}`,
      stripePaymentMethodId: `pm_${seeded.organisationId}`,
      stripeMandateId: `mandate_${seeded.organisationId}`
    };
    await expect(
      repository.confirmDirectDebitMandate(mandateInput)
    ).resolves.toBe('REJECTED');
    await expect(
      repository.activateDirectDebit({
        organisationId: seeded.organisationId,
        directDebitRequestId: request.id,
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        activatedByUserId: seeded.userId,
        activatedAt: now,
        stripePaymentMethodId: mandateInput.stripePaymentMethodId,
        stripeMandateId: mandateInput.stripeMandateId
      })
    ).rejects.toThrow('DIRECT_DEBIT_MANDATE_REQUIRED');

    await repository.markDirectDebitSetupPending({
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      actorUserId: seeded.userId,
      setupAttemptVersion: 1,
      setupSessionId: `cs_setup_${seeded.organisationId}`,
      setupSessionExpiresAt: new Date('2026-11-10T12:00:00.000Z'),
      occurredAt: now
    });
    await expect(
      repository.bindDirectDebitSetupCheckout({
        organisationId: seeded.organisationId,
        directDebitRequestId: request.id,
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        setupAttemptVersion: 1,
        eventId: `evt_setup_checkout_${seeded.organisationId}`,
        eventType: 'checkout.session.completed',
        eventCreatedAt: new Date('2026-11-09T12:10:00.000Z'),
        payloadHash: 'd'.repeat(64),
        stripeCustomerId: seeded.stripeCustomerId,
        setupSessionId: `cs_setup_${seeded.organisationId}`,
        setupSessionExpiresAt: new Date('2026-11-10T12:00:00.000Z'),
        setupIntentId: mandateInput.setupIntentId
      })
    ).resolves.toBe('APPLIED');
    await expect(
      repository.confirmDirectDebitMandate({
        ...mandateInput,
        eventId: `evt_mandate_applied_${seeded.organisationId}`
      })
    ).resolves.toBe('APPLIED');
    await expect(
      repository.confirmDirectDebitMandate({
        ...mandateInput,
        eventId: `evt_mandate_applied_${seeded.organisationId}`
      })
    ).resolves.toBe('DUPLICATE');

    await expect(
      repository.activateDirectDebit({
        organisationId: seeded.organisationId,
        directDebitRequestId: request.id,
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        activatedByUserId: seeded.userId,
        activatedAt: new Date('2026-11-09T12:30:00.000Z'),
        stripePaymentMethodId: 'pm_wrong',
        stripeMandateId: mandateInput.stripeMandateId
      })
    ).rejects.toThrow('DIRECT_DEBIT_MANDATE_REQUIRED');
    await expect(
      repository.activateDirectDebit({
        organisationId: seeded.organisationId,
        directDebitRequestId: request.id,
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        activatedByUserId: seeded.userId,
        activatedAt: new Date('2026-11-09T12:30:00.000Z'),
        stripePaymentMethodId: mandateInput.stripePaymentMethodId,
        stripeMandateId: mandateInput.stripeMandateId
      })
    ).resolves.toMatchObject({ status: 'ACTIVE' });

    const [stored] = await client.db
      .select()
      .from(directDebitRequests)
      .where(eq(directDebitRequests.organisationId, seeded.organisationId));
    expect(stored).toMatchObject({
      status: 'ACTIVE',
      setupSessionId: `cs_setup_${seeded.organisationId}`,
      setupIntentId: mandateInput.setupIntentId,
      stripePaymentMethodId: mandateInput.stripePaymentMethodId,
      stripeMandateId: mandateInput.stripeMandateId
    });
  });

  it('versions an expired setup retry and rejects evidence from the abandoned link', async () => {
    const seeded = await seed(true);
    const repository = createPostgresSubscriptionRepository(client.db, {
      now: () => new Date('2026-11-09T13:00:00.000Z')
    });
    const request = await repository.requestDirectDebit({
      organisationId: seeded.organisationId,
      requestedByUserId: seeded.userId,
      requestedAt: now
    });
    const firstExpiry = new Date('2026-11-09T12:30:00.000Z');
    await repository.markDirectDebitSetupPending({
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      actorUserId: seeded.userId,
      setupAttemptVersion: 1,
      setupSessionId: `cs_first_${seeded.organisationId}`,
      setupSessionExpiresAt: firstExpiry,
      occurredAt: now
    });
    await repository.bindDirectDebitSetupCheckout({
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      setupAttemptVersion: 1,
      eventId: `evt_first_setup_${seeded.organisationId}`,
      eventType: 'checkout.session.completed',
      eventCreatedAt: new Date('2026-11-09T12:10:00.000Z'),
      payloadHash: '1'.repeat(64),
      stripeCustomerId: seeded.stripeCustomerId,
      setupSessionId: `cs_first_${seeded.organisationId}`,
      setupSessionExpiresAt: firstExpiry,
      setupIntentId: `seti_first_${seeded.organisationId}`
    });

    const secondExpiry = new Date('2026-11-10T13:00:00.000Z');
    await repository.markDirectDebitSetupPending({
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      actorUserId: seeded.userId,
      setupAttemptVersion: 2,
      setupSessionId: `cs_second_${seeded.organisationId}`,
      setupSessionExpiresAt: secondExpiry,
      occurredAt: new Date('2026-11-09T13:00:00.000Z')
    });

    await expect(
      repository.bindDirectDebitSetupCheckout({
        organisationId: seeded.organisationId,
        directDebitRequestId: request.id,
        stripeSubscriptionId: seeded.stripeSubscriptionId,
        setupAttemptVersion: 1,
        eventId: `evt_late_first_setup_${seeded.organisationId}`,
        eventType: 'checkout.session.completed',
        eventCreatedAt: new Date('2026-11-09T13:05:00.000Z'),
        payloadHash: '2'.repeat(64),
        stripeCustomerId: seeded.stripeCustomerId,
        setupSessionId: `cs_first_${seeded.organisationId}`,
        setupSessionExpiresAt: firstExpiry,
        setupIntentId: `seti_first_${seeded.organisationId}`
      })
    ).resolves.toBe('REJECTED');

    const current = await repository.loadDirectDebitRequest(
      seeded.organisationId
    );
    expect(current).toMatchObject({
      setupAttemptVersion: 2,
      setupSessionId: `cs_second_${seeded.organisationId}`,
      setupSessionExpiresAt: secondExpiry,
      setupCheckoutCompletedAt: null,
      setupIntentId: null
    });
  });

  it('preserves an old active mandate but requires a fresh request for a replacement subscription', async () => {
    const seeded = await seed(true);
    const repository = createPostgresSubscriptionRepository(client.db, {
      now: () => now
    });
    const request = await repository.requestDirectDebit({
      organisationId: seeded.organisationId,
      requestedByUserId: seeded.userId,
      requestedAt: now
    });
    await repository.markDirectDebitSetupPending({
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      actorUserId: seeded.userId,
      setupAttemptVersion: 1,
      setupSessionId: `cs_old_${seeded.organisationId}`,
      setupSessionExpiresAt: new Date('2026-11-10T12:00:00.000Z'),
      occurredAt: now
    });
    const mandate = {
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      setupAttemptVersion: 1,
      eventId: `evt_old_mandate_${seeded.organisationId}`,
      eventType: 'setup_intent.succeeded' as const,
      eventCreatedAt: new Date('2026-11-09T12:05:00.000Z'),
      payloadHash: 'e'.repeat(64),
      stripeCustomerId: seeded.stripeCustomerId,
      setupIntentId: `seti_old_${seeded.organisationId}`,
      stripePaymentMethodId: `pm_old_${seeded.organisationId}`,
      stripeMandateId: `mandate_old_${seeded.organisationId}`
    };
    await repository.bindDirectDebitSetupCheckout({
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      setupAttemptVersion: 1,
      eventId: `evt_old_setup_checkout_${seeded.organisationId}`,
      eventType: 'checkout.session.completed',
      eventCreatedAt: new Date('2026-11-09T12:02:00.000Z'),
      payloadHash: 'f'.repeat(64),
      stripeCustomerId: seeded.stripeCustomerId,
      setupSessionId: `cs_old_${seeded.organisationId}`,
      setupSessionExpiresAt: new Date('2026-11-10T12:00:00.000Z'),
      setupIntentId: mandate.setupIntentId
    });
    await expect(
      repository.confirmDirectDebitMandate(mandate)
    ).resolves.toBe('APPLIED');
    await repository.activateDirectDebit({
      organisationId: seeded.organisationId,
      directDebitRequestId: request.id,
      stripeSubscriptionId: seeded.stripeSubscriptionId,
      activatedByUserId: seeded.userId,
      activatedAt: new Date('2026-11-09T12:10:00.000Z'),
      stripePaymentMethodId: mandate.stripePaymentMethodId,
      stripeMandateId: mandate.stripeMandateId
    });

    const replacementSubscriptionId = `sub_replacement_${seeded.organisationId}`;
    await client.db
      .update(subscriptions)
      .set({
        stripeSubscriptionId: replacementSubscriptionId,
        initialCardStripeSubscriptionId: replacementSubscriptionId,
        initialCardInvoiceId: `in_replacement_${seeded.organisationId}`,
        initialCardPaymentSucceededAt: new Date('2026-11-10T09:00:00.000Z')
      })
      .where(eq(subscriptions.organisationId, seeded.organisationId));

    await expect(
      repository.loadDirectDebitRequest(seeded.organisationId)
    ).resolves.toBeNull();
    await expect(
      repository.requestDirectDebit({
        organisationId: seeded.organisationId,
        requestedByUserId: seeded.userId,
        requestedAt: new Date('2026-11-10T09:05:00.000Z')
      })
    ).resolves.toMatchObject({ status: 'REQUESTED' });

    const history = await client.db
      .select()
      .from(directDebitRequests)
      .where(eq(directDebitRequests.organisationId, seeded.organisationId));
    expect(history).toHaveLength(2);
    expect(history.map((request) => request.status).sort()).toEqual([
      'ACTIVE',
      'REQUESTED'
    ]);
  });

  it.each([
    ['disabled', { disabledAt: now }],
    ['no longer an Admin', { role: 'OPERATOR' as const }]
  ])('withholds setup delivery when the requester is %s', async (_label, update) => {
    const seeded = await seed(true);
    const repository = createPostgresSubscriptionRepository(client.db, {
      now: () => now
    });
    await repository.requestDirectDebit({
      organisationId: seeded.organisationId,
      requestedByUserId: seeded.userId,
      requestedAt: now
    });
    await client.db
      .update(memberships)
      .set(update)
      .where(
        eq(memberships.organisationId, seeded.organisationId)
      );

    await expect(
      repository.loadDirectDebitRequesterEmail(seeded.organisationId)
    ).resolves.toBeNull();
  });
});
