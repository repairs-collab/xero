import type {
  ReplyNumberDocumentationStatus,
  ReplyNumberProvisioningStatus,
  SmsNumberStatus
} from '@bc5000/db/web';

import { PlatformSmsAdministration } from '../../../components/platform-admin/sms-administration.js';
import { getPlatformAdminService } from '../../../server/platform-admin-service.js';
import { requirePlatformOwnerPage } from '../../../server/platform-page-authorization.js';
import {
  assignSmsNumberAction,
  approveManualReplyNumberOrderAction,
  completeReplyNumberDocumentationAction,
  expireReplyNumberProvisioningRequestAction,
  failReplyNumberProvisioningRequestAction,
  fulfilReplyNumberProvisioningRequestAction,
  markSmsNumberReadyAction,
  quarantineSmsNumberAction,
  recordManualReplyNumberOrderAction,
  recordReplyNumberQuoteAction,
  registerSmsNumberAction,
  releaseSmsNumberAction,
  returnSmsNumberToPoolAction,
  verifySmsNumberForPoolAction
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
  const provisioningSearch = (first(query.provisioningSearch) ?? '').trim();
  const provisioningOrganisationId = (
    first(query.provisioningOrganisationId) ?? ''
  ).trim();
  const feedbackCode = first(query.result);
  const requestedPage = Number(first(query.page) ?? '1');
  const requestedProvisioningPage = Number(
    first(query.provisioningPage) ?? '1'
  );
  const statusValue = first(query.status) ?? '';
  const status = ['AVAILABLE', 'RESERVED', 'READY', 'QUARANTINED', 'RELEASED'].includes(statusValue)
    ? (statusValue as SmsNumberStatus)
    : undefined;
  const provisioningStatusValue = first(query.provisioningStatus) ?? '';
  const provisioningStatus = [
    'AWAITING_QUOTE',
    'AWAITING_OWNER_APPROVAL',
    'APPROVED_FOR_MANUAL_ORDER',
    'MANUAL_ORDER_RECORDED',
    'FULFILLED',
    'FAILED',
    'EXPIRED'
  ].includes(provisioningStatusValue)
    ? (provisioningStatusValue as ReplyNumberProvisioningStatus)
    : undefined;
  const documentationStatusValue = first(query.documentationStatus) ?? '';
  const documentationStatus = [
    'UNKNOWN',
    'NOT_REQUIRED',
    'REQUIRED',
    'COMPLETE'
  ].includes(documentationStatusValue)
    ? (documentationStatusValue as ReplyNumberDocumentationStatus)
    : undefined;
  const service = getPlatformAdminService();
  const [page, provisioningPage, organisations] = await Promise.all([
    service.listNumbers(session.userId, {
      search,
      ...(status ? { status } : {}),
      page: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
      pageSize: 25
    }),
    service.listReplyNumberProvisioningRequests(session.userId, {
      ...(provisioningSearch ? { search: provisioningSearch } : {}),
      ...(provisioningOrganisationId
        ? { organisationId: provisioningOrganisationId }
        : {}),
      ...(provisioningStatusValue
        ? { status: provisioningStatusValue }
        : {}),
      ...(documentationStatusValue
        ? { documentationStatus: documentationStatusValue }
        : {}),
      page:
        Number.isSafeInteger(requestedProvisioningPage) &&
        requestedProvisioningPage > 0
          ? requestedProvisioningPage
          : 1,
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
      provisioningPage={provisioningPage}
      organisations={organisations.items.map(({ id, name }) => ({ id, name }))}
      filters={{ search, customerSearch, status: status ?? '' }}
      provisioningFilters={{
        search: provisioningSearch,
        organisationId: provisioningOrganisationId,
        status: provisioningStatus ?? '',
        documentationStatus: documentationStatus ?? ''
      }}
      now={new Date()}
      {...(feedbackCode ? { feedbackCode } : {})}
      actions={{
        recordQuote: recordReplyNumberQuoteAction,
        completeDocumentation: completeReplyNumberDocumentationAction,
        approveOrder: approveManualReplyNumberOrderAction,
        recordOrder: recordManualReplyNumberOrderAction,
        fulfilOrder: fulfilReplyNumberProvisioningRequestAction,
        failRequest: failReplyNumberProvisioningRequestAction,
        expireRequest: expireReplyNumberProvisioningRequestAction,
        register: registerSmsNumberAction,
        verify: verifySmsNumberForPoolAction,
        assign: assignSmsNumberAction,
        ready: markSmsNumberReadyAction,
        quarantine: quarantineSmsNumberAction,
        release: releaseSmsNumberAction,
        returnToPool: returnSmsNumberToPoolAction
      }}
    />
  );
}
