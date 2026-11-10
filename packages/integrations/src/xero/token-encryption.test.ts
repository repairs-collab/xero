import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AesGcmTokenCipher,
  type EncryptedTokenEnvelope,
  type TokenCipher
} from './token-encryption.js';

const key = (fill: number): string => Buffer.alloc(32, fill).toString('base64');

const createCipher = (): AesGcmTokenCipher =>
  AesGcmTokenCipher.fromEnvironment({
    keysJson: JSON.stringify({ primary: key(1), previous: key(2) }),
    activeKeyId: 'primary'
  });

describe('AesGcmTokenCipher', () => {
  it('implements the token cipher contract and round-trips a refresh token', () => {
    const cipher: TokenCipher = createCipher();
    const encrypted = cipher.encrypt('refresh-token-secret');

    expect(encrypted).toMatchObject({
      version: 1,
      keyId: 'primary'
    });
    expect(typeof encrypted.iv).toBe('string');
    expect(typeof encrypted.ciphertext).toBe('string');
    expect(typeof encrypted.tag).toBe('string');
    expect(Buffer.from(encrypted.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(encrypted.tag, 'base64')).toHaveLength(16);
    expect(cipher.decrypt(encrypted)).toBe('refresh-token-secret');
  });

  it('uses a new IV so repeated encryption does not repeat ciphertext', () => {
    const cipher = createCipher();
    const first = cipher.encrypt('same-refresh-token');
    const second = cipher.encrypt('same-refresh-token');

    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it('decrypts envelopes written by a configured non-active key', () => {
    const previous = AesGcmTokenCipher.fromEnvironment({
      keysJson: JSON.stringify({ previous: key(2) }),
      activeKeyId: 'previous'
    });
    const current = createCipher();

    expect(current.decrypt(previous.encrypt('rotating-refresh-token'))).toBe(
      'rotating-refresh-token'
    );
  });

  it('rejects unknown key IDs and unsupported envelope versions', () => {
    const cipher = createCipher();
    const encrypted = cipher.encrypt('refresh-token-secret');

    expect(() => cipher.decrypt({ ...encrypted, keyId: 'missing' })).toThrow(
      'Unable to decrypt stored Xero token'
    );
    const unsupportedEnvelope: unknown = { ...encrypted, version: 2 };
    expect(() =>
      cipher.decrypt(unsupportedEnvelope as EncryptedTokenEnvelope)
    ).toThrow('Unable to decrypt stored Xero token');
  });

  it('strictly rejects malformed base64 and invalid field lengths', () => {
    const cipher = createCipher();
    const encrypted = cipher.encrypt('refresh-token-secret');

    for (const envelope of [
      { ...encrypted, iv: 'not base64!' },
      { ...encrypted, iv: randomBytes(8).toString('base64') },
      { ...encrypted, ciphertext: 'abc' },
      { ...encrypted, tag: randomBytes(8).toString('base64') }
    ]) {
      expect(() => cipher.decrypt(envelope)).toThrow(
        'Unable to decrypt stored Xero token'
      );
    }
  });

  it('detects modified ciphertext and authentication tags', () => {
    const cipher = createCipher();
    const encrypted = cipher.encrypt('refresh-token-secret');
    const tamperedCiphertext = Buffer.from(encrypted.ciphertext, 'base64');
    tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 1;
    const tamperedTag = Buffer.from(encrypted.tag, 'base64');
    tamperedTag[0] = (tamperedTag[0] ?? 0) ^ 1;

    expect(() =>
      cipher.decrypt({
        ...encrypted,
        ciphertext: tamperedCiphertext.toString('base64')
      })
    ).toThrow('Unable to decrypt stored Xero token');
    expect(() =>
      cipher.decrypt({ ...encrypted, tag: tamperedTag.toString('base64') })
    ).toThrow('Unable to decrypt stored Xero token');
  });

  it('rejects invalid environment key sets and keys that are not 32 bytes', () => {
    const invalidConfigurations = [
      { keysJson: 'not-json', activeKeyId: 'primary' },
      { keysJson: '[]', activeKeyId: 'primary' },
      { keysJson: JSON.stringify({ primary: 'not base64!' }), activeKeyId: 'primary' },
      {
        keysJson: JSON.stringify({ primary: Buffer.alloc(31).toString('base64') }),
        activeKeyId: 'primary'
      },
      { keysJson: JSON.stringify({ previous: key(2) }), activeKeyId: 'primary' }
    ];

    for (const configuration of invalidConfigurations) {
      expect(() => AesGcmTokenCipher.fromEnvironment(configuration)).toThrow(
        'Invalid Xero token encryption configuration'
      );
    }
  });

  it('never includes plaintext or stored ciphertext in thrown errors', () => {
    const plaintext = 'refresh-token-that-must-not-leak';
    const cipher = createCipher();
    const encrypted = cipher.encrypt(plaintext);
    const corrupted = {
      ...encrypted,
      ciphertext: Buffer.from('corrupted-token-material').toString('base64')
    };

    let error: unknown;
    try {
      cipher.decrypt(corrupted);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toContain(plaintext);
    expect(message).not.toContain(encrypted.ciphertext);
    expect(message).not.toContain(corrupted.ciphertext);
  });
});
