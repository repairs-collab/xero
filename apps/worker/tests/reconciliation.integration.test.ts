import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { approvals, contacts, createDatabase, invoiceChases, invoices, migrateDatabase, organisations, reminderSequenceVersions, reminderSequences, stageInstances } from '@bc5000/db';
import type { XeroContact, XeroInvoice, XeroResult } from '@bc5000/integrations/xero';

import { reconcileNightly } from '../src/handlers/reconcile-nightly.js';

const client = createDatabase(process.env.DATABASE_URL ?? 'postgres://bc5000:bc5000@localhost:5432/bc5000');
const now = new Date('2026-09-18T00:00:00.000Z'); const rateLimit = { limit: 60, remaining: 40, retryAfterSeconds: null };
beforeAll(async () => migrateDatabase(client.db)); afterAll(async () => client.pool.end());

const result = <T>(data: T): XeroResult<T> => ({ data, rateLimit });
const invoice = (id: string, contactId: string, overrides: Partial<XeroInvoice> = {}): XeroInvoice => ({ id, contactId, contactName: 'Customer', invoiceNumber: id, type: 'ACCREC', status: 'AUTHORISED', issueDate: '2026-08-01', dueDate: '2026-08-31', amountDue: '100', currency: 'AUD', updatedAt: '2026-09-18T00:00:00Z', ...overrides });
const contact = (id: string): XeroContact => ({ id, name: 'Customer', active: true, email: 'customer@example.invalid', phones: ['0400000001'], phoneCandidates: [{ type: 'MOBILE', number: '0400000001' }] });

describe('nightly reconciliation', () => {
  it('upserts drift and confirms a missing local invoice before closing it', async () => {
    const organisationId = randomUUID(); const contactId = randomUUID(); const localInvoiceId = randomUUID(); const missingXeroId = randomUUID(); const remoteXeroId = randomUUID(); const sequenceId = randomUUID(); const versionId = randomUUID(); const chaseId = randomUUID(); const stageId = randomUUID(); const approvalId = randomUUID();
    await client.db.insert(organisations).values({ id: organisationId, xeroOrganisationId: randomUUID(), name: 'Reconcile test', timeZone: 'Australia/Sydney', baseCurrency: 'AUD' });
    await client.db.insert(contacts).values({ id: contactId, organisationId, xeroContactId: 'contact-local', name: 'Local customer' });
    await client.db.insert(invoices).values({ id: localInvoiceId, organisationId, xeroInvoiceId: missingXeroId, contactId, invoiceNumber: 'MISSING', type: 'ACCREC', status: 'AUTHORISED', issueDate: '2026-07-01', dueDate: '2026-08-01', amountDue: '50', currency: 'AUD', syncVersion: 1 });
    await client.db.insert(reminderSequences).values({ id: sequenceId, organisationId, name: 'Standard' }); await client.db.insert(reminderSequenceVersions).values({ id: versionId, organisationId, sequenceId, versionNumber: 1, status: 'ACTIVE' }); await client.db.insert(invoiceChases).values({ id: chaseId, organisationId, invoiceId: localInvoiceId, sequenceId, customerId: contactId, status: 'ACTIVE' }); await client.db.insert(stageInstances).values({ id: stageId, organisationId, invoiceChaseId: chaseId, sequenceVersionId: versionId, stageKey: 'seven-days', channel: 'SMS', status: 'PENDING_APPROVAL', scheduledAt: now, sourceVersion: 1 }); await client.db.insert(approvals).values({ id: approvalId, organisationId, stageInstanceId: stageId, renderedPreview: 'Old preview', sourceVersion: 1, status: 'PENDING', expiresAt: new Date('2026-09-19T00:00:00Z') });
    const remote = invoice(remoteXeroId, 'contact-remote', { amountDue: '225' });
    const xero = { listOutstandingInvoices: vi.fn(() => Promise.resolve(result([remote]))), listContacts: vi.fn((ids: string[]) => Promise.resolve(result(ids.map((id) => contact(id))))), getInvoice: vi.fn((id: string) => Promise.resolve(result(invoice(id, 'contact-local', { status: 'PAID', amountDue: '0' })))), getContact: vi.fn((id: string) => Promise.resolve(result(contact(id)))), getOnlineInvoiceUrl: vi.fn((id: string) => Promise.resolve(result(`https://xero.example/${id}`))) };

    const summary = await reconcileNightly({ database: client.db, xero, clock: { now: () => now } }, { organisationId });

    expect(summary).toMatchObject({ remoteEligible: 1, confirmedTerminal: 1, upserted: 2 });
    expect(xero.getInvoice).toHaveBeenCalledWith(missingXeroId);
    const [closed] = await client.db.select().from(invoices).where(eq(invoices.id, localInvoiceId)); expect(closed).toMatchObject({ status: 'PAID', amountDue: '0.0000' });
    const [chase] = await client.db.select().from(invoiceChases).where(eq(invoiceChases.id, chaseId)); expect(chase?.status).toBe('CLOSED');
    const [approval] = await client.db.select().from(approvals).where(eq(approvals.id, approvalId)); expect(approval?.status).toBe('EXPIRED');
    expect(await client.db.select().from(invoices).where(and(eq(invoices.organisationId, organisationId), eq(invoices.xeroInvoiceId, remoteXeroId)))).toHaveLength(1);
  });
});
