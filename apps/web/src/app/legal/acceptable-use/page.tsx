import { legalIdentity, legalLastUpdated } from '../../../server/legal-content.js';

export default function AcceptableUsePage() {
  const legal = legalIdentity();
  return (
    <>
      <span className="eyebrow">Legal</span>
      <h1>Acceptable Use and Messaging Policy</h1>
      <p className="muted-copy">Last updated: {legalLastUpdated}</p>
      <p>
        This policy protects recipients, customers and the AccountPulse service.
        It forms part of the Terms of Service.
      </p>
      <h2>Permitted use</h2>
      <p>
        Use AccountPulse only for genuine business accounts-receivable activity
        involving your organisation and people it is lawfully permitted to
        contact. Keep Xero contact details accurate and review each automated
        sequence before activation.
      </p>
      <h2>Messaging rules</h2>
      <ul>
        <li>Identify the business responsible for every message.</li>
        <li>Send only messages supported by consent or another lawful basis.</li>
        <li>Provide and honour a clear opt-out where applicable.</li>
        <li>Stop or pause contact for disputes, hardship or payment arrangements.</li>
        <li>Do not disguise the sender, use purchased lists or send spam.</li>
      </ul>
      <h2>Prohibited use</h2>
      <p>
        Do not use the service for harassment, threats, deception, unlawful debt
        collection, marketing unrelated to the underlying account, malware,
        credential theft, privacy violations or attempts to bypass security,
        sending limits or provider rules.
      </p>
      <h2>Enforcement</h2>
      <p>
        We may pause messages, restrict features or suspend an account while
        investigating suspected misuse. Report misuse or recipient complaints to{' '}
        <a href={`mailto:${legal.supportEmail}`}>{legal.supportEmail}</a>.
      </p>
    </>
  );
}
