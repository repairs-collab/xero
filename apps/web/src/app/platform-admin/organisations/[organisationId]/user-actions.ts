'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import type { AppSession, Role } from '@bc5000/auth';

import { requirePlatformOwner } from '../../../../server/platform-authorization.js';
import {
  getPlatformUserAdministration,
  type createPlatformUserAdministration
} from '../../../../server/platform-user-administration.js';

type PlatformUserService = ReturnType<typeof createPlatformUserAdministration>;

export interface PlatformUserActionDependencies {
  getOwnerSession(): Promise<AppSession>;
  service: Pick<
    PlatformUserService,
    'inviteMember' | 'resendInvitation' | 'changeRole' | 'disableMember'
  >;
  revalidate(path: string): void;
}

export interface PlatformUserActionState {
  ok: boolean;
  code: 'UPDATED' | 'VALIDATION' | 'LAST_ADMIN_REQUIRED' | 'FAILED';
}

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
};

const role = (formData: FormData): Role => {
  const value = text(formData, 'role');
  if (value !== 'ADMIN' && value !== 'OPERATOR') {
    throw new Error('role is invalid');
  }
  return value;
};

const failure = (error: unknown): PlatformUserActionState => {
  const message = error instanceof Error ? error.message : '';
  if (message === 'LAST_ADMIN_REQUIRED') {
    return { ok: false, code: 'LAST_ADMIN_REQUIRED' };
  }
  if (message === 'VALIDATION' || message.includes('required') || message.includes('invalid')) {
    return { ok: false, code: 'VALIDATION' };
  }
  return { ok: false, code: 'FAILED' };
};

export const createPlatformUserActions = (
  dependencies: PlatformUserActionDependencies
) => {
  const finish = (organisationId: string) => {
    dependencies.revalidate(`/platform-admin/organisations/${organisationId}`);
    dependencies.revalidate('/platform-admin');
  };
  return {
    async inviteMemberAction(formData: FormData): Promise<PlatformUserActionState> {
      try {
        const organisationId = text(formData, 'organisationId');
        await dependencies.service.inviteMember(
          await dependencies.getOwnerSession(),
          {
            organisationId,
            email: text(formData, 'email'),
            displayName: text(formData, 'displayName'),
            role: role(formData),
            reason: text(formData, 'reason')
          }
        );
        finish(organisationId);
        return { ok: true, code: 'UPDATED' };
      } catch (error) {
        return failure(error);
      }
    },

    async resendInvitationAction(formData: FormData): Promise<PlatformUserActionState> {
      try {
        const organisationId = text(formData, 'organisationId');
        await dependencies.service.resendInvitation(
          await dependencies.getOwnerSession(),
          {
            organisationId,
            invitationId: text(formData, 'invitationId'),
            reason: text(formData, 'reason')
          }
        );
        finish(organisationId);
        return { ok: true, code: 'UPDATED' };
      } catch (error) {
        return failure(error);
      }
    },

    async changeMemberRoleAction(formData: FormData): Promise<PlatformUserActionState> {
      try {
        const organisationId = text(formData, 'organisationId');
        await dependencies.service.changeRole(
          await dependencies.getOwnerSession(),
          {
            organisationId,
            userId: text(formData, 'userId'),
            role: role(formData),
            reason: text(formData, 'reason')
          }
        );
        finish(organisationId);
        return { ok: true, code: 'UPDATED' };
      } catch (error) {
        return failure(error);
      }
    },

    async disableMemberAction(formData: FormData): Promise<PlatformUserActionState> {
      try {
        const organisationId = text(formData, 'organisationId');
        await dependencies.service.disableMember(
          await dependencies.getOwnerSession(),
          {
            organisationId,
            userId: text(formData, 'userId'),
            reason: text(formData, 'reason')
          }
        );
        finish(organisationId);
        return { ok: true, code: 'UPDATED' };
      } catch (error) {
        return failure(error);
      }
    }
  };
};

const actions = createPlatformUserActions({
  getOwnerSession: async () =>
    requirePlatformOwner(
      new Request('http://localhost/platform-admin', {
        headers: await headers()
      })
    ),
  service: getPlatformUserAdministration(),
  revalidate: revalidatePath
});

export const inviteMemberAction = actions.inviteMemberAction;
export const resendInvitationAction = actions.resendInvitationAction;
export const changeMemberRoleAction = actions.changeMemberRoleAction;
export const disableMemberAction = actions.disableMemberAction;
