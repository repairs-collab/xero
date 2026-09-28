import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { InvoiceDetailsView } from '../../../../components/invoice-details-view.js';
import {
  getDatabaseClient,
  requireWebSession
} from '../../../../server/runtime.js';
import { loadInvoiceDetails } from './invoice-details.js';

export default async function InvoicePage({
  params
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  const session = await requireWebSession(
    new Request('http://localhost/', { headers: await headers() })
  );
  const organisationId = session.memberships[0]?.organisationId;
  if (organisationId === undefined) {
    throw new Error('No active organisation membership');
  }
  const model = await loadInvoiceDetails(getDatabaseClient().db, {
    organisationId,
    invoiceId
  });
  if (model === null) notFound();
  return <InvoiceDetailsView model={model} />;
}
