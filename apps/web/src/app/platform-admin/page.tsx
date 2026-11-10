import { headers } from 'next/headers';

import type {
  PlatformOrganisationSort,
  SortDirection
} from '@bc5000/db/web';

import { PlatformAdminOverview } from '../../components/platform-admin/overview.js';
import { getPlatformAdminService } from '../../server/platform-admin-service.js';
import { requirePlatformOwner } from '../../server/platform-authorization.js';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function PlatformAdminPage({
  searchParams
}: {
  searchParams: SearchParams;
}) {
  const session = await requirePlatformOwner(
    new Request('http://localhost/platform-admin', { headers: await headers() })
  );
  const query = await searchParams;
  const search = first(query.search) ?? '';
  const sortValue = first(query.sort);
  const sort: PlatformOrganisationSort = [
    'name',
    'trialEnd',
    'status',
    'usage'
  ].includes(sortValue ?? '')
    ? (sortValue as PlatformOrganisationSort)
    : 'name';
  const direction: SortDirection = first(query.direction) === 'desc' ? 'desc' : 'asc';
  const pageNumber = Number(first(query.page) ?? '1');
  const page = await getPlatformAdminService().listOrganisations(session.userId, {
    search,
    sort,
    direction,
    page: Number.isSafeInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1,
    pageSize: 25
  });
  return (
    <PlatformAdminOverview
      page={page}
      filters={{ search, sort, direction }}
    />
  );
}
