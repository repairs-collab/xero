import { PlatformRetentionOperations } from '../../../components/platform-admin/retention-operations.js';
import { requirePlatformOwnerPage } from '../../../server/platform-page-authorization.js';
import { getRetentionOperationsService } from '../../../server/retention-operations-runtime.js';
import {
  completeExportRequestAction,
  recordBackupExpiryVerificationAction,
  recordVerifiedRequestAction,
  reviewDataRequestAction
} from './actions.js';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? '';

export default async function PlatformRetentionPage({
  searchParams
}: {
  searchParams: SearchParams;
}) {
  const [query, session] = await Promise.all([
    searchParams,
    requirePlatformOwnerPage('/platform-admin/retention')
  ]);
  const organisationId = first(query.organisationId).trim();
  const page = await getRetentionOperationsService().listOperations(
    session.userId,
    organisationId ? { organisationId } : {}
  );

  return (
    <PlatformRetentionOperations
      page={page}
      organisationId={organisationId}
      {...(first(query.result) ? { feedbackCode: first(query.result) } : {})}
      actions={{
        recordVerifiedRequest: recordVerifiedRequestAction,
        reviewRequest: reviewDataRequestAction,
        recordBackupExpiryVerification: recordBackupExpiryVerificationAction,
        completeExportRequest: completeExportRequestAction
      }}
    />
  );
}
