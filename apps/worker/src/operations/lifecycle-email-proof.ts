import { createLifecycleEmailClient } from '@bc5000/integrations/email';

const mailbox = 'ap@motts.com.au';
const maximumPasswordBytes = 4096;

export async function runLifecycleEmailProof(
  input: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  deliveryEnabled: string | undefined,
  createClient = createLifecycleEmailClient
): Promise<
  'LIFECYCLE_EMAIL_PROOF_ACCEPTED' |
  'LIFECYCLE_EMAIL_PROOF_NOT_CONFIRMED' |
  'LIFECYCLE_EMAIL_PROOF_REFUSED'
> {
  if (deliveryEnabled !== undefined && deliveryEnabled !== 'false') {
    return 'LIFECYCLE_EMAIL_PROOF_REFUSED';
  }
  const bytes: Uint8Array[] = [];
  let size = 0;
  let password: string;
  try {
    for await (const chunk of input) {
      size += chunk.byteLength;
      if (size > maximumPasswordBytes) return 'LIFECYCLE_EMAIL_PROOF_REFUSED';
      bytes.push(chunk);
    }
    password = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(Buffer.concat(bytes, size));
    if (!password.trim() || /[\p{Cc}]/u.test(password)) {
      return 'LIFECYCLE_EMAIL_PROOF_REFUSED';
    }
  } catch {
    return 'LIFECYCLE_EMAIL_PROOF_REFUSED';
  }

  try {
    const client = createClient({
      host: 'ventraip.email',
      port: 465,
      secure: true,
      user: mailbox,
      pass: password,
      fromName: 'AccountPulse',
      fromAddress: mailbox,
      replyTo: mailbox
    });
    const outcome = await client.send({
      recipient: mailbox,
      template: 'WORKSPACE_WELCOME',
      templateVersion: 1,
      renderData: { organisationName: 'the internal SMTP delivery test' }
    });
    if (outcome.status === 'SENT') return 'LIFECYCLE_EMAIL_PROOF_ACCEPTED';
  } catch {
    // The provider response and credential must never reach the command output.
  }
  return 'LIFECYCLE_EMAIL_PROOF_NOT_CONFIRMED';
}
