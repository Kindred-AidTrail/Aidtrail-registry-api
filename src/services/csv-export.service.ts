import { stringify } from 'csv-stringify';
import { Readable } from 'node:stream';
import { prisma } from '../db/prisma.js';

export class CsvExportService {
  /**
   * Generates a streaming CSV report of all voucher disbursements and redemptions
   */
  public async generateDisbursementsCsv(): Promise<Readable> {
    const vouchers = await prisma.voucher.findMany({
      include: {
        program: {
          select: {
            title: true,
            onChainId: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const rows = vouchers.map((v) => {
      let status = 'ISSUED';
      if (v.isRedeemed) status = 'REDEEMED';
      else if (v.isReclaimed) status = 'RECLAIMED';
      else if (v.isExpired || new Date() > v.expiresAt) status = 'EXPIRED';

      return [
        v.onChainVoucherId.toString(),
        v.program.onChainId.toString(),
        v.program.title,
        v.beneficiaryAnonId, // Pseudonymized - no PII
        v.category,
        v.amount,
        status,
        v.issuedLedger.toString(),
        v.issuedTxHash,
        v.redeemedLedger?.toString() || 'N/A',
        v.redeemedTxHash || 'N/A',
        v.vendorAddress || 'N/A',
        v.expiresAt.toISOString(),
      ];
    });

    const columns = [
      'Voucher_ID',
      'Program_ID',
      'Program_Title',
      'Beneficiary_Pseudonym',
      'Category',
      'Amount_Stroops',
      'Status',
      'Issued_Ledger',
      'Issued_Tx_Hash',
      'Redeemed_Ledger',
      'Redeemed_Tx_Hash',
      'Vendor_Address',
      'Expires_At',
    ];

    const stringifier = stringify({ header: true, columns });
    const stream = Readable.from(rows).pipe(stringifier);
    return stream;
  }

  /**
   * Generates a streaming CSV report of all program milestones and verifier evidence
   */
  public async generateMilestonesCsv(): Promise<Readable> {
    const milestones = await prisma.milestone.findMany({
      include: {
        program: {
          select: {
            onChainId: true,
            title: true,
            creatorAddress: true,
          },
        },
        approvals: true,
      },
      orderBy: [{ program: { onChainId: 'asc' } }, { onChainIndex: 'asc' }],
    });

    const rows = milestones.map((m) => [
      m.program.onChainId.toString(),
      m.program.title,
      m.onChainIndex.toString(),
      m.title,
      m.targetAmount,
      m.isApproved ? 'YES' : 'NO',
      m.isReleased ? 'YES' : 'NO',
      m.evidenceUri || 'N/A',
      m.approvals.length.toString(),
      m.approvedLedger?.toString() || 'N/A',
      m.releasedLedger?.toString() || 'N/A',
      m.approvals.map((a) => a.verifierAddress).join('; ') || 'NONE',
    ]);

    const columns = [
      'Program_ID',
      'Program_Title',
      'Milestone_Index',
      'Milestone_Title',
      'Target_Amount_Stroops',
      'Is_Approved',
      'Is_Released',
      'Evidence_URI',
      'Approvals_Count',
      'Approved_Ledger',
      'Released_Ledger',
      'Verifier_Signers',
    ];

    const stringifier = stringify({ header: true, columns });
    const stream = Readable.from(rows).pipe(stringifier);
    return stream;
  }
}

export const csvExportService = new CsvExportService();
