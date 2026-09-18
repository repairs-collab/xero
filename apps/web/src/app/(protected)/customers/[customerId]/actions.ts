'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { createCustomerOperations } from './customer-operations.js';
import { getJobQueue } from '../../../../server/job-runtime.js';
import { getDatabaseClient, requireWebSession } from '../../../../server/runtime.js';

const requiredText = (formData: FormData, name: string): string => { const value = formData.get(name); if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`); return value; };
const optionalText = (formData: FormData, name: string): string | undefined => { const value = formData.get(name); return typeof value === 'string' && value.trim() !== '' ? value : undefined; };
async function context() { const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() })); return { session, operations: createCustomerOperations({ database: getDatabaseClient().db, publisher: await getJobQueue(), clock: { now: () => new Date() } }) }; }
const identifiers = (formData: FormData) => ({ organisationId: requiredText(formData, 'organisationId'), customerId: requiredText(formData, 'customerId') });
const refresh = (customerId: string) => revalidatePath(`/customers/${customerId}`);

export async function recordDispute(formData: FormData): Promise<void> { const { session, operations } = await context(); const ids = identifiers(formData); const invoiceId = optionalText(formData, 'invoiceId'); await operations.recordDispute(session, { ...ids, ...(invoiceId ? { invoiceId } : {}), reason: requiredText(formData, 'reason') }); refresh(ids.customerId); }
export async function recordPromiseToPay(formData: FormData): Promise<void> { const { session, operations } = await context(); const ids = identifiers(formData); await operations.recordPromiseToPay(session, { ...ids, promisedDate: requiredText(formData, 'promisedDate'), graceDays: Number(requiredText(formData, 'graceDays')) }); refresh(ids.customerId); }
export async function pauseChasing(formData: FormData): Promise<void> { const { session, operations } = await context(); const ids = identifiers(formData); await operations.pauseChasing(session, { ...ids, reason: requiredText(formData, 'reason') }); refresh(ids.customerId); }
export async function resumeChasing(formData: FormData): Promise<void> { const { session, operations } = await context(); const ids = identifiers(formData); await operations.resumeChasing(session, { ...ids, reason: requiredText(formData, 'reason') }); refresh(ids.customerId); }
export async function setApprovedPhoneOverride(formData: FormData): Promise<void> { const { session, operations } = await context(); const ids = identifiers(formData); await operations.setApprovedPhoneOverride(session, { ...ids, phone: requiredText(formData, 'phone'), reason: requiredText(formData, 'reason') }); refresh(ids.customerId); }
export async function clearApprovedPhoneOverride(formData: FormData): Promise<void> { const { session, operations } = await context(); const ids = identifiers(formData); await operations.clearApprovedPhoneOverride(session, { ...ids, reason: requiredText(formData, 'reason') }); refresh(ids.customerId); }
export async function addCustomerNote(formData: FormData): Promise<void> { const { session, operations } = await context(); const ids = identifiers(formData); await operations.addCustomerNote(session, { ...ids, note: requiredText(formData, 'note') }); refresh(ids.customerId); }
