import { legalIdentity, legalLastUpdated } from '../../../server/legal-content.js';

export default function TermsPage() {
  const legal = legalIdentity();
  return (
    <>
      <span className="eyebrow">Legal</span>
      <h1>AccountPulse Terms of Service</h1>
      <p className="muted-copy">Last updated: {legalLastUpdated}</p>
      <p>
        These Terms govern access to AccountPulse, a subscription accounts
        receivable workflow service operated by {legal.entity}. By creating or
        using an account, you agree to these Terms on behalf of yourself and the
        organisation you represent.
      </p>
      <h2>1. Eligibility and authority</h2>
      <p>
        You must be at least 18 and authorised to connect the selected Xero
        organisation, manage its customer communications and bind that business
        to these Terms. Account credentials must not be shared.
      </p>
      <h2>2. Service and customer responsibility</h2>
      <p>
        AccountPulse assists with invoice reminders, messaging, reporting and
        related workflows. You remain responsible for invoice accuracy,
        recipient details, lawful contact authority, message content, collection
        decisions and all communications sent through your account. AccountPulse
        is not legal, accounting, credit or debt-collection advice.
      </p>
      <h2>3. Xero and third-party services</h2>
      <p>
        The service depends on Xero and may use payment, identity, messaging and
        hosting providers. Their availability and terms may affect features. You
        authorise AccountPulse to access the Xero data and third-party services
        needed to provide the features you enable.
      </p>
      <h2>4. Trials, subscriptions and SMS usage</h2>
      <p>
        Trial limits and included SMS parts are shown during onboarding and in
        billing. An SMS may consume more than one part because of message length
        or character encoding. Paid subscriptions renew until cancelled. Prices,
        taxes and any approved overage are disclosed before purchase. Except
        where consumer law requires otherwise, fees already incurred are not
        refundable merely because the service was unused.
      </p>
      <h2>5. Safe sending</h2>
      <p>
        New workspaces begin in controlled review mode. You must review imported
        data, templates, recipients and schedules before enabling customer
        sending. You must honour opt-outs, disputes, payment arrangements and
        other circumstances where contact should stop.
      </p>
      <h2>6. Availability and changes</h2>
      <p>
        We aim to operate the service reliably but do not guarantee uninterrupted
        access. We may maintain, secure or change the service, and may suspend an
        account where necessary to protect customers, providers or the platform.
      </p>
      <h2>7. Data, export and termination</h2>
      <p>
        You retain rights in your business data. You may request an export and
        disconnect Xero. On cancellation or trial expiry, access and sending may
        become restricted and data is handled under the Privacy Policy and the
        retention statement communicated in the service.
      </p>
      <h2>8. Liability and consumer rights</h2>
      <p>
        Nothing in these Terms excludes rights that cannot lawfully be excluded,
        including rights under the Australian Consumer Law or applicable New
        Zealand law. To the extent permitted by law, neither party is liable for
        indirect or consequential loss, and our aggregate liability is limited
        to the fees paid for the service in the preceding 12 months.
      </p>
      <h2>9. Governing law and contact</h2>
      <p>
        These Terms are governed by the laws of Victoria, Australia. Contact{' '}
        <a href={`mailto:${legal.supportEmail}`}>{legal.supportEmail}</a> with
        questions, complaints or cancellation requests.
      </p>
    </>
  );
}
