import { readdir, readFile } from 'node:fs/promises';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  billingCases,
  smsAllowanceSettings,
  smsNumberPool,
  smsUsageLedger,
  soloAu2000PlanCode,
  subscriptionEvents,
  subscriptions,
  transactionalEmailOutbox
} from './commerce.js';
import { organisationOnboarding } from './onboarding.js';
import { organisationEditions, organisations } from './organisation.js';

describe('Solo commerce schema contract', () => {
  it('defines durable billing cases and held transactional email records', () => {
    const cases = getTableConfig(billingCases);
    const emails = getTableConfig(transactionalEmailOutbox);

    expect(cases.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'organisation_id',
        'kind',
        'status',
        'provider_object_type',
        'provider_object_id',
        'provider_status',
        'stripe_subscription_id',
        'subscription_relation',
        'amount_minor',
        'currency',
        'blocks_sending',
        'latest_provider_event_id',
        'latest_provider_event_created_at',
        'opened_at',
        'resolved_at',
        'created_at',
        'updated_at'
      ])
    );
    expect(cases.indexes.map((index) => index.config.name)).toContain(
      'billing_cases_org_kind_provider_uq'
    );
    expect(cases.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'billing_cases_kind_ck',
        'billing_cases_status_ck',
        'billing_cases_provider_object_type_ck',
        'billing_cases_subscription_relation_ck',
        'billing_cases_amount_ck',
        'billing_cases_currency_ck',
        'billing_cases_resolution_ck'
      ])
    );

    expect(emails.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'organisation_id',
        'billing_case_id',
        'recipient',
        'template',
        'template_version',
        'render_data',
        'idempotency_key',
        'source_event_id',
        'status',
        'attempts',
        'last_failure_code',
        'last_attempted_at',
        'sent_at',
        'created_at',
        'updated_at'
      ])
    );
    expect(emails.indexes.map((index) => index.config.name)).toContain(
      'transactional_email_outbox_org_idempotency_uq'
    );
    expect(emails.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'transactional_email_outbox_template_ck',
        'transactional_email_outbox_status_ck',
        'transactional_email_outbox_template_version_ck',
        'transactional_email_outbox_attempts_ck',
        'transactional_email_outbox_sent_ck'
      ])
    );
  });

  it('keeps the Australian Solo plan and organisation editions stable', () => {
    expect(soloAu2000PlanCode).toBe('SOLO_AU_2000');
    expect(organisationEditions).toEqual([
      'INTERNAL_LEGACY',
      'SOLO'
    ]);
    expect(organisations.edition.default).toBe('INTERNAL_LEGACY');
  });

  it('defines dedicated numeric reply numbers and an append-only SMS ledger', () => {
    const numbers = getTableConfig(smsNumberPool);
    const settings = getTableConfig(smsAllowanceSettings);
    const ledger = getTableConfig(smsUsageLedger);

    expect(numbers.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'e164_number',
        'provider',
        'provider_number_id',
        'provider_verified_at',
        'status',
        'organisation_id',
        'quarantine_until'
      ])
    );
    expect(numbers.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        'sms_number_pool_e164_uq',
        'sms_number_pool_active_org_uq'
      ])
    );
    expect(numbers.checks.map((constraint) => constraint.name)).toContain(
      'sms_number_pool_provider_verification_ck'
    );
    expect(settings.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'included_parts',
        'warning_percent',
        'overage_enabled',
        'overage_cap_cents',
        'overage_cents_per_part'
      ])
    );
    expect(ledger.indexes.map((index) => index.config.name)).toContain(
      'sms_usage_ledger_org_idempotency_uq'
    );
  });

  it('defines subscriptions, idempotent events and versioned onboarding', () => {
    const subscription = getTableConfig(subscriptions);
    const event = getTableConfig(subscriptionEvents);
    const onboarding = getTableConfig(organisationOnboarding);

    expect(subscription.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'plan_code',
        'status',
        'stripe_customer_id',
        'stripe_subscription_id',
        'current_period_start',
        'current_period_end',
        'trial_ends_at',
        'cancel_at',
        'cancelled_at',
        'last_stripe_event_created_at'
      ])
    );
    expect(event.indexes.map((index) => index.config.name)).toContain(
      'subscription_events_stripe_event_uq'
    );
    expect(event.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'provider_object_type',
        'provider_object_id',
        'billing_case_kind',
        'billing_case_status',
        'blocks_sending',
        'amount_minor',
        'held_template'
      ])
    );
    expect(event.indexes.map((index) => index.config.name)).toContain(
      'subscription_events_operational_order_idx'
    );
    expect(onboarding.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'version',
        'xero_connected_at',
        'sync_reconciled_at',
        'business_details_completed_at',
        'admin_mobile',
        'pending_admin_mobile',
        'admin_mobile_otp_hash',
        'admin_mobile_otp_expires_at',
        'admin_mobile_otp_attempts',
        'admin_mobile_otp_sent_at',
        'admin_mobile_verified_at',
        'test_sms_completed_at',
        'sequence_reviewed_at',
        'subscription_ready_at',
        'reply_number_ready_at',
        'completed_version'
      ])
    );
  });

  it('migrates existing organisations to legacy without changing live controls', async () => {
    const migration = await readFile(
      new URL('../../drizzle/0014_accountpulse_solo_commerce.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain(
      `ADD COLUMN "edition" varchar(24) DEFAULT 'INTERNAL_LEGACY' NOT NULL`
    );
    expect(migration).not.toMatch(
      /update\s+"organisations"\s+set\s+"(?:send_mode|rollout_scope|live_send_acknowledged|maintenance_mode|operational_state)"/i
    );
    expect(migration).toContain(
      "in ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END', 'CANCELLED', 'INCOMPLETE')"
    );
  });

  it('normalizes untrusted scheduled cancellations after provenance triggers', async () => {
    const migration = await readFile(new URL('../../drizzle/0023_reconcile_ambiguous_cancellations.sql', import.meta.url), 'utf8');
    expect(migration).toMatch(/CREATE FUNCTION subscription_normalize_untrusted_cancellation\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$[\s\S]*?END;\s*\$\$;/);
    expect(migration).toMatch(/IF NEW\.status = 'CANCEL_AT_PERIOD_END' AND NEW\.trusted_stripe_provider_status IS DISTINCT FROM 'active' THEN\s+NEW\.status := 'INCOMPLETE'/i);
    expect(migration).toMatch(/CREATE TRIGGER z_subscription_normalize_cancellation BEFORE INSERT OR UPDATE ON subscriptions/i);
  });

  it('orders migration journal timestamps strictly through the billing operations migration', async () => {
    const journal = JSON.parse(await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const entries = journal.entries.filter((entry) => entry.idx <= 25);
    expect(entries.map((entry) => entry.idx)).toEqual(Array.from({ length: 26 }, (_, index) => index));
    expect(entries[25]?.tag).toBe('0025_orange_rattler');
    for (let index = 1; index < entries.length; index += 1) {
      expect(entries[index]!.when).toBeGreaterThan(entries[index - 1]!.when);
    }
  });

  it('creates billing cases and held email storage in migration 0025', async () => {
    const migration = await readFile(
      new URL('../../drizzle/0025_orange_rattler.sql', import.meta.url),
      'utf8'
    );

    expect(migration).toContain('CREATE TABLE "billing_cases"');
    expect(migration).toContain('CREATE TABLE "transactional_email_outbox"');
    expect(migration).toContain('ON DELETE restrict');
  });

  it('adds operational ordering evidence and immutable email render data in migration 0026', async () => {
    const migrationDirectory = new URL('../../drizzle/', import.meta.url);
    const migrationName = (await readdir(migrationDirectory)).find((name) =>
      /^0026_.*\.sql$/.test(name)
    );
    expect(migrationName).toBeDefined();
    const migration = await readFile(
      new URL(migrationName!, migrationDirectory),
      'utf8'
    );

    expect(migration).toContain('subscription_events_operational_order_idx');
    expect(migration).toContain('source_event_id');
    expect(migration).toMatch(
      /CREATE TRIGGER transactional_email_render_data_immutable/i
    );
    expect(migration).toMatch(
      /OLD\.render_data IS DISTINCT FROM NEW\.render_data/i
    );
  });

  it('keeps generated migration journal timestamps in strict execution order', async () => {
    const journal = JSON.parse(
      await readFile(
        new URL('../../drizzle/meta/_journal.json', import.meta.url),
        'utf8'
      )
    ) as { entries: Array<{ idx: number; when: number }> };

    for (let index = 1; index < journal.entries.length; index += 1) {
      expect(journal.entries[index]!.idx).toBeGreaterThan(
        journal.entries[index - 1]!.idx
      );
      expect(journal.entries[index]!.when).toBeGreaterThan(
        journal.entries[index - 1]!.when
      );
    }
  });

  it('makes every transactional-email evidence identity immutable in migration 0027', async () => {
    const migration = await readFile(
      new URL(
        '../../drizzle/0027_transactional_email_evidence_immutability.sql',
        import.meta.url
      ),
      'utf8'
    );

    for (const column of [
      'organisation_id',
      'billing_case_id',
      'recipient',
      'template',
      'template_version',
      'render_data',
      'idempotency_key',
      'source_event_id'
    ]) {
      expect(migration).toContain(
        `OLD.${column} IS DISTINCT FROM NEW.${column}`
      );
    }
    expect(migration).not.toMatch(/OLD\.status IS DISTINCT FROM NEW\.status/);
    expect(migration).not.toMatch(/OLD\.attempts IS DISTINCT FROM NEW\.attempts/);
  });

  it('creates retired subscription storage and does not grant a future trial during backfill', async () => {
    const migration = await readFile(new URL('../../drizzle/0024_lyrical_may_parker.sql', import.meta.url), 'utf8');
    expect(migration).toMatch(/CREATE TABLE "retired_stripe_subscriptions"/i);
    expect(migration).toContain(`UPDATE "subscriptions" AS s SET "trial_ends_at" = LEAST(s."created_at" + interval '14 days', now())`);
    expect(migration).toContain(`o."edition" = 'SOLO' AND s."trial_ends_at" IS NULL`);
  });

  it('adds SMS commerce storage without mutating existing live organisations', async () => {
    const migration = await readFile(
      new URL(
        '../../drizzle/0018_keen_shadow_king.sql',
        import.meta.url
      ),
      'utf8'
    );

    expect(migration).toContain('CREATE TABLE "sms_number_pool"');
    expect(migration).toContain('CREATE TABLE "sms_usage_ledger"');
    expect(migration).toContain("'^[+]61[0-9]{9}$'");
    expect(migration).not.toMatch(
      /update\s+"organisations"\s+set\s+"(?:send_mode|rollout_scope|live_send_acknowledged|maintenance_mode|operational_state)"/i
    );
  });
});
