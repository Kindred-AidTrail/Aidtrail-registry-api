import crypto from 'node:crypto';
import { Keypair, rpc } from '@stellar/stellar-sdk';
import { env } from '../config/env.js';
import { cursorManager } from '../indexer/cursor.js';
import { prisma } from '../db/prisma.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  switch (command) {
    case 'status': {
      console.log('🔍 Inspecting AidTrail Registry status...');
      const cursorState = await cursorManager.getCursor();
      const eventsCount = await prisma.contractEvent.count();
      const programsCount = await prisma.program.count();
      const vouchersCount = await prisma.voucher.count();
      const usersCount = await prisma.user.count();

      console.log('====================================');
      console.log(`Contract ID:       ${env.CONTRACT_ID}`);
      console.log(`Soroban RPC:       ${env.SOROBAN_RPC_URL}`);
      console.log(`Last Ledger Index: ${cursorState.lastLedger}`);
      console.log(`RPC Cursor:        ${cursorState.cursor || 'none'}`);
      console.log(`Total Events:      ${eventsCount}`);
      console.log(`Programs Indexed:  ${programsCount}`);
      console.log(`Vouchers Recorded: ${vouchersCount}`);
      console.log(`Registered Users:  ${usersCount}`);
      console.log('====================================');
      break;
    }

    case 'reset-cursor': {
      const targetLedger = parseInt(args[1], 10);
      if (isNaN(targetLedger)) {
        console.error('Usage: npm run cli -- reset-cursor <ledgerNumber>');
        process.exit(1);
      }
      console.log(`⚙️ Resetting indexer cursor to ledger ${targetLedger}...`);
      await cursorManager.advanceCursor(null, targetLedger);
      console.log('✅ Cursor successfully reset.');
      break;
    }

    case 'reorg-rollback': {
      const safeLedger = parseInt(args[1], 10);
      if (isNaN(safeLedger)) {
        console.error('Usage: npm run cli -- reorg-rollback <safeLedgerNumber>');
        process.exit(1);
      }
      console.log(`⏪ Rolling back indexer to safe ledger ${safeLedger}...`);
      await cursorManager.rewindCursorForReorg(safeLedger);
      console.log('✅ Reorg rollback completed.');
      break;
    }

    case 'gen-key': {
      console.log('🔑 Generating cryptographic credentials:');
      const aesKey = crypto.randomBytes(32).toString('hex');
      const kp = Keypair.random();
      console.log('------------------------------------');
      console.log(`PII_ENCRYPTION_KEY: ${aesKey}`);
      console.log(`STELLAR_PUBLIC_KEY: ${kp.publicKey()}`);
      console.log(`STELLAR_SECRET_KEY: ${kp.secret()}`);
      console.log('------------------------------------');
      break;
    }

    case 'test-rpc': {
      console.log(`🌐 Testing connection to Soroban RPC: ${env.SOROBAN_RPC_URL}...`);
      try {
        const server = new rpc.Server(env.SOROBAN_RPC_URL, {
          allowHttp: env.NODE_ENV !== 'production',
        });
        const latestLedger = await server.getLatestLedger();
        console.log(`✅ Soroban RPC is reachable!`);
        console.log(`Latest Ledger: ${latestLedger.sequence} (Protocol ${latestLedger.protocolVersion})`);
      } catch (err: any) {
        console.error(`❌ RPC connection failed: ${err.message}`);
      }
      break;
    }

    default: {
      console.log(`
AidTrail Registry Management CLI

Available commands:
  status                Inspect indexer cursor checkpoint and database metrics
  reset-cursor <ledger> Manually reposition indexer cursor
  reorg-rollback <ledg> Rollback unfinalized events to safe ledger block
  gen-key               Generate 32-byte AES PII key and Stellar testnet keypair
  test-rpc              Test connection and query latest ledger from Soroban RPC
`);
      break;
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('CLI error:', err);
  process.exit(1);
});
