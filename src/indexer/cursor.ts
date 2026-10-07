import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { ParsedEvent } from './event-parser.js';

export interface CursorState {
  cursor: string | null;
  lastLedger: number;
}

export class IndexerCursorManager {
  private readonly defaultId = 'default';
  private readonly reorgSafetyLedgers = 4; // Window for reorg tolerance

  /**
   * Retrieves the current persistent indexer checkpoint.
   */
  public async getCursor(): Promise<CursorState> {
    const record = await prisma.indexerCursor.findUnique({
      where: { id: this.defaultId },
    });

    if (!record) {
      const initial = await prisma.indexerCursor.create({
        data: {
          id: this.defaultId,
          cursor: null,
          lastLedger: env.INDEXER_START_LEDGER,
        },
      });
      return { cursor: initial.cursor, lastLedger: initial.lastLedger };
    }

    return {
      cursor: record.cursor,
      lastLedger: record.lastLedger,
    };
  }

  /**
   * Idempotently advances the cursor checkpoint.
   */
  public async advanceCursor(
    cursor: string | null,
    newLedger: number
  ): Promise<void> {
    await prisma.indexerCursor.upsert({
      where: { id: this.defaultId },
      update: {
        cursor,
        lastLedger: newLedger,
      },
      create: {
        id: this.defaultId,
        cursor,
        lastLedger: newLedger,
      },
    });
  }

  /**
   * Detects potential ledger reorganizations or RPC state regressions.
   * If latest ledger from RPC is lower than our indexed ledger by more than threshold,
   * flags reorg recovery.
   */
  public async detectReorg(rpcLatestLedger: number): Promise<boolean> {
    const { lastLedger } = await this.getCursor();
    if (rpcLatestLedger < lastLedger - this.reorgSafetyLedgers) {
      return true;
    }
    return false;
  }

  /**
   * Reconciles reorg by rewinding the cursor to a safe finalized ledger block.
   */
  public async rewindCursorForReorg(safeLedger: number): Promise<void> {
    const targetLedger = Math.max(0, safeLedger);
    // Delete events above targetLedger to maintain idempotent state consistency
    await prisma.$transaction([
      prisma.contractEvent.deleteMany({
        where: { ledger: { gt: targetLedger } },
      }),
      prisma.indexerCursor.update({
        where: { id: this.defaultId },
        data: {
          cursor: null,
          lastLedger: targetLedger,
        },
      }),
    ]);
  }

  /**
   * Persists an indexed event into the immutable ContractEvent audit table.
   * Returns true if event is unique and was inserted; false if already processed.
   */
  public async recordEventIdempotent(event: ParsedEvent): Promise<boolean> {
    try {
      await prisma.contractEvent.create({
        data: {
          eventId: event.id,
          contractId: event.contractId,
          topic: event.topicPrimary,
          subTopic: event.topicSecondary,
          dataJson: JSON.stringify(event.data, (_, v) =>
            typeof v === 'bigint' ? v.toString() : v
          ),
          ledger: event.ledger,
          txHash: event.txHash,
          ledgerClosedAt: event.ledgerClosedAt,
        },
      });
      return true; // Newly recorded
    } catch (err: any) {
      // Prisma P2002 code indicates unique constraint violation (already indexed)
      if (err.code === 'P2002') {
        return false; // Idempotently skipped
      }
      throw err;
    }
  }
}

export const cursorManager = new IndexerCursorManager();
