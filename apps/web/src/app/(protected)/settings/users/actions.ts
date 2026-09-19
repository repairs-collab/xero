'use server';

import { headers } from 'next/headers';

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

export async function inviteMemberAction(input: {
  organisationId: string;
  email: string;
  displayName: string;
  role: Role;
}) {
  return service().inviteMember(await session(), input);
}

export async function resendInvitationAction(input: {
  organisationId: string;
  invitationId: string;
}) {
  await service().resendInvitation(await session(), input);
}

export async function changeMemberRoleAction(input: {
  organisationId: string;
  userId: string;
  role: Role;
}) {
  await service().changeRole(await session(), input);
}

export async function disableMemberAction(input: {
  organisationId: string;
  userId: string;
}) {
  await service().disableMember(await session(), input);
}
