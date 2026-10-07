import { scValToNative, xdr } from '@stellar/stellar-sdk';

export interface RawRpcEvent {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  topic: (string | xdr.ScVal)[];
  value: string | xdr.ScVal;
  txHash: string;
}

export type EventTopicKind =
  | 'contract:init'
  | 'contract:paused'
  | 'program:created'
  | 'program:funded'
  | 'program:cancel'
  | 'program:refund'
  | 'milestn:added'
  | 'milestn:apprvd'
  | 'milestn:release'
  | 'vendor:reg'
  | 'vendor:rem'
  | 'voucher:issued'
  | 'voucher:redeem'
  | 'voucher:reclaim'
  | 'unknown';

export interface ParsedEvent<T = any> {
  id: string;
  contractId: string;
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  kind: EventTopicKind;
  topicPrimary: string;
  topicSecondary: string;
  data: T;
}

export class EventParser {
  /**
   * Safely converts an ScVal (base64 or ScVal object) to a native JS value.
   */
  public parseScVal(val: string | xdr.ScVal): any {
    try {
      if (typeof val === 'string') {
        const scVal = xdr.ScVal.fromXDR(val, 'base64');
        return scValToNative(scVal);
      }
      return scValToNative(val);
    } catch {
      return val;
    }
  }

  /**
   * Parses raw Soroban RPC getEvents record into strongly-typed AidTrail event.
   */
  public parseRpcEvent(raw: RawRpcEvent): ParsedEvent | null {
    try {
      // Decode topic array
      const rawTopics = raw.topic || [];
      const topics: string[] = rawTopics.map((t) => {
        const parsed = this.parseScVal(t);
        return typeof parsed === 'string' ? parsed : String(parsed);
      });

      const primary = topics[0] || '';
      const secondary = topics[1] || '';
      const kindKey = `${primary}:${secondary}` as EventTopicKind;

      const rawData = this.parseScVal(raw.value);
      const ledgerClosedAt = raw.ledgerClosedAt
        ? new Date(raw.ledgerClosedAt)
        : new Date();

      let typedData: any = rawData;

      switch (kindKey) {
        case 'program:created': {
          // (program_id: u64, ngo: Address, token: Address, metadata_uri: String)
          if (Array.isArray(rawData) && rawData.length >= 4) {
            typedData = {
              programId: BigInt(rawData[0]),
              ngoAddress: String(rawData[1]),
              tokenAddress: String(rawData[2]),
              metadataUri: String(rawData[3]),
            };
          }
          break;
        }

        case 'program:funded': {
          // (program_id: u64, donor: Address, amount: i128)
          if (Array.isArray(rawData) && rawData.length >= 3) {
            typedData = {
              programId: BigInt(rawData[0]),
              donorAddress: String(rawData[1]),
              amount: BigInt(rawData[2]),
            };
          }
          break;
        }

        case 'program:cancel': {
          // (program_id: u64, refundable_pool: i128)
          if (Array.isArray(rawData) && rawData.length >= 2) {
            typedData = {
              programId: BigInt(rawData[0]),
              refundablePool: BigInt(rawData[1]),
            };
          }
          break;
        }

        case 'program:refund': {
          // (program_id: u64, donor: Address, amount: i128)
          if (Array.isArray(rawData) && rawData.length >= 3) {
            typedData = {
              programId: BigInt(rawData[0]),
              donorAddress: String(rawData[1]),
              amount: BigInt(rawData[2]),
            };
          }
          break;
        }

        case 'milestn:added': {
          // (program_id: u64, milestone_id: u32, amount: i128, required_approvals: u32)
          if (Array.isArray(rawData) && rawData.length >= 4) {
            typedData = {
              programId: BigInt(rawData[0]),
              milestoneIndex: Number(rawData[1]),
              amount: BigInt(rawData[2]),
              requiredApprovals: Number(rawData[3]),
            };
          }
          break;
        }

        case 'milestn:apprvd': {
          // (program_id: u64, milestone_id: u32, verifier: Address, approvals_count: u32)
          if (Array.isArray(rawData) && rawData.length >= 4) {
            typedData = {
              programId: BigInt(rawData[0]),
              milestoneIndex: Number(rawData[1]),
              verifierAddress: String(rawData[2]),
              approvalsCount: Number(rawData[3]),
            };
          }
          break;
        }

        case 'milestn:release': {
          // (program_id: u64, milestone_id: u32, amount: i128)
          if (Array.isArray(rawData) && rawData.length >= 3) {
            typedData = {
              programId: BigInt(rawData[0]),
              milestoneIndex: Number(rawData[1]),
              amount: BigInt(rawData[2]),
            };
          }
          break;
        }

        case 'vendor:reg': {
          // (vendor: Address, allowed_categories: Vec<Symbol>)
          if (Array.isArray(rawData) && rawData.length >= 2) {
            typedData = {
              vendorAddress: String(rawData[0]),
              allowedCategories: Array.isArray(rawData[1])
                ? rawData[1].map((c) => String(c).toUpperCase())
                : [String(rawData[1]).toUpperCase()],
            };
          }
          break;
        }

        case 'vendor:rem': {
          // vendor: Address
          typedData = {
            vendorAddress: String(rawData),
          };
          break;
        }

        case 'voucher:issued': {
          // (voucher_id: u64, program_id: u64, beneficiary: Address, amount: i128, category: Symbol, expires_at: u64)
          if (Array.isArray(rawData) && rawData.length >= 6) {
            typedData = {
              voucherId: BigInt(rawData[0]),
              programId: BigInt(rawData[1]),
              beneficiaryAddress: String(rawData[2]),
              amount: BigInt(rawData[3]),
              category: String(rawData[4]).toUpperCase(),
              expiresAtSeconds: Number(rawData[5]),
            };
          }
          break;
        }

        case 'voucher:redeem': {
          // (voucher_id: u64, beneficiary: Address, vendor: Address, amount: i128)
          if (Array.isArray(rawData) && rawData.length >= 4) {
            typedData = {
              voucherId: BigInt(rawData[0]),
              beneficiaryAddress: String(rawData[1]),
              vendorAddress: String(rawData[2]),
              amount: BigInt(rawData[3]),
            };
          }
          break;
        }

        case 'voucher:reclaim': {
          // (voucher_id: u64, program_id: u64, amount: i128)
          if (Array.isArray(rawData) && rawData.length >= 3) {
            typedData = {
              voucherId: BigInt(rawData[0]),
              programId: BigInt(rawData[1]),
              amount: BigInt(rawData[2]),
            };
          }
          break;
        }

        case 'contract:init': {
          typedData = {
            adminAddress: String(rawData),
          };
          break;
        }

        case 'contract:paused': {
          typedData = {
            paused: Boolean(rawData),
          };
          break;
        }

        default:
          return null;
      }

      return {
        id: raw.id,
        contractId: raw.contractId,
        ledger: raw.ledger,
        ledgerClosedAt,
        txHash: raw.txHash || '',
        kind: kindKey,
        topicPrimary: primary,
        topicSecondary: secondary,
        data: typedData,
      };
    } catch (err) {
      return null;
    }
  }
}

export const eventParser = new EventParser();
