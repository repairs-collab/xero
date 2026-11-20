import { legalIdentity, termsLastUpdated } from '../../../server/legal-content.js';

export default function TermsPage() {
  const legal = legalIdentity();
  return (
    <>
      <span className="eyebrow">Legal</span>
      <h1>AccountPulse Terms of Service</h1>
      <p className="muted-copy">Last updated: {termsLastUpdated}</p>
      <p>
        These Terms govern access to AccountPulse, a subscription accounts
        receivable workflow service owned and operated by {legal.entity} (ABN{' '}
        {legal.abn}; ACN {legal.acn}). By creating or using an account, you agree
        to these Terms on behalf of yourself and the organisation you represent.
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
      <h2>4. Subscriptions, billing and SMS usage</h2>
      <p>
        AccountPulse does not currently offer a free trial and the first payment
        is due on signup. You may choose monthly or annual billing. The annual
        price includes a 5% discount compared with twelve monthly payments.
        Subscriptions renew until cancelled, and cancellation takes effect at the
        end of the current billing period. Prices and applicable GST are disclosed
        before purchase.
      </p>
      <p>
        The initial payment must be made by card. After that payment succeeds,
        an Australian customer may request Australian BECS Direct Debit for
        future renewals. Direct debit is not enabled automatically: the account
        holder must complete a valid Direct Debit Request and receive the
        applicable service agreement before any bank debit is submitted. Bank
        details are collected and stored by the payment provider rather than
        AccountPulse.
      </p>
      <p>
        An SMS may consume more than one part because of message length or
        character encoding. The Solo subscription includes 1,000 outbound SMS
        parts in each monthly allowance period, including for annually billed
        subscriptions. Each additional outbound SMS part is billed as overage
        at A$0.11 excluding GST. Included parts reset at the end of each monthly
        allowance period. Unused included parts and overage do not roll over,
        have no cash value and are not refundable.
        Dedicated-number or provisioning fees are not refundable once incurred,
        except where required by law or where the service cannot be supplied.
      </p>
      <p>
        A failed payment pauses customer sending and starts a 30-day
        payment-recovery period. Billing recovery remains available during that
        period. If payment is not resolved, account access may be suspended until
        payment is made or the subscription ends.
      </p>
      <p>
        We do not provide refunds merely because you change your mind, select the
        wrong plan or do not use the service. This does not limit any remedy you
        are entitled to under the Australian Consumer Law. Approved refunds are
        returned to the original payment method within 14 business days.
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
        disconnect Xero. Account records are retained for five years after
        cancellation for support, security, accounting, disputes and legal
        obligations. Sensitive message content may be redacted earlier under the
        published retention schedule. After the retention period, data is deleted
        or de-identified unless a legal hold requires continued retention.
      </p>
      <h2>8. Liability and consumer rights</h2>
      <p>
        Nothing in these Terms excludes rights that cannot lawfully be excluded,
        including rights under the Australian Consumer Law. To the extent
        permitted by law, neither party is liable for
        indirect or consequential loss, and our aggregate liability is limited
        to the fees paid for the service in the preceding 12 months.
      </p>
      <h2>9. Governing law and contact</h2>
      <p>
        These Terms are governed by the laws of Victoria, Australia. Our
        business address is {legal.address}. Contact{' '}
        <a href={`mailto:${legal.supportEmail}`}>{legal.supportEmail}</a> with
        questions or cancellation requests.
      </p>
    </>
  );
}
