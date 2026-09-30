import { headers } from 'next/headers';

import {
  getDatabaseClient,
  requireWebSession
} from '../../../server/runtime.js';
import { createSmsIssueService } from './sms-issue-service.js';
import { SmsIssuesView } from './sms-issues-view.js';

export default async function SmsIssuesPage() {
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const organisationId = session.memberships[0]?.organisationId;
  if (organisationId === undefined) {
    throw new Error('No active organisation membership');
  }
  const sections = await createSmsIssueService({
    database: getDatabaseClient().db
  }).list(session, { organisationId });
  return <SmsIssuesView sections={sections} />;
}
