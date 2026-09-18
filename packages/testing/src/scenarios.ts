export const launchScenario = {
  organisationId: '10000000-0000-4000-8000-000000000001',
  adminUserId: '10000000-0000-4000-8000-000000000002',
  operatorUserId: '10000000-0000-4000-8000-000000000003',
  contactId: '10000000-0000-4000-8000-000000000004',
  invoiceId: '10000000-0000-4000-8000-000000000005',
  sequenceId: '10000000-0000-4000-8000-000000000006',
  sequenceVersionId: '10000000-0000-4000-8000-000000000007',
  chaseId: '10000000-0000-4000-8000-000000000008',
  dueDateStageId: '10000000-0000-4000-8000-000000000009',
  approvalId: '10000000-0000-4000-8000-000000000010',
  conversationId: '10000000-0000-4000-8000-000000000011',
  escalationTaskId: '10000000-0000-4000-8000-000000000012',
  dailyStageId: '10000000-0000-4000-8000-000000000013',
  invoiceNumber: 'INV-5000',
  customerName: 'Acme Workshop',
  mobile: '+61400000001',
  adminSubject: 'e2e-admin',
  operatorSubject: 'e2e-operator',
  now: '2026-09-18T00:00:00.000Z'
} as const;

export type LaunchScenario = typeof launchScenario;
