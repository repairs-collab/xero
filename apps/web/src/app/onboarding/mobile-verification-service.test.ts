import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  createMobileVerificationService,
  type MobileVerificationRepository
} from './mobile-verification-service.js';

const now = new Date('2026-11-10T00:00:00.000Z');
const session = (role: 'ADMIN' | 'OPERATOR' = 'ADMIN') => ({
  userId: `user_${role.toLowerCase()}`,
  cognitoSubject: `subject_${role.toLowerCase()}`,
  displayName: role,
  expiresAt: '2026-11-11T00:00:00.000Z',
  memberships: [
    { organisationId: 'org_solo', role, active: true as const }
  ]
});

class FakeRepository implements MobileVerificationRepository {
  beginInputs: Parameters<MobileVerificationRepository['begin']>[0][] = [];
  verifyInputs: Parameters<MobileVerificationRepository['verify']>[0][] = [];
  verifyResult: 'VERIFIED' | 'INVALID' | 'EXPIRED' | 'LOCKED' = 'VERIFIED';

  begin(input: Parameters<MobileVerificationRepository['begin']>[0]) {
    this.beginInputs.push(input);
    return Promise.resolve({ outboundMessageId: 'outbound_otp' });
  }

  verify(input: Parameters<MobileVerificationRepository['verify']>[0]) {
    this.verifyInputs.push(input);
    return Promise.resolve(this.verifyResult);
  }
}

describe('Administrator mobile verification', () => {
  it('queues a short-lived platform-funded OTP for a normalised AU mobile', async () => {
    const repository = new FakeRepository();
    const publish = vi.fn(() => Promise.resolve('job_otp'));
    const service = createMobileVerificationService({
      repository,
      publish,
      clock: { now: () => now },
      codeGenerator: () => '394512',
      hmacSecret: Buffer.alloc(32, 7)
    });

    await expect(
      service.requestCode(session(), {
        organisationId: 'org_solo',
        mobile: '0476 057 649'
      })
    ).resolves.toEqual({ destination: '+61476057649', jobId: 'job_otp' });
    expect(repository.beginInputs[0]).toMatchObject({
      organisationId: 'org_solo',
      actorUserId: 'user_admin',
      destination: '+61476057649',
      expiresAt: new Date('2026-11-10T00:10:00.000Z'),
      occurredAt: now,
      content: 'Your AccountPulse verification code is 394512. It expires in 10 minutes.'
    });
    expect(repository.beginInputs[0]?.codeHash).toBe(
      createHmac('sha256', Buffer.alloc(32, 7))
        .update('org_solo:user_admin:+61476057649:394512')
        .digest('hex')
    );
    expect(publish).toHaveBeenCalledWith('org_solo', 'outbound_otp');
  });

  it('verifies the code without storing it and rejects Operators', async () => {
    const repository = new FakeRepository();
    const service = createMobileVerificationService({
      repository,
      publish: () => Promise.resolve('job_otp'),
      clock: { now: () => now },
      codeGenerator: () => '394512',
      hmacSecret: Buffer.alloc(32, 7)
    });

    await expect(
      service.verifyCode(session(), {
        organisationId: 'org_solo',
        code: '394512'
      })
    ).resolves.toBe('VERIFIED');
    expect(repository.verifyInputs[0]).toMatchObject({
      organisationId: 'org_solo',
      actorUserId: 'user_admin',
      code: '394512',
      occurredAt: now
    });
    await expect(
      service.requestCode(session('OPERATOR'), {
        organisationId: 'org_solo',
        mobile: '0476 057 649'
      })
    ).rejects.toThrow('FORBIDDEN');
  });

  it('rejects invalid mobiles and non-six-digit codes before persistence', async () => {
    const repository = new FakeRepository();
    const service = createMobileVerificationService({
      repository,
      publish: () => Promise.resolve('job_otp'),
      clock: { now: () => now },
      codeGenerator: () => '394512',
      hmacSecret: Buffer.alloc(32, 7)
    });

    await expect(
      service.requestCode(session(), {
        organisationId: 'org_solo',
        mobile: '03 5032 4518'
      })
    ).rejects.toThrow('INVALID_AU_MOBILE_NUMBER');
    await expect(
      service.verifyCode(session(), {
        organisationId: 'org_solo',
        code: '123'
      })
    ).rejects.toThrow('INVALID_MOBILE_VERIFICATION_CODE');
    expect(repository.beginInputs).toEqual([]);
    expect(repository.verifyInputs).toEqual([]);
  });
});
