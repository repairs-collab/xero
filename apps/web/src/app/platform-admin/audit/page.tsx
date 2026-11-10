import { headers } from 'next/headers';

import { PlatformAuditList } from '../../../components/platform-admin/audit-list.js';
import { getPlatformAdminService } from '../../../server/platform-admin-service.js';
import { requirePlatformOwner } from '../../../server/platform-authorization.js';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const filterDate = (value: string | undefined, endOfDay = false): Date | undefined => {
  if (!value) return undefined;
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isFinite(date.getTime()) ? date : undefined;
};

export default async function PlatformAuditPage({
  searchParams
}: {
  searchParams: SearchParams;
}) {
  const [query, session] = await Promise.all([
    searchParams,
    requirePlatformOwner(
      new Request('http://localhost/platform-admin/audit', {
        headers: await headers()
      })
    )
  ]);
  const organisationId = first(query.organisationId) ?? '';
  const actorUserId = first(query.actorUserId) ?? '';
  const eventType = first(query.eventType) ?? '';
  const from = first(query.from) ?? '';
  const to = first(query.to) ?? '';
  const page = await getPlatformAdminService().listAuditEvents(session.userId, {
    ...(organisationId ? { organisationId } : {}),
    ...(actorUserId ? { actorUserId } : {}),
    ...(eventType ? { eventType } : {}),
    ...(filterDate(from) ? { from: filterDate(from)! } : {}),
    ...(filterDate(to, true) ? { to: filterDate(to, true)! } : {}),
    pageSize: 100
  });
  return (
    <PlatformAuditList
      page={page}
      filters={{ organisationId, actorUserId, eventType, from, to }}
    />
  );
}
