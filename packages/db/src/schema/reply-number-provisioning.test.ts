import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { replyNumberProvisioningRequests } from './reply-number-provisioning.js';

describe('reply-number provisioning schema', () => {
  it('defines one versioned, provider-neutral manual order record', () => {
    const table = getTableConfig(replyNumberProvisioningRequests);

    expect(table.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'organisation_id',
        'provider',
        'request_key',
        'attempt',
        'version',
        'status',
        'quote_setup_fee_minor',
        'quote_monthly_fee_minor',
        'quote_currency',
        'quote_expires_at',
        'quoted_at',
        'documentation_status',
        'documentation_evidence_reference',
        'approved_by_user_id',
        'approved_at',
        'approval_reason',
        'external_order_reference',
        'manual_order_recorded_at',
        'fulfilled_number_id',
        'failure_code',
        'failed_at',
        'expired_at',
        'created_at',
        'updated_at'
      ])
    );
    expect(table.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        'reply_number_requests_request_key_uq',
        'reply_number_requests_org_attempt_uq',
        'reply_number_requests_active_org_uq'
      ])
    );
    expect(table.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'reply_number_requests_provider_ck',
        'reply_number_requests_status_ck',
        'reply_number_requests_attempt_version_ck',
        'reply_number_requests_quote_amount_ck',
        'reply_number_requests_quote_bundle_ck',
        'reply_number_requests_documentation_ck',
        'reply_number_requests_approval_ck',
        'reply_number_requests_external_order_ck',
        'reply_number_requests_failed_provenance_ck',
        'reply_number_requests_fulfilment_ck',
        'reply_number_requests_failure_ck',
        'reply_number_requests_expiry_ck'
      ])
    );
    expect(table.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
      'reply_number_requests_number_fk'
    );
  });
});
