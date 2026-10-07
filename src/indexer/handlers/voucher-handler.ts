import { prisma } from '../../db/prisma.js';
import { ParsedEvent } from '../event-parser.js';
import { cryptoService } from '../../services/crypto.service.js';
import { VendorCategory, VendorStatus } from '@prisma/client';

export class VoucherEventHandler {
  /**
   * Handles ("vendor", "reg") event
   */
  public async handleVendorRegistered(event: ParsedEvent): Promise<void> {
    const { vendorAddress, allowedCategories } = event.data;
    const primaryCategory = (allowedCategories[0] || 'FOOD') as VendorCategory;

    await prisma.vendor.upsert({
      where: { stellarAddress: vendorAddress },
      update: {
        category: primaryCategory,
        status: VendorStatus.APPROVED,
        onChainRegistered: true,
        registeredTxHash: event.txHash,
        registeredAt: event.ledgerClosedAt,
      },
      create: {
        stellarAddress: vendorAddress,
        businessName: `Vendor ${vendorAddress.slice(0, 8)}`,
        category: primaryCategory,
        status: VendorStatus.APPROVED,
        onChainRegistered: true,
        registeredTxHash: event.txHash,
        registeredAt: event.ledgerClosedAt,
      },
    });
  }

  /**
   * Handles ("vendor", "rem") event
   */
  public async handleVendorRemoved(event: ParsedEvent): Promise<void> {
    const { vendorAddress } = event.data;
    await prisma.vendor.updateMany({
      where: { stellarAddress: vendorAddress },
      data: {
        status: VendorStatus.REMOVED,
        onChainRegistered: false,
      },
    });
  }

  /**
   * Handles ("voucher", "issued") event
   */
  public async handleVoucherIssued(event: ParsedEvent): Promise<void> {
    const {
      voucherId,
      programId,
      beneficiaryAddress,
      amount,
      category,
      expiresAtSeconds,
    } = event.data;

    const program = await prisma.program.findUnique({
      where: { onChainId: programId },
    });

    if (program) {
      const anonId = cryptoService.pseudonymize(beneficiaryAddress);
      const expiresAt = new Date(expiresAtSeconds * 1000);
      const currentAllocated = BigInt(program.totalAllocated);
      const newAllocated = (currentAllocated + amount).toString();

      await prisma.$transaction([
        prisma.voucher.upsert({
          where: { onChainVoucherId: voucherId },
          update: {
            amount: amount.toString(),
            category: category as VendorCategory,
            expiresAt,
          },
          create: {
            onChainVoucherId: voucherId,
            programId: program.id,
            beneficiaryAddress,
            beneficiaryAnonId: anonId,
            category: category as VendorCategory,
            amount: amount.toString(),
            isRedeemed: false,
            isExpired: false,
            isReclaimed: false,
            expiresAt,
            issuedLedger: event.ledger,
            issuedTxHash: event.txHash,
            createdAt: event.ledgerClosedAt,
          },
        }),
        prisma.program.update({
          where: { id: program.id },
          data: { totalAllocated: newAllocated },
        }),
      ]);
    }
  }

  /**
   * Handles ("voucher", "redeem") event
   */
  public async handleVoucherRedeemed(event: ParsedEvent): Promise<void> {
    const { voucherId, beneficiaryAddress, vendorAddress, amount } = event.data;

    const voucher = await prisma.voucher.findUnique({
      where: { onChainVoucherId: voucherId },
      include: { program: true },
    });

    if (voucher) {
      const currentRedeemed = BigInt(voucher.program.totalRedeemed);
      const newRedeemed = (currentRedeemed + amount).toString();

      await prisma.$transaction([
        prisma.voucher.update({
          where: { onChainVoucherId: voucherId },
          data: {
            isRedeemed: true,
            vendorAddress,
            redeemedLedger: event.ledger,
            redeemedTxHash: event.txHash,
          },
        }),
        prisma.vendorPayout.create({
          data: {
            programId: voucher.programId,
            vendorAddress,
            voucherId,
            amount: amount.toString(),
            txHash: event.txHash,
            ledger: event.ledger,
            createdAt: event.ledgerClosedAt,
          },
        }),
        prisma.program.update({
          where: { id: voucher.programId },
          data: { totalRedeemed: newRedeemed },
        }),
      ]);
    }
  }

  /**
   * Handles ("voucher", "reclaim") event
   */
  public async handleVoucherReclaimed(event: ParsedEvent): Promise<void> {
    const { voucherId, programId, amount } = event.data;

    const voucher = await prisma.voucher.findUnique({
      where: { onChainVoucherId: voucherId },
      include: { program: true },
    });

    if (voucher) {
      const currentReclaimed = BigInt(voucher.program.totalReclaimed);
      const newReclaimed = (currentReclaimed + amount).toString();

      await prisma.$transaction([
        prisma.voucher.update({
          where: { onChainVoucherId: voucherId },
          data: {
            isReclaimed: true,
            reclaimedLedger: event.ledger,
            reclaimedTxHash: event.txHash,
          },
        }),
        prisma.program.update({
          where: { id: voucher.programId },
          data: { totalReclaimed: newReclaimed },
        }),
      ]);
    }
  }
}

export const voucherEventHandler = new VoucherEventHandler();
