import { notFound } from 'next/navigation';

import { PlatformOrganisationDetailView } from '../../../../components/platform-admin/organisation-detail.js';
import { getPlatformAdminService } from '../../../../server/platform-admin-service.js';
import { requirePlatformOwnerPage } from '../../../../server/platform-page-authorization.js';
import {
  endTrialAction,
  extendTrialAction,
  reactivateOrganisationAction,
  suspendOrganisationAction
} from '../actions.js';
import { updateSmsAllowanceAction } from '../../sms/actions.js';
import {
  changeMemberRoleAction,
  disableMemberAction,
  inviteMemberAction,
  resendInvitationAction
} from './user-actions.js';

type RouteParams = Promise<{ organisationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function PlatformOrganisationPage({
  params,
  searchParams
}: {
  params: RouteParams;
  searchParams: SearchParams;
}) {
  const { organisationId } = await params;
  const [query, session] = await Promise.all([
    searchParams,
    requirePlatformOwnerPage(`/platform-admin/organisations/${organisationId}`)
  ]);
  const detail = await getPlatformAdminService().getOrganisationDetail(
    session.userId,
    organisationId
  );
  if (!detail) notFound();
  const feedbackCode = first(query.result);
  return (
    <PlatformOrganisationDetailView
      detail={detail}
      {...(feedbackCode ? { feedbackCode } : {})}
      actions={{
        extendTrial: extendTrialAction,
        endTrial: endTrialAction,
        suspend: suspendOrganisationAction,
        reactivate: reactivateOrganisationAction,
        updateAllowance: updateSmsAllowanceAction,
        inviteUser: inviteMemberAction,
        resendInvitation: resendInvitationAction,
        changeRole: changeMemberRoleAction,
        disableUser: disableMemberAction
      }}
    />
  );
}
