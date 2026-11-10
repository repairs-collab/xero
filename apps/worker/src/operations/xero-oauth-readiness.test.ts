import { describe, expect, it } from 'vitest';

import {
  createXeroOAuthReadinessService,
  parseXeroOAuthReadinessCommand,
  type XeroOAuthReadinessSnapshot
} from './xero-oauth-readiness.js';

const completeSnapshot = (): XeroOAuthReadinessSnapshot => ({
  organisationId: 'organisation-one',
  xeroOrganisationId: 'tenant-one',
  organisationName: 'Motts Appliance Repairs',
  sendMode: 'live',
  rolloutScope: 'CUSTOMER',
  liveSendAcknowledged: true,
  legacyConnectionPresent: true,
  legacyConnectionEnabled: true,
  oauthConnectionStatus: 'CONNECTED',
  oauthTenantId: 'tenant-one',
  grantedScopes: [
    'openid',
    'profile',
    'email',
    'offline_access',
    'accounting.invoices',
    'accounting.contacts.read',
    'accounting.settings.read'
  ],
  lastSuccessfulSyncAt: new Date('2026-11-09T01:00:00.000Z'),
  operationalState: 'RECONCILED',
  latestReconciledSyncAt: new Date('2026-11-09T01:05:00.000Z'),
  outstandingInvoiceCount: 203,
  outstandingAmountDue: '61186.3300'
});

describe('Xero OAuth cutover readiness', () => {
  it('parses only the bounded read-only readiness command', () => {
    expect(
      parseXeroOAuthReadinessCommand([
        'xero-oauth-readiness',
        '--organisation-id',
        'organisation-one'
      ])
    ).toEqual({ organisationId: 'organisation-one' });
    expect(parseXeroOAuthReadinessCommand([])).toBeNull();
    expect(() =>
      parseXeroOAuthReadinessCommand(['xero-oauth-readiness'])
    ).toThrow('organisation-id is required');
    expect(() =>
      parseXeroOAuthReadinessCommand([
        'xero-oauth-readiness',
        '--organisation-id',
        'organisation-one',
        '--disable-legacy',
        'true'
      ])
    ).toThrow('Unsupported Xero OAuth readiness flag');
  });

  it('reports legacy and OAuth evidence, tenant match, scopes, reconciliation and totals without secrets', async () => {
    const service = createXeroOAuthReadinessService({
      load: () => Promise.resolve(completeSnapshot())
    });

    const report = await service.run('organisation-one');

    expect(report).toMatchObject({
      organisationId: 'organisation-one',
      legacy: { present: true, enabled: true },
      oauth: {
        status: 'CONNECTED',
        tenantId: 'tenant-one',
        tenantMatchesOrganisation: true,
        missingScopes: []
      },
      synchronisation: {
        operationalState: 'RECONCILED',
        outstandingInvoiceCount: 203,
        outstandingAmountDue: '61186.3300'
      },
      readyForApprovedCutover: true
    });
    expect(JSON.stringify(report)).not.toMatch(
      /refresh|access.?token|client.?secret|ciphertext|secretArn/i
    );
  });

  it('is read-only across live sending, sequences, approvals, messages and connection enablement', async () => {
    const state = {
      snapshot: completeSnapshot(),
      sequences: [{ id: 'sequence-one', enabled: true }],
      approvals: [{ id: 'approval-one', status: 'APPROVED' }],
      messages: [{ id: 'message-one', state: 'SENT' }]
    };
    const before = structuredClone(state);
    const service = createXeroOAuthReadinessService({
      load: () => Promise.resolve(state.snapshot)
    });

    await service.run('organisation-one');

    expect(state).toEqual(before);
    expect(state.snapshot).toMatchObject({
      sendMode: 'live',
      rolloutScope: 'CUSTOMER',
      liveSendAcknowledged: true,
      legacyConnectionEnabled: true
    });
  });
});
