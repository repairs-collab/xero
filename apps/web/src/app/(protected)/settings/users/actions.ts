'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import type { Role } from '@bc5000/auth';

import { createAwsCognitoUserAdministration } from '../../../../server/cognito-admin.js';
import {
  getDatabaseClient,
  requireWebSession
} from '../../../../server/runtime.js';
import { createUserAdministration } from './user-administration.js';

const service = () =>
  createUserAdministration({
    database: getDatabaseClient().db,
    cognito: createAwsCognitoUserAdministration(),
    clock: { now: () => new Date() }
  });

const session = async () =>
  requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );

const requiredText = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
};

const roleFrom = (formData: FormData): Role => {
  const role = requiredText(formData, 'role');
  if (role !== 'ADMIN' && role !== 'OPERATOR') {
    throw new Error('Invalid access level');
  }
  return role;
};

const errorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  if (message === 'USER_EMAIL_EXISTS') {
    return 'A user with this email address already exists.';
  }
  if (message === 'LAST_ADMIN_REQUIRED') {
    return 'At least one active administrator must remain.';
  }
  if (message === 'Invitation was not found') {
    return 'This invitation is no longer available to resend.';
  }
  if (message === 'Membership was not found') {
    return 'This user is no longer active in the organisation.';
  }
  if (message.includes('required') || message === 'Invalid access level') {
    return message;
  }
  return 'The account change could not be completed. Please try again.';
};

const finish = (status: string): never => {
  revalidatePath('/settings/users');
  redirect(`/settings/users?success=${encodeURIComponent(status)}`);
};

const fail = (error: unknown): never =>
  redirect(`/settings/users?error=${encodeURIComponent(errorMessage(error))}`);

export async function inviteMemberAction(formData: FormData): Promise<void> {
  try {
    await service().inviteMember(await session(), {
      organisationId: requiredText(formData, 'organisationId'),
      email: requiredText(formData, 'email'),
      displayName: requiredText(formData, 'displayName'),
      role: roleFrom(formData)
    });
  } catch (error) {
    fail(error);
  }
  finish('invited');
}

export async function resendInvitationAction(formData: FormData): Promise<void> {
  try {
    await service().resendInvitation(await session(), {
      organisationId: requiredText(formData, 'organisationId'),
      invitationId: requiredText(formData, 'invitationId')
    });
  } catch (error) {
    fail(error);
  }
  finish('resent');
}

export async function changeMemberRoleAction(formData: FormData): Promise<void> {
  try {
    await service().changeRole(await session(), {
      organisationId: requiredText(formData, 'organisationId'),
      userId: requiredText(formData, 'userId'),
      role: roleFrom(formData)
    });
  } catch (error) {
    fail(error);
  }
  finish('role-updated');
}

export async function disableMemberAction(formData: FormData): Promise<void> {
  try {
    await service().disableMember(await session(), {
      organisationId: requiredText(formData, 'organisationId'),
      userId: requiredText(formData, 'userId')
    });
  } catch (error) {
    fail(error);
  }
  finish('disabled');
}
