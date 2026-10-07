import crypto from 'node:crypto';
import { env } from '../config/env.js';

export interface EncryptedPayload {
  iv: string;       // Hex encoded 12-byte initialization vector
  tag: string;      // Hex encoded 16-byte GCM authentication tag
  ciphertext: string; // Hex encoded encrypted data
}

export class CryptoService {
  private readonly masterKey: Buffer;

  constructor(hexKey?: string) {
    const rawKey = hexKey || env.PII_ENCRYPTION_KEY;
    // Derive a fixed 32-byte key if raw key is provided in hex or text
    if (rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) {
      this.masterKey = Buffer.from(rawKey, 'hex');
    } else {
      this.masterKey = crypto.createHash('sha256').update(rawKey).digest();
    }
  }

  /**
   * Encrypts plaintext string using AES-256-GCM.
   * Returns a compact serialized string: "iv:tag:ciphertext"
   */
  public encrypt(plaintext: string): string {
    if (!plaintext) return '';
    const iv = crypto.randomBytes(12); // Standard 96-bit IV for AES-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    
    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    
    const tag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${tag}:${ciphertext}`;
  }

  /**
   * Decrypts serialized "iv:tag:ciphertext" string back to original plaintext.
   */
  public decrypt(encryptedString: string): string {
    if (!encryptedString) return '';
    const parts = encryptedString.split(':');
    if (parts.length !== 3) {
      throw new Error('Malformed encrypted payload format. Expected "iv:tag:ciphertext"');
    }

    const [ivHex, tagHex, ciphertextHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv);
    
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Computes SHA-256 hash of a file buffer or string.
   */
  public hashSha256(data: Buffer | string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Derives a deterministic pseudonymous identifier for public audit logging.
   * Prevents correlation of beneficiary addresses in public feeds.
   */
  public pseudonymize(address: string, salt = 'aidtrail-public-salt'): string {
    const hmac = crypto.createHmac('sha256', this.masterKey);
    hmac.update(`${salt}:${address}`);
    const digest = hmac.digest('hex');
    return `anon_${digest.slice(0, 16)}`;
  }

  /**
   * Generates secure cryptographic random nonce or token.
   */
  public generateSecureToken(bytes = 32): string {
    return crypto.randomBytes(bytes).toString('hex');
  }
}

export const cryptoService = new CryptoService();
