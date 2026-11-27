import { expect, it, vi } from 'vitest';

import { runLifecycleEmailProof } from './lifecycle-email-proof.js';

const input = (...chunks: string[]) => chunks.map((chunk) => Buffer.from(chunk));

it('submits one synthetic welcome message to the AccountPulse mailbox through VentraIP', async () => {
  const send = vi.fn().mockResolvedValue({
    status: 'SENT',
    messageId: '<private-proof-id@motts.com.au>'
  });
  const factory = vi.fn(() => ({ send }));

  await expect(runLifecycleEmailProof(input('test', '-only'), 'false', factory))
    .resolves.toBe('LIFECYCLE_EMAIL_PROOF_ACCEPTED');
  expect(factory).toHaveBeenCalledOnce();
  expect(factory).toHaveBeenCalledWith({
    host: 'ventraip.email',
    port: 465,
    secure: true,
    user: 'ap@motts.com.au',
    pass: 'test-only',
    fromName: 'AccountPulse',
    fromAddress: 'ap@motts.com.au',
    replyTo: 'ap@motts.com.au'
  });
  expect(send).toHaveBeenCalledExactlyOnceWith({
    recipient: 'ap@motts.com.au',
    template: 'WORKSPACE_WELCOME',
    templateVersion: 1,
    renderData: { organisationName: 'the internal SMTP delivery test' }
  });
});

it.each(['', 'a\nb', '\u0000', 'x'.repeat(4097)])('rejects invalid stdin without opening a connection', async (password) => {
  const factory = vi.fn();
  await expect(runLifecycleEmailProof(input(password), 'false', factory))
    .resolves.toBe('LIFECYCLE_EMAIL_PROOF_REFUSED');
  expect(factory).not.toHaveBeenCalled();
});

it('refuses to send a proof while customer email is enabled', async () => {
  const factory = vi.fn();
  await expect(runLifecycleEmailProof(input('test-only'), 'true', factory))
    .resolves.toBe('LIFECYCLE_EMAIL_PROOF_REFUSED');
  expect(factory).not.toHaveBeenCalled();
});

it.each([
  { status: 'FAILED', failureCode: 'PRIVATE_PROVIDER_RESPONSE' },
  { status: 'UNKNOWN', failureCode: 'PRIVATE_PROVIDER_RESPONSE' }
])('reports only a fixed unsuccessful result', async (result) => {
  const send = vi.fn().mockResolvedValue(result);
  await expect(runLifecycleEmailProof(input('test-only'), undefined, () => ({ send })))
    .resolves.toBe('LIFECYCLE_EMAIL_PROOF_NOT_CONFIRMED');
  expect(send).toHaveBeenCalledOnce();
});
