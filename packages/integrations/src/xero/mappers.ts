import type {
  XeroContact,
  XeroInvoice,
  XeroOrganisation
} from './types.js';

export interface RawXeroInvoice {
  InvoiceID: string;
  InvoiceNumber: string;
  Contact: {
    ContactID: string;
    Name: string;
  };
  Type: XeroInvoice['type'];
  Status: XeroInvoice['status'];
  DateString: string;
  DueDateString: string;
  AmountDue: string | number;
  CurrencyCode: string;
  UpdatedDateUTC?: string;
}

export interface RawXeroContact {
  ContactID: string;
  Name: string;
  ContactStatus: string;
  EmailAddress?: string;
  Phones?: Array<{
    PhoneType?: string;
    PhoneNumber?: string;
  }>;
}

export interface RawXeroOrganisation {
  OrganisationID: string;
  Name: string;
  BaseCurrency: string;
  Timezone?: string;
}

const isoLocalDate = (value: string): string => {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (match?.[1] === undefined) {
    throw new Error(`Invalid Xero date: ${value}`);
  }
  return match[1];
};

const isoInstant = (value: string): string => {
  const legacyMatch = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  const instant = new Date(
    legacyMatch?.[1] === undefined ? value : Number(legacyMatch[1])
  );
  if (!Number.isFinite(instant.getTime())) {
    throw new Error(`Invalid Xero timestamp: ${value}`);
  }
  return instant.toISOString();
};

export const mapXeroInvoice = (invoice: RawXeroInvoice): XeroInvoice => ({
  id: invoice.InvoiceID,
  invoiceNumber: invoice.InvoiceNumber,
  contactId: invoice.Contact.ContactID,
  contactName: invoice.Contact.Name,
  type: invoice.Type,
  status: invoice.Status,
  issueDate: isoLocalDate(invoice.DateString),
  dueDate: isoLocalDate(invoice.DueDateString),
  amountDue: String(invoice.AmountDue),
  currency: invoice.CurrencyCode,
  updatedAt:
    invoice.UpdatedDateUTC === undefined
      ? null
      : isoInstant(invoice.UpdatedDateUTC)
});

export const mapXeroContact = (contact: RawXeroContact): XeroContact => ({
  id: contact.ContactID,
  name: contact.Name,
  active: contact.ContactStatus === 'ACTIVE',
  email: contact.EmailAddress ?? null,
  phones: (contact.Phones ?? [])
    .map((phone) => phone.PhoneNumber?.trim())
    .filter((phone): phone is string => phone !== undefined && phone !== ''),
  phoneCandidates: (contact.Phones ?? []).flatMap((phone) => {
    const number = phone.PhoneNumber?.trim();
    if (number === undefined || number === '') return [];
    return [{ type: phone.PhoneType ?? 'UNKNOWN', number }];
  })
});

export const mapXeroOrganisation = (
  organisation: RawXeroOrganisation
): XeroOrganisation => ({
  id: organisation.OrganisationID,
  name: organisation.Name,
  baseCurrency: organisation.BaseCurrency,
  timeZone: organisation.Timezone ?? null
});
