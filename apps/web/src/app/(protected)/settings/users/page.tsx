import { headers } from 'next/headers';

import { createAwsCognitoUserAdministration } from '../../../../server/cognito-admin.js';
import { eq } from 'drizzle-orm';
import { organisations } from '@bc5000/db/web';
import {
  getDatabaseClient,
  requireWebSession
} from '../../../../server/runtime.js';
import {
  changeMemberRoleAction,
  disableMemberAction,
  inviteMemberAction,
  resendInvitationAction
} from './actions.js';
import { createUserAdministration } from './user-administration.js';
import {
  UserAdministrationView,
  type UserAdministrationFeedback
} from './user-administration-view.js';

type SearchParameters = Promise<
  Record<string, string | string[] | undefined>
>;

const successMessages: Record<string, string> = {
  invited: 'Invitation sent.',
  resent: 'Invitation resent.',
  'role-updated': 'Access level updated.',
  disabled: 'User access disabled.'
};

const firstValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function UsersPage({
  searchParams
}: {
  searchParams: SearchParameters;
}) {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const membership = session.memberships[0];
  const organisationId = membership?.organisationId;
  if (organisationId === undefined || membership === undefined) {
    throw new Error('No active organisation membership');
  }
  const members = await createUserAdministration({
    database: getDatabaseClient().db,
    cognito: createAwsCognitoUserAdministration(),
    clock: { now: () => new Date() }
  }).listMembers(session, { organisationId });
  const [organisation] = await getDatabaseClient().db
    .select({ edition: organisations.edition })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .limit(1);
  const parameters = await searchParams;
  const error = firstValue(parameters.error);
  const success = firstValue(parameters.success);
  const successMessage = success === undefined ? undefined : successMessages[success];
  const feedback: UserAdministrationFeedback | undefined =
    error !== undefined
      ? { kind: 'error', message: error }
      : successMessage === undefined
        ? undefined
        : { kind: 'success', message: successMessage };

  return (
    <UserAdministrationView
      organisationId={organisationId}
      currentUserId={session.userId}
      readOnly={membership.organisationStatus === 'SUSPENDED'}
      soloUserLimit={organisation?.edition === 'SOLO'}
      members={members}
      {...(feedback === undefined ? {} : { feedback })}
      inviteAction={inviteMemberAction}
      resendAction={resendInvitationAction}
      changeRoleAction={changeMemberRoleAction}
      disableAction={disableMemberAction}
    />
  );
}
