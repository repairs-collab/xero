import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from 'node:crypto';

const ENVELOPE_VERSION = 1 as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface EncryptedTokenEnvelope {
  version: number;
  keyId: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface TokenCipher {
  encrypt(plaintext: string): EncryptedTokenEnvelope;
  decrypt(envelope: EncryptedTokenEnvelope): string;
}

export interface AesGcmTokenCipherEnvironment {
  keysJson: string;
  activeKeyId: string;
}

const decodeBase64Strict = (value: string, expectedBytes?: number): Buffer => {
  if (value.length === 0 || !BASE64_PATTERN.test(value)) {
    throw new Error('invalid base64');
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error('non-canonical base64');
  }
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new Error('invalid decoded length');
  }
  return decoded;
};

const authenticatedData = (keyId: string): Buffer =>
  Buffer.from(`accountpulse:xero-refresh-token:v${ENVELOPE_VERSION}:${keyId}`, 'utf8');

export class AesGcmTokenCipher implements TokenCipher {
  private constructor(
    private readonly keys: ReadonlyMap<string, Buffer>,
    private readonly activeKeyId: string
  ) {}

  static fromEnvironment(
    environment: AesGcmTokenCipherEnvironment
  ): AesGcmTokenCipher {
    try {
      if (environment.activeKeyId.length === 0) {
        throw new Error('missing active key id');
      }

      const parsed: unknown = JSON.parse(environment.keysJson);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('keys must be an object');
      }

      const entries = Object.entries(parsed as Record<string, unknown>);
      if (entries.length === 0) {
        throw new Error('no keys configured');
      }

      const keys = new Map<string, Buffer>();
      for (const [keyId, encodedKey] of entries) {
        if (keyId.length === 0 || typeof encodedKey !== 'string') {
          throw new Error('invalid key entry');
        }
        keys.set(keyId, decodeBase64Strict(encodedKey, KEY_BYTES));
      }

      if (!keys.has(environment.activeKeyId)) {
        throw new Error('active key not configured');
      }

      return new AesGcmTokenCipher(keys, environment.activeKeyId);
    } catch {
      throw new Error('Invalid Xero token encryption configuration');
    }
  }

  encrypt(plaintext: string): EncryptedTokenEnvelope {
    try {
      if (plaintext.length === 0) {
        throw new Error('empty token');
      }

      const key = this.keys.get(this.activeKeyId);
      if (key === undefined) {
        throw new Error('active key unavailable');
      }

      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv, {
        authTagLength: TAG_BYTES
      });
      cipher.setAAD(authenticatedData(this.activeKeyId));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final()
      ]);

      return {
        version: ENVELOPE_VERSION,
        keyId: this.activeKeyId,
        iv: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64')
      };
    } catch {
      throw new Error('Unable to encrypt Xero token');
    }
  }

  decrypt(envelope: EncryptedTokenEnvelope): string {
    try {
      if (envelope.version !== ENVELOPE_VERSION || envelope.keyId.length === 0) {
        throw new Error('unsupported envelope');
      }

      const key = this.keys.get(envelope.keyId);
      if (key === undefined) {
        throw new Error('unknown key');
      }

      const iv = decodeBase64Strict(envelope.iv, IV_BYTES);
      const ciphertext = decodeBase64Strict(envelope.ciphertext);
      const tag = decodeBase64Strict(envelope.tag, TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv, {
        authTagLength: TAG_BYTES
      });
      decipher.setAAD(authenticatedData(envelope.keyId));
      decipher.setAuthTag(tag);

      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]).toString('utf8');
    } catch {
      throw new Error('Unable to decrypt stored Xero token');
    }
  }
}
