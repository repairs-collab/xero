import { PlatformBillingOperations } from '../../../components/platform-admin/billing-operations.js';
import { getPlatformAdminService } from '../../../server/platform-admin-service.js';
import { requirePlatformOwnerPage } from '../../../server/platform-page-authorization.js';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? '';

export default async function PlatformBillingPage({
  searchParams
}: {
  searchParams: SearchParams;
}) {
  const [query, session] = await Promise.all([
    searchParams,
    requirePlatformOwnerPage('/platform-admin/billing')
  ]);
  const filters = {
    organisationId: first(query.organisationId),
    caseKind: first(query.caseKind),
    caseStatus: first(query.caseStatus),
    casesCursor: first(query.casesCursor),
    heldEmailsCursor: first(query.heldEmailsCursor)
  };
  const page = await getPlatformAdminService().listBillingOperations(
    session.userId,
    { ...filters, limit: 25 }
  );

  return <PlatformBillingOperations page={page} filters={filters} />;
}
