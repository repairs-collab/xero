import type { SmsNumberStatus } from '@bc5000/db/web';

import { PlatformSmsAdministration } from '../../../components/platform-admin/sms-administration.js';
import { getPlatformAdminService } from '../../../server/platform-admin-service.js';
import { requirePlatformOwnerPage } from '../../../server/platform-page-authorization.js';
import {
  assignSmsNumberAction,
  markSmsNumberReadyAction,
  quarantineSmsNumberAction,
  registerSmsNumberAction,
  releaseSmsNumberAction,
  returnSmsNumberToPoolAction
} from './actions.js';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function PlatformSmsPage({
  searchParams
}: {
  searchParams: SearchParams;
}) {
  const [query, session] = await Promise.all([
    searchParams,
    requirePlatformOwnerPage('/platform-admin/sms')
  ]);
  const search = first(query.search) ?? '';
  const customerSearch = first(query.customerSearch) ?? '';
  const feedbackCode = first(query.result);
  const requestedPage = Number(first(query.page) ?? '1');
  const statusValue = first(query.status) ?? '';
  const status = ['AVAILABLE', 'RESERVED', 'READY', 'QUARANTINED', 'RELEASED'].includes(statusValue)
    ? (statusValue as SmsNumberStatus)
    : undefined;
  const service = getPlatformAdminService();
  const [page, organisations] = await Promise.all([
    service.listNumbers(session.userId, {
      search,
      ...(status ? { status } : {}),
      page: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
      pageSize: 25
    }),
    service.listOrganisations(session.userId, {
      sort: 'name',
      direction: 'asc',
      search: customerSearch,
      pageSize: 100
    })
  ]);
  return (
    <PlatformSmsAdministration
      page={page}
      organisations={organisations.items.map(({ id, name }) => ({ id, name }))}
      filters={{ search, customerSearch, status: status ?? '' }}
      {...(feedbackCode ? { feedbackCode } : {})}
      actions={{
        register: registerSmsNumberAction,
        assign: assignSmsNumberAction,
        ready: markSmsNumberReadyAction,
        quarantine: quarantineSmsNumberAction,
        release: releaseSmsNumberAction,
        returnToPool: returnSmsNumberToPoolAction
      }}
    />
  );
}
