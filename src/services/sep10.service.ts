import {
  Keypair,
  TransactionBuilder,
  Account,
  Operation,
  Networks,
  Transaction,
  xdr,
} from '@stellar/stellar-sdk';
import { env } from '../config/env.js';
import { cryptoService } from './crypto.service.js';

export interface ChallengeResult {
  transactionXdr: string;
  networkPassphrase: string;
  homeDomain: string;
  expiresAt: string;
}

export interface VerificationResult {
  clientAddress: string;
  isValid: boolean;
  error?: string;
}

export class Sep10Service {
  private serverKeypair: Keypair;
  private readonly networkPassphrase: string;
  private readonly homeDomain: string;

  constructor() {
    this.networkPassphrase = env.STELLAR_NETWORK_PASSPHRASE;
    this.homeDomain = env.SERVER_HOME_DOMAIN;

    // Load server signing key or generate deterministic fallback for test/dev
    try {
      if (
        env.SERVER_SIGNING_KEY &&
        env.SERVER_SIGNING_KEY.startsWith('S') &&
        env.SERVER_SIGNING_KEY.length === 56
      ) {
        this.serverKeypair = Keypair.fromSecret(env.SERVER_SIGNING_KEY);
      } else {
        // Fallback for dev/test environments
        const seed = cryptoService.hashSha256('aidtrail-server-master-key');
        this.serverKeypair = Keypair.fromRawEd25519Seed(
          Buffer.from(seed, 'hex')
        );
      }
    } catch {
      const seed = cryptoService.hashSha256('aidtrail-server-master-key');
      this.serverKeypair = Keypair.fromRawEd25519Seed(
        Buffer.from(seed, 'hex')
      );
    }
  }

  public getServerPublicKey(): string {
    return this.serverKeypair.publicKey();
  }

  /**
   * Generates a SEP-10 compliant challenge transaction envelope XDR.
   */
  public generateChallenge(
    clientAddress: string,
    timeoutSeconds = 300
  ): ChallengeResult {
    // Validate client public key format
    try {
      Keypair.fromPublicKey(clientAddress);
    } catch {
      throw new Error(`Invalid Stellar client public key: ${clientAddress}`);
    }

    const now = Math.floor(Date.now() / 1000);
    const validUntil = now + timeoutSeconds;

    // Source account is server account with sequence number 0
    const serverAccount = new Account(this.serverKeypair.publicKey(), '0');

    // Random 64-byte nonce to prevent replay attacks
    const nonce = cryptoService.generateSecureToken(32);

    const builder = new TransactionBuilder(serverAccount, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
      timebounds: {
        minTime: now,
        maxTime: validUntil,
      },
    });

    // Operation 1: manageData with client address as source and nonce as value
    builder.addOperation(
      Operation.manageData({
        source: clientAddress,
        name: `${this.homeDomain} auth`,
        value: Buffer.from(nonce, 'utf-8'),
      })
    );

    const transaction = builder.build();

    // Sign with server private key
    transaction.sign(this.serverKeypair);

    return {
      transactionXdr: transaction.toXDR(),
      networkPassphrase: this.networkPassphrase,
      homeDomain: this.homeDomain,
      expiresAt: new Date(validUntil * 1000).toISOString(),
    };
  }

  /**
   * Verifies that the challenge transaction has valid signatures from both server and client.
   */
  public verifyChallenge(
    signedTxXdr: string,
    expectedClientAddress: string
  ): VerificationResult {
    try {
      const tx = TransactionBuilder.fromXDR(
        signedTxXdr,
        this.networkPassphrase
      ) as Transaction;

      // 1. Verify sequence number is 0
      if (tx.sequence !== '0') {
        return {
          clientAddress: expectedClientAddress,
          isValid: false,
          error: 'Invalid sequence number; SEP-10 requires sequence 0',
        };
      }

      // 2. Verify timebounds
      const now = Math.floor(Date.now() / 1000);
      if (!tx.timeBounds) {
        return {
          clientAddress: expectedClientAddress,
          isValid: false,
          error: 'Transaction must include valid time bounds',
        };
      }

      const minTime = parseInt(tx.timeBounds.minTime, 10);
      const maxTime = parseInt(tx.timeBounds.maxTime, 10);

      if (now < minTime || now > maxTime) {
        return {
          clientAddress: expectedClientAddress,
          isValid: false,
          error: `Challenge transaction expired (current: ${now}, valid: ${minTime}-${maxTime})`,
        };
      }

      // 3. Verify server signature
      const txHash = tx.hash();
      const serverKey = this.serverKeypair.rawPublicKey();
      const hasServerSig = tx.signatures.some((sig) => {
        return (
          sig.hint().equals(this.serverKeypair.signatureHint()) &&
          this.serverKeypair.verify(txHash, sig.signature())
        );
      });

      if (!hasServerSig) {
        return {
          clientAddress: expectedClientAddress,
          isValid: false,
          error: 'Transaction is missing valid signature from server',
        };
      }

      // 4. Verify client signature
      const clientKeypair = Keypair.fromPublicKey(expectedClientAddress);
      const hasClientSig = tx.signatures.some((sig) => {
        return (
          sig.hint().equals(clientKeypair.signatureHint()) &&
          clientKeypair.verify(txHash, sig.signature())
        );
      });

      if (!hasClientSig) {
        return {
          clientAddress: expectedClientAddress,
          isValid: false,
          error: `Transaction is missing valid signature from client: ${expectedClientAddress}`,
        };
      }

      // 5. Verify operations
      if (tx.operations.length < 1) {
        return {
          clientAddress: expectedClientAddress,
          isValid: false,
          error: 'Transaction must contain at least one operation',
        };
      }

      const op = tx.operations[0];
      if (op.type !== 'manageData') {
        return {
          clientAddress: expectedClientAddress,
          isValid: false,
          error: 'First operation must be manageData',
        };
      }

      if (op.source !== expectedClientAddress) {
        return {
          clientAddress: expectedClientAddress,
          isValid: false,
          error: `Operation source does not match expected client address: ${expectedClientAddress}`,
        };
      }

      return {
        clientAddress: expectedClientAddress,
        isValid: true,
      };
    } catch (err: any) {
      return {
        clientAddress: expectedClientAddress,
        isValid: false,
        error: `Challenge verification failed: ${err.message}`,
      };
    }
  }
}

export const sep10Service = new Sep10Service();
