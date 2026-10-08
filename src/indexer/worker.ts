import { rpc } from '@stellar/stellar-sdk';
import { env } from '../config/env.js';
import { eventParser, ParsedEvent } from './event-parser.js';
import { cursorManager } from './cursor.js';
import { programEventHandler } from './handlers/program-handler.js';
import { voucherEventHandler } from './handlers/voucher-handler.js';

export interface IndexerStats {
  isRunning: boolean;
  lastPollAt: Date | null;
  lastLedgerIndexed: number;
  totalEventsProcessed: number;
  lastError: string | null;
  consecutiveErrors: number;
}

export class IndexerWorker {
  private readonly rpcServer: rpc.Server;
  private readonly contractId: string;
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;

  public stats: IndexerStats = {
    isRunning: false,
    lastPollAt: null,
    lastLedgerIndexed: 0,
    totalEventsProcessed: 0,
    lastError: null,
    consecutiveErrors: 0,
  };

  constructor() {
    this.rpcServer = new rpc.Server(env.SOROBAN_RPC_URL, {
      allowHttp: env.NODE_ENV !== 'production',
    });
    this.contractId = env.CONTRACT_ID;
  }

  /**
   * Starts the polling background service.
   */
  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.stats.isRunning = true;
    console.log(
      `🚀 AidTrail Indexer Worker started. Polling contract ${this.contractId} on ${env.SOROBAN_RPC_URL}...`
    );

    await this.pollCycle();
  }

  /**
   * Stops the indexer loop cleanly.
   */
  public stop(): void {
    this.isRunning = false;
    this.stats.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('🛑 AidTrail Indexer Worker stopped.');
  }

  /**
   * Executes one polling cycle against Soroban RPC getEvents.
   */
  public async pollCycle(): Promise<void> {
    if (!this.isRunning) return;

    let delayMs = env.INDEXER_POLL_INTERVAL_MS;

    try {
      this.stats.lastPollAt = new Date();
      const { cursor, lastLedger } = await cursorManager.getCursor();
      this.stats.lastLedgerIndexed = lastLedger;

      // Query getEvents from Soroban RPC
      const requestOptions: rpc.Server.GetEventsRequest = {
        startLedger: cursor ? undefined : Math.max(1, lastLedger),
        cursor: cursor || undefined,
        filters: [
          {
            type: 'contract',
            contractIds: [this.contractId],
          },
        ],
        limit: env.INDEXER_BATCH_SIZE,
      };

      let response: rpc.Api.GetEventsResponse | null = null;
      try {
        response = await this.rpcServer.getEvents(requestOptions);
      } catch (rpcErr: any) {
        // RPC might be offline in mock/isolated test environment
        if (env.NODE_ENV === 'test') {
          return;
        }
        throw rpcErr;
      }

      if (response && response.events && response.events.length > 0) {
        let maxLedgerInBatch = lastLedger;
        let lastCursorInBatch = cursor;

        for (const rawEvent of response.events) {
          const parsed = eventParser.parseRpcEvent(rawEvent as any);
          if (parsed) {
            // Idempotency check: record event in db
            const isNew = await cursorManager.recordEventIdempotent(parsed);
            if (isNew) {
              await this.dispatchEvent(parsed);
              this.stats.totalEventsProcessed++;
            }
          }

          if (rawEvent.ledger > maxLedgerInBatch) {
            maxLedgerInBatch = rawEvent.ledger;
          }
          if (rawEvent.id) {
            lastCursorInBatch = rawEvent.id;
          }
        }

        // Advance cursor checkpoint
        await cursorManager.advanceCursor(lastCursorInBatch, maxLedgerInBatch);
        this.stats.lastLedgerIndexed = maxLedgerInBatch;
        this.stats.consecutiveErrors = 0;
        this.stats.lastError = null;
      }

      this.stats.consecutiveErrors = 0;
    } catch (err: any) {
      this.stats.consecutiveErrors++;
      this.stats.lastError = err.message || 'Unknown RPC error';

      // Exponential backoff up to 30s
      const backoff = Math.min(
        30000,
        env.INDEXER_POLL_INTERVAL_MS * Math.pow(2, this.stats.consecutiveErrors - 1)
      );
      delayMs = backoff;
      console.warn(
        `⚠️ Indexer poll warning (attempt ${this.stats.consecutiveErrors}): ${err.message}. Retrying in ${delayMs}ms`
      );
    }

    if (this.isRunning) {
      this.pollTimer = setTimeout(() => this.pollCycle(), delayMs);
    }
  }

  /**
   * Routes parsed event to specialized domain handler.
   */
  public async dispatchEvent(event: ParsedEvent): Promise<void> {
    switch (event.kind) {
      case 'program:created':
        await programEventHandler.handleProgramCreated(event);
        break;
      case 'program:funded':
        await programEventHandler.handleProgramFunded(event);
        break;
      case 'program:cancel':
        await programEventHandler.handleProgramCancelled(event);
        break;
      case 'program:refund':
        await programEventHandler.handleDonorRefunded(event);
        break;
      case 'milestn:added':
        await programEventHandler.handleMilestoneAdded(event);
        break;
      case 'milestn:apprvd':
        await programEventHandler.handleMilestoneApproved(event);
        break;
      case 'milestn:release':
        await programEventHandler.handleMilestoneReleased(event);
        break;
      case 'milestn:ver_upd':
        await programEventHandler.handleMilestoneVerifiersUpdated(event);
        break;
      case 'vendor:reg':
        await voucherEventHandler.handleVendorRegistered(event);
        break;
      case 'vendor:rem':
        await voucherEventHandler.handleVendorRemoved(event);
        break;
      case 'voucher:issued':
        await voucherEventHandler.handleVoucherIssued(event);
        break;
      case 'voucher:redeem':
        await voucherEventHandler.handleVoucherRedeemed(event);
        break;
      case 'voucher:reclaim':
        await voucherEventHandler.handleVoucherReclaimed(event);
        break;
      case 'contract:paused':
        await programEventHandler.handleContractPaused(event);
        break;
      default:
        break;
    }
  }
}

export const indexerWorker = new IndexerWorker();

// Standalone execution entrypoint
if (process.argv[1]?.includes('worker.ts')) {
  indexerWorker.start().catch((err) => {
    console.error('Fatal indexer worker error:', err);
    process.exit(1);
  });
}
