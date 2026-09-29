import { createHash } from 'node:crypto';

import {
  approvals,
  auditEvents,
  contactChannels,
  contacts,
  conversations,
  createDatabase,
  inboundMessages,
  invoiceChases,
  invoices,
  memberships,
  migrateDatabase,
  operationalResetRuns,
  organisations,
  outboundMessages,
  pauses,
  providerConnections,
  reminderSequences,
  reminderSequenceVersions,
  rolloutReconciliations,
  sequenceStages,
  stageInstances,
  suppressions,
  tasks,
  users
} from '@bc5000/db';

import { launchScenario as scenario } from './scenarios.js';
import {
  finalRolloutFixtureIds,
  finalRolloutScenarios,
  type FinalRolloutScenarioName
} from './final-rollout-scenarios.js';

export async function seedLaunchScenario(
  databaseUrl: string,
  rolloutScenario: FinalRolloutScenarioName = 'dryRun'
): Promise<void> {
  const client = createDatabase(databaseUrl);
  try {
    await migrateDatabase(client.db);
    await client.pool.query('TRUNCATE TABLE organisations, users CASCADE');
    const now = new Date(scenario.now);
    await client.db.insert(organisations).values({
      id: scenario.organisationId,
      xeroOrganisationId: 'xero-org-bill-chaser-5000',
      name: 'Bill Chaser 5000',
      timeZone: 'Australia/Sydney',
      baseCurrency: 'AUD',
      sendMode: 'dry-run',
      recipientAllowlist: [scenario.mobile],
      lastSuccessfulSyncAt: now
    });
    await client.db.insert(users).values([
      {
        id: scenario.adminUserId,
        cognitoSubject: scenario.adminSubject,
        email: 'admin@billchaser.test',
        displayName: 'Alex Admin'
      },
      {
        id: scenario.operatorUserId,
        cognitoSubject: scenario.operatorSubject,
        email: 'operator@billchaser.test',
        displayName: 'Olivia Operator'
      }
    ]);
    await client.db.insert(memberships).values([
      {
        organisationId: scenario.organisationId,
        userId: scenario.adminUserId,
        role: 'ADMIN'
      },
      {
        organisationId: scenario.organisationId,
        userId: scenario.operatorUserId,
        role: 'OPERATOR'
      }
    ]);
    await client.db.insert(providerConnections).values([
      {
        organisationId: scenario.organisationId,
        provider: 'XERO',
        secretArn: 'arn:aws:secretsmanager:ap-southeast-2:000000000000:secret:e2e/xero',
        enabled: true,
        connectedAt: now,
        lastSuccessfulAuthenticationAt: now
      },
      {
        organisationId: scenario.organisationId,
        provider: 'SINCH',
        secretArn: 'arn:aws:secretsmanager:ap-southeast-2:000000000000:secret:e2e/sinch',
        region: 'APAC',
        callbackKeyId: 'harness-sinch-key',
        enabled: true,
        connectedAt: now,
        lastSuccessfulAuthenticationAt: now
      }
    ]);
    await client.db.insert(contacts).values({
      id: scenario.contactId,
      organisationId: scenario.organisationId,
      xeroContactId: 'xero-contact-acme',
      name: scenario.customerName,
      email: 'accounts@acme.test',
      sourceVersion: 1
    });
    await client.db.insert(contactChannels).values({
      organisationId: scenario.organisationId,
      contactId: scenario.contactId,
      kind: 'SMS',
      sourceValue: '0400 000 001',
      normalisedValue: scenario.mobile,
      usable: true
    });
    await client.db.insert(invoices).values({
      id: scenario.invoiceId,
      organisationId: scenario.organisationId,
      xeroInvoiceId: 'xero-invoice-5000',
      contactId: scenario.contactId,
      invoiceNumber: scenario.invoiceNumber,
      type: 'ACCREC',
      status: 'AUTHORISED',
      issueDate: '2026-08-18',
      dueDate: '2026-09-18',
      amountDue: '100.00',
      total: '100.00',
      currency: 'AUD',
      onlineInvoiceUrl: 'https://in.xero.com/invoice/inv-5000',
      syncVersion: 1,
      xeroUpdatedAt: now
    });
    await client.db.insert(reminderSequences).values({
      id: scenario.sequenceId,
      organisationId: scenario.organisationId,
      name: 'Standard bill chasing',
      mode: 'REVIEW',
      enabled: true
    });
    await client.db.insert(reminderSequenceVersions).values({
      id: scenario.sequenceVersionId,
      organisationId: scenario.organisationId,
      sequenceId: scenario.sequenceId,
      versionNumber: 1,
      status: 'ACTIVE',
      dailyBasis: 'BUSINESS_DAYS',
      smsAggregation: 'CONSOLIDATED_CUSTOMER',
      sendTime: '09:00:00',
      socialWindowStart: '08:00:00',
      socialWindowEnd: '18:00:00',
      minimumBalance: '10.00',
      maxSmsSegments: 3,
      xeroEmailAfterSmsOptOut: true,
      configuration: { allowedCurrencies: ['AUD'] },
      activatedAt: now,
      createdByUserId: scenario.adminUserId
    });
    await client.db.insert(sequenceStages).values([
      {
        organisationId: scenario.organisationId,
        sequenceVersionId: scenario.sequenceVersionId,
        stageKey: 'due-date',
        offsetDays: 0,
        channel: 'SMS',
        template: 'Hi {{customer_name}}, invoice {{invoice_number}} is due today.'
      },
      {
        organisationId: scenario.organisationId,
        sequenceVersionId: scenario.sequenceVersionId,
        stageKey: 'seven-days',
        offsetDays: 7,
        channel: 'SMS',
        template: 'Invoice {{invoice_number}} is now seven days overdue.'
      },
      {
        organisationId: scenario.organisationId,
        sequenceVersionId: scenario.sequenceVersionId,
        stageKey: 'seven-days',
        offsetDays: 7,
        channel: 'XERO_EMAIL'
      },
      {
        organisationId: scenario.organisationId,
        sequenceVersionId: scenario.sequenceVersionId,
        stageKey: 'final-warning',
        offsetDays: 21,
        channel: 'SMS',
        template: 'Final reminder for {{invoice_number}}.'
      },
      {
        organisationId: scenario.organisationId,
        sequenceVersionId: scenario.sequenceVersionId,
        stageKey: 'manual-escalation',
        offsetDays: 30,
        channel: 'TASK'
      },
      {
        organisationId: scenario.organisationId,
        sequenceVersionId: scenario.sequenceVersionId,
        stageKey: 'daily-after-30',
        offsetDays: 30,
        channel: 'SMS_DAILY',
        template: 'Your overdue balance remains outstanding.'
      }
    ]);
    await client.db.insert(invoiceChases).values({
      id: scenario.chaseId,
      organisationId: scenario.organisationId,
      invoiceId: scenario.invoiceId,
      sequenceId: scenario.sequenceId,
      customerId: scenario.contactId,
      status: 'PAUSED'
    });
    await client.db.insert(stageInstances).values([
      {
        id: scenario.dueDateStageId,
        organisationId: scenario.organisationId,
        invoiceChaseId: scenario.chaseId,
        sequenceVersionId: scenario.sequenceVersionId,
        stageKey: 'due-date',
        channel: 'SMS',
        status: 'PENDING_APPROVAL',
        scheduledAt: now,
        sourceVersion: 1
      },
      {
        id: scenario.dailyStageId,
        organisationId: scenario.organisationId,
        invoiceChaseId: scenario.chaseId,
        sequenceVersionId: scenario.sequenceVersionId,
        stageKey: 'daily-after-30',
        channel: 'SMS',
        status: 'SCHEDULED',
        scheduledAt: new Date('2026-09-19T00:00:00.000Z'),
        sourceVersion: 1
      }
    ]);
    await client.db.insert(approvals).values({
      id: scenario.approvalId,
      organisationId: scenario.organisationId,
      stageInstanceId: scenario.dueDateStageId,
      renderedPreview: 'Hi Acme Workshop, invoice INV-5000 is due today.',
      sourceVersion: 1,
      status: 'PENDING',
      expiresAt: new Date('2099-09-18T00:00:00.000Z')
    });
    await client.db.insert(conversations).values({
      id: scenario.conversationId,
      organisationId: scenario.organisationId,
      contactId: scenario.contactId,
      normalisedNumber: scenario.mobile,
      unreadCount: 1,
      lastMessageAt: now
    });
    const inboundBody = 'Can we pay Friday?';
    await client.db.insert(inboundMessages).values({
      organisationId: scenario.organisationId,
      conversationId: scenario.conversationId,
      provider: 'SINCH',
      providerMessageId: 'sinch-inbound-1',
      body: inboundBody,
      bodyHash: createHash('sha256').update(inboundBody).digest('hex'),
      providerPayload: { event_type: 'RECEIVED_SMS' },
      receivedAt: now
    });
    await client.db.insert(pauses).values({
      organisationId: scenario.organisationId,
      kind: 'CUSTOMER_REPLY',
      scope: 'customer',
      contactId: scenario.contactId,
      active: true,
      reason: 'Customer replied by SMS',
      startedAt: now
    });
    await client.db.insert(tasks).values({
      id: scenario.escalationTaskId,
      organisationId: scenario.organisationId,
      kind: 'DEBT_ESCALATION',
      contactId: scenario.contactId,
      invoiceId: scenario.invoiceId,
      sequenceId: scenario.sequenceId,
      status: 'OPEN',
      dueAt: now,
      summary: 'Manual escalation required after 30 days overdue'
    });
    await client.db.insert(auditEvents).values([
      {
        organisationId: scenario.organisationId,
        actorUserId: scenario.adminUserId,
        eventType: 'CONTROLLED_TEST_PASSED',
        entityType: 'ORGANISATION',
        entityId: scenario.organisationId,
        occurredAt: now
      },
      {
        organisationId: scenario.organisationId,
        eventType: 'CUSTOMER_REPLY_PAUSED',
        entityType: 'CONTACT',
        entityId: scenario.contactId,
        afterValue: { source: 'SINCH_REPLY' },
        occurredAt: now
      }
    ]);

    const finalScenario = finalRolloutScenarios[rolloutScenario];
    if (finalScenario.operationalDataCleared) {
      await client.db.delete(approvals);
      await client.db.delete(stageInstances);
      await client.db.delete(invoiceChases);
      await client.db.delete(tasks);
      await client.db.delete(pauses);
      await client.db.delete(inboundMessages);
      await client.db.delete(conversations);
      await client.db.delete(invoices);
      await client.db.delete(contactChannels);
      await client.db.delete(contacts);
    }
    const evidenceAt = new Date();
    const successfulSyncAt = finalScenario.freshSync ? evidenceAt : null;
    await client.db
      .update(organisations)
      .set({
        sendMode: finalScenario.sendMode,
        rolloutScope: finalScenario.rolloutScope,
        liveSendAcknowledged: finalScenario.liveSendAcknowledged,
        maintenanceMode: false,
        operationalState: finalScenario.operationalState,
        operationalStateVersion: finalScenario.operationalStateVersion,
        xeroSyncCursor: finalScenario.freshSync ? 'e2e-current-sync' : null,
        lastSuccessfulSyncAt: successfulSyncAt,
        latestReconciledSyncAt: finalScenario.reconciliationCurrent
          ? successfulSyncAt
          : null,
        updatedAt: evidenceAt
      });

    if (finalScenario.freshProviderEvidence) {
      await client.db
        .update(providerConnections)
        .set({
          connectedAt: evidenceAt,
          lastSuccessfulAuthenticationAt: evidenceAt,
          updatedAt: evidenceAt
        });
    }

    if (finalScenario.completedReset) {
      await client.db.insert(operationalResetRuns).values({
        id: finalRolloutFixtureIds.resetRunId,
        organisationId: scenario.organisationId,
        status: 'COMPLETED',
        requestedByUserId: scenario.adminUserId,
        deployedCommit: '0123456789abcdef0123456789abcdef01234567',
        snapshotIdentifier: 'e2e-accountpulse-protected-reset',
        rowCountManifest: { contacts: 1, invoices: 1, outbound_messages: 1 },
        jobPurgeManifest: { 'reminders.calculate': 1 },
        requestedAt: evidenceAt,
        preparedAt: evidenceAt,
        snapshotCreatedAt: evidenceAt,
        completedAt: evidenceAt,
        updatedAt: evidenceAt
      });
    }

    if (finalScenario.controlledSmsEvidence) {
      await client.db.insert(outboundMessages).values({
        id: finalRolloutFixtureIds.testSmsId,
        organisationId: scenario.organisationId,
        actorUserId: scenario.adminUserId,
        channel: 'SMS',
        source: 'TEST_SMS',
        recipientKey: scenario.mobile,
        status: 'DELIVERED',
        idempotencyKey: `final-rollout-${rolloutScenario}`,
        completedAt: evidenceAt,
        createdAt: evidenceAt,
        updatedAt: evidenceAt
      });
    }

    if (finalScenario.reconciliationCurrent && successfulSyncAt !== null) {
      await client.db.insert(rolloutReconciliations).values({
        id: finalRolloutFixtureIds.reconciliationId,
        organisationId: scenario.organisationId,
        syncCompletedAt: successfulSyncAt,
        activeContactCount: 1,
        outstandingInvoiceCount: 1,
        outstandingTotals: { AUD: '100.0000' },
        generatedApprovalCount: 1,
        enabledSequenceCount: 1,
        allEnabledSequencesReview: true,
        acknowledgedByUserId: scenario.adminUserId,
        acknowledgedAt: evidenceAt,
        createdAt: evidenceAt
      });
    }
  } finally {
    await client.pool.end();
  }
}

export async function seedSmsOptOut(databaseUrl: string): Promise<void> {
  const client = createDatabase(databaseUrl);
  try {
    await client.db.insert(suppressions).values({
      organisationId: scenario.organisationId,
      channel: 'SMS',
      normalisedDestination: scenario.mobile,
      source: 'SINCH_OPT_OUT',
      reason: 'Customer sent STOP',
      consentState: 'SUPPRESSED'
    });
  } finally {
    await client.pool.end();
  }
}
