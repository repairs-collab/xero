import { readFile } from 'node:fs/promises';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  smsAllowanceSettings,
  smsNumberPool,
  smsUsageLedger,
  soloAu2000PlanCode,
  subscriptionEvents,
  subscriptions
} from './commerce.js';
import { organisationOnboarding } from './onboarding.js';
import { organisationEditions, organisations } from './organisation.js';

describe('Solo commerce schema contract', () => {
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

  it('orders migration journal timestamps strictly through the retired subscription migration', async () => {
    const journal = JSON.parse(await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const entries = journal.entries.filter((entry) => entry.idx <= 24);
    expect(entries.map((entry) => entry.idx)).toEqual(Array.from({ length: 25 }, (_, index) => index));
    expect(entries[24]?.tag).toBe('0024_lyrical_may_parker');
    for (let index = 1; index < entries.length; index += 1) {
      expect(entries[index]!.when).toBeGreaterThan(entries[index - 1]!.when);
    }
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
