import { legalIdentity, legalLastUpdated } from '../../../server/legal-content.js';

export default function PrivacyPage() {
  const legal = legalIdentity();
  return (
    <>
      <span className="eyebrow">Legal</span>
      <h1>AccountPulse Privacy Policy</h1>
      <p className="muted-copy">Last updated: {legalLastUpdated}</p>
      <p>
        {legal.entity} operates AccountPulse. This policy explains how we handle
        personal information in Australia and New Zealand.
      </p>
      <h2>Information we collect</h2>
      <p>
        We collect account identity and contact details, authentication and
        security events, subscription and usage records, support correspondence,
        and the invoice, customer, contact and payment-status data you authorise
        us to retrieve from Xero. Message delivery, reply, opt-out and workflow
        records are also stored when those features are used.
      </p>
      <h2>Why we use it</h2>
      <p>
        We use information to authenticate users, provide and secure the service,
        sync Xero data, send authorised reminders, process replies, administer
        subscriptions, provide support, prevent misuse and meet legal duties. We
        do not sell personal information.
      </p>
      <h2>Service providers and overseas handling</h2>
      <p>
        We use contracted providers for hosting, identity, accounting
        integration, billing and communications. This may involve processing in
        Australia, New Zealand, Canada, the United States, Europe or other
        locations used by those providers. We apply access controls and
        contractual or technical safeguards appropriate to the service.
      </p>
      <h2>Storage, security and retention</h2>
      <p>
        We use encryption, least-privilege access, audit records and operational
        monitoring. No internet service is risk-free. We retain data while an
        account is active and as reasonably needed for support, security,
        accounting, disputes and legal obligations. Cancellation starts a
        controlled retention review rather than an unsafe immediate deletion.
      </p>
      <h2>Access, correction and complaints</h2>
      <p>
        You may ask to access or correct personal information, request an account
        export, or raise a privacy complaint by emailing{' '}
        <a href={`mailto:${legal.supportEmail}`}>{legal.supportEmail}</a>. We
        will verify the requester and respond within a reasonable period. You may
        also contact the Office of the Australian Information Commissioner or
        the Office of the Privacy Commissioner in New Zealand.
      </p>
      <h2>Changes</h2>
      <p>
        We will update the date and request renewed acceptance when a material
        policy change requires it.
      </p>
    </>
  );
}
