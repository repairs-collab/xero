'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { createEscalationService } from './escalation-service.js';
import { getDatabaseClient, requireWebSession } from '../../../server/runtime.js';

const requiredText = (formData: FormData, name: string): string => { const value = formData.get(name); if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`); return value; };
export async function completeTask(formData: FormData): Promise<void> { const session = await requireWebSession(new Request('http://localhost/', { headers: await headers() })); const service = createEscalationService({ database: getDatabaseClient().db, clock: { now: () => new Date() } }); await service.completeTask(session, { organisationId: requiredText(formData, 'organisationId'), taskId: requiredText(formData, 'taskId'), resolutionNote: requiredText(formData, 'resolutionNote') }); revalidatePath('/escalations'); }
