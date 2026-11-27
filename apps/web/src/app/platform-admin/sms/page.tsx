import type {
  ReplyNumberDocumentationStatus,
  ReplyNumberProvisioningStatus,
  SmsNumberStatus
} from '@bc5000/db/web';
import { organisations as organisationTable } from '@bc5000/db/web';
import { asc, eq } from 'drizzle-orm';

import { PlatformSmsAdministration } from '../../../components/platform-admin/sms-administration.js';
import { getPlatformAdminService } from '../../../server/platform-admin-service.js';
import { requirePlatformOwnerPage } from '../../../server/platform-page-authorization.js';
import { getDatabaseClient } from '../../../server/runtime.js';
import { linkSharedSinchAccount } from './shared-account-action.js';
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

const sharedAccountFeedback: Readonly<Record<string, string>> = {
  LINKED: 'The Sinch sub-account is linked to this company.',
  ACCOUNT_IN_USE: 'That Sinch sub-account is already linked to another company.',
  ALREADY_LINKED: 'This company already has a Sinch sub-account.',
  DEDICATED_NUMBER_IN_USE: 'This company has a dedicated SMS number or an approved order.',
  NOT_FOUND: 'Choose an AccountPulse Solo company.',
  VALIDATION: 'Choose a company, enter the Sinch sub-account ID and confirm the setup.',
  NOT_OWNER: 'Only the AccountPulse owner can link a Sinch sub-account.'
};

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
  const [page, provisioningPage, organisations, sharedAccounts] = await Promise.all([
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
    }),
    getDatabaseClient().db.select({
      id: organisationTable.id,
      name: organisationTable.name,
      accountId: organisationTable.sinchSharedAccountId
    }).from(organisationTable).where(eq(organisationTable.edition, 'SOLO'))
      .orderBy(asc(organisationTable.name))
  ]);
  const result = first(query.sharedAccountResult);
  const feedback = result && Object.hasOwn(sharedAccountFeedback, result)
    ? sharedAccountFeedback[result]
    : null;
  return (
    <>
      <section className="platform-card">
        <h2>Shared SMS and company inboxes</h2>
        <p>Link each company to its own existing Australian Sinch Engage sub-account. Set its default sender to Shared Numbers Pool and configure its reply webhooks first.</p>
        {feedback && <p role="status">{feedback}</p>}
        <form action={linkSharedSinchAccount}>
          <label>
            Company
            <select name="organisationId" required defaultValue="">
              <option value="" disabled>Choose a company</option>
              {sharedAccounts.filter(({ accountId }) => accountId === null)
                .map(({ id, name }) => <option value={id} key={id}>{name}</option>)}
            </select>
          </label>
          <label>
            Sinch sub-account ID
            <input name="accountId" required pattern={'[A-Za-z0-9_\\-]{1,128}'} maxLength={128} />
          </label>
          <label>
            <input type="checkbox" name="sharedPoolConfirmed" required />
            The sub-account uses the shared pool and has its own reply webhook configured.
          </label>
          <button type="submit">Link Sinch sub-account</button>
        </form>
        <ul>
          {sharedAccounts.filter(({ accountId }) => accountId !== null)
            .map(({ id, name, accountId }) => <li key={id}>{name} · {accountId}</li>)}
        </ul>
      </section>
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
    </>
  );
}
