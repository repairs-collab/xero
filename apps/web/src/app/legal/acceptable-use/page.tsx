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
        <li>
          A STOP or equivalent opt-out reply automatically pauses further SMS;
          it must remain paused until an authorised manual review permits lawful
          contact.
        </li>
        <li>Stop or pause contact for disputes, hardship or payment arrangements.</li>
        <li>Do not disguise the sender, use purchased lists or send spam.</li>
      </ul>
      <h2>Debt-reminder contact controls</h2>
      <ul>
        <li>
          Schedule SMS and automated calls only during business hours: Monday to
          Friday, 8:30am–5:00pm Australia/Sydney, excluding public holidays.
        </li>
        <li>
          Make no more than one outbound debt-reminder contact per day for the
          same customer or account across SMS and automated calls combined.
        </li>
        <li>
          Users must manually mark disputed invoices, hardship matters and
          payment arrangements so automated contact is paused while a person
          reviews the matter.
        </li>
        <li>
          Inbound calls may be recorded only after clear notice and where the
          recording is lawful. Recordings are protected and retained under the
          published Privacy Policy.
        </li>
      </ul>
      <p>
        K Heaton handles complaints and hardship requests. Email{' '}
        <a href={`mailto:${legal.complaintsEmail}`}>
          {legal.complaintsEmail}
        </a>{' '}
        so the matter can be reviewed and automated contact paused where needed.
      </p>
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
        <a href={`mailto:${legal.complaintsEmail}`}>
          {legal.complaintsEmail}
        </a>.
      </p>
    </>
  );
}
