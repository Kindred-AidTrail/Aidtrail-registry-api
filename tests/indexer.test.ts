import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eventParser } from '../src/indexer/event-parser.js';
import { cursorManager } from '../src/indexer/cursor.js';
import { indexerWorker } from '../src/indexer/worker.js';
import { prisma } from '../src/db/prisma.js';
import { Keypair } from '@stellar/stellar-sdk';
import { VendorCategory } from '@prisma/client';

describe('Soroban Event Indexer & Idempotency Tests', () => {
  const ngoKey = Keypair.random();
  const donorKey = Keypair.random();
  const beneficiaryKey = Keypair.random();
  const vendorKey = Keypair.random();
  const testProgramId = BigInt(99001);
  const testVoucherId = BigInt(88001);

  afterAll(async () => {
    // Clean up test data
    await prisma.voucher.deleteMany({ where: { onChainVoucherId: testVoucherId } });
    await prisma.donorContribution.deleteMany({
      where: { donorAddress: donorKey.publicKey() },
    });
    await prisma.milestone.deleteMany({
      where: { program: { onChainId: testProgramId } },
    });
    await prisma.program.deleteMany({ where: { onChainId: testProgramId } });
    await prisma.contractEvent.deleteMany({
      where: {
        eventId: {
          in: ['evt-test-1', 'evt-test-2', 'evt-test-3', 'evt-test-4', 'evt-test-5'],
        },
      },
    });
  });

  it('Event Parser: should parse program:created event properly', () => {
    const raw = {
      id: 'evt-test-1',
      type: 'contract',
      ledger: 1040001,
      ledgerClosedAt: new Date().toISOString(),
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      topic: ['program', 'created'],
      value: [testProgramId, ngoKey.publicKey(), 'CTOKEN', 'ipfs://cid123'],
      txHash: '0x1234567890abcdef',
    };

    const parsed = eventParser.parseRpcEvent(raw as any);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe('program:created');
    expect(parsed!.data.programId).toBe(testProgramId);
    expect(parsed!.data.ngoAddress).toBe(ngoKey.publicKey());
    expect(parsed!.data.metadataUri).toBe('ipfs://cid123');
  });

  it('Cursor Manager: should store event and maintain strict idempotency', async () => {
    const parsedEvent = {
      id: 'evt-test-2',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      ledger: 1040002,
      ledgerClosedAt: new Date(),
      txHash: '0x2222',
      kind: 'program:funded' as const,
      topicPrimary: 'program',
      topicSecondary: 'funded',
      data: {
        programId: testProgramId,
        donorAddress: donorKey.publicKey(),
        amount: BigInt(5000000),
      },
    };

    // First insertion should succeed (true)
    const firstInsert = await cursorManager.recordEventIdempotent(parsedEvent);
    expect(firstInsert).toBe(true);

    // Duplicate insertion with same eventId should be skipped idempotently (false)
    const duplicateInsert = await cursorManager.recordEventIdempotent(parsedEvent);
    expect(duplicateInsert).toBe(false);
  });

  it('Reorg Detection: should identify ledger regression', async () => {
    await cursorManager.advanceCursor('cursor-1', 1050000);
    // RPC reporting 1049980 (lower than 1050000 by 20 ledgers)
    const isReorg = await cursorManager.detectReorg(1049980);
    expect(isReorg).toBe(true);

    // Normal forward progression
    const isNormal = await cursorManager.detectReorg(1050005);
    expect(isNormal).toBe(false);
  });

  it('End-to-End Dispatch: should process program lifecycle events into database', async () => {
    // 1. Dispatch program:created
    await indexerWorker.dispatchEvent({
      id: 'evt-test-3',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      ledger: 1040003,
      ledgerClosedAt: new Date(),
      txHash: '0x3333',
      kind: 'program:created',
      topicPrimary: 'program',
      topicSecondary: 'created',
      data: {
        programId: testProgramId,
        ngoAddress: ngoKey.publicKey(),
        tokenAddress: 'CTOKEN',
        metadataUri: 'ipfs://cid123',
      },
    });

    const program = await prisma.program.findUnique({
      where: { onChainId: testProgramId },
    });
    expect(program).not.toBeNull();
    expect(program!.creatorAddress).toBe(ngoKey.publicKey());

    // 2. Dispatch program:funded
    await indexerWorker.dispatchEvent({
      id: 'evt-test-4',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      ledger: 1040004,
      ledgerClosedAt: new Date(),
      txHash: '0x4444',
      kind: 'program:funded',
      topicPrimary: 'program',
      topicSecondary: 'funded',
      data: {
        programId: testProgramId,
        donorAddress: donorKey.publicKey(),
        amount: BigInt(1000000000),
      },
    });

    const updatedProgram = await prisma.program.findUnique({
      where: { onChainId: testProgramId },
    });
    expect(updatedProgram!.totalFunded).toBe('1000000000');

    // 3. Dispatch voucher:issued
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;
    await indexerWorker.dispatchEvent({
      id: 'evt-test-5',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      ledger: 1040005,
      ledgerClosedAt: new Date(),
      txHash: '0x5555',
      kind: 'voucher:issued',
      topicPrimary: 'voucher',
      topicSecondary: 'issued',
      data: {
        voucherId: testVoucherId,
        programId: testProgramId,
        beneficiaryAddress: beneficiaryKey.publicKey(),
        amount: BigInt(500000000),
        category: 'FOOD',
        expiresAtSeconds: expiresAt,
      },
    });

    const voucher = await prisma.voucher.findUnique({
      where: { onChainVoucherId: testVoucherId },
    });
    expect(voucher).not.toBeNull();
    expect(voucher!.amount).toBe('500000000');
    expect(voucher!.beneficiaryAnonId).toContain('anon_');
  });
});
