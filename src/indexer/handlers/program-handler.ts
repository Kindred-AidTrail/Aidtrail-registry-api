import { prisma } from '../../db/prisma.js';
import { ParsedEvent } from '../event-parser.js';
import { VendorCategory } from '@prisma/client';

export class ProgramEventHandler {
  /**
   * Handles ("program", "created") event
   */
  public async handleProgramCreated(event: ParsedEvent): Promise<void> {
    const { programId, ngoAddress, tokenAddress, metadataUri } = event.data;

    // Fetch existing or initialize program
    const existing = await prisma.program.findUnique({
      where: { onChainId: programId },
    });

    if (!existing) {
      await prisma.program.create({
        data: {
          onChainId: programId,
          creatorAddress: ngoAddress,
          tokenContractId: tokenAddress,
          title: `Aid Program #${programId.toString()}`,
          description: `Disbursement program initialized at ledger ${event.ledger}. Metadata URI: ${metadataUri}`,
          category: VendorCategory.FOOD,
          targetAmount: '0',
          totalFunded: '0',
          totalReleased: '0',
          totalAllocated: '0',
          totalRedeemed: '0',
          totalReclaimed: '0',
          createdAtLedger: event.ledger,
          createdAtTxHash: event.txHash,
          createdAt: event.ledgerClosedAt,
        },
      });
    }
  }

  /**
   * Handles ("program", "funded") event
   */
  public async handleProgramFunded(event: ParsedEvent): Promise<void> {
    const { programId, donorAddress, amount } = event.data;
    const amountStr = amount.toString();

    const program = await prisma.program.findUnique({
      where: { onChainId: programId },
    });

    if (program) {
      const currentFunded = BigInt(program.totalFunded);
      const newFunded = (currentFunded + amount).toString();

      await prisma.$transaction([
        prisma.program.update({
          where: { onChainId: programId },
          data: { totalFunded: newFunded },
        }),
        prisma.donorContribution.create({
          data: {
            programId: program.id,
            donorAddress,
            amount: amountStr,
            txHash: event.txHash,
            ledger: event.ledger,
            createdAt: event.ledgerClosedAt,
          },
        }),
      ]);
    }
  }

  /**
   * Handles ("program", "cancel") event
   */
  public async handleProgramCancelled(event: ParsedEvent): Promise<void> {
    const { programId } = event.data;
    await prisma.program.updateMany({
      where: { onChainId: programId },
      data: { isCancelled: true },
    });
  }

  /**
   * Handles ("program", "refund") event
   */
  public async handleDonorRefunded(event: ParsedEvent): Promise<void> {
    const { programId, amount } = event.data;
    const program = await prisma.program.findUnique({
      where: { onChainId: programId },
    });
    if (program) {
      const currentReclaimed = BigInt(program.totalReclaimed);
      const newReclaimed = (currentReclaimed + amount).toString();
      await prisma.program.update({
        where: { onChainId: programId },
        data: { totalReclaimed: newReclaimed },
      });
    }
  }

  /**
   * Handles ("milestn", "added") event
   */
  public async handleMilestoneAdded(event: ParsedEvent): Promise<void> {
    const { programId, milestoneIndex, amount, requiredApprovals } = event.data;
    const program = await prisma.program.findUnique({
      where: { onChainId: programId },
    });

    if (program) {
      await prisma.milestone.upsert({
        where: {
          programId_onChainIndex: {
            programId: program.id,
            onChainIndex: milestoneIndex,
          },
        },
        update: {
          targetAmount: amount.toString(),
        },
        create: {
          programId: program.id,
          onChainIndex: milestoneIndex,
          title: `Milestone #${milestoneIndex + 1}`,
          targetAmount: amount.toString(),
          isApproved: false,
          isReleased: false,
          createdAt: event.ledgerClosedAt,
        },
      });

      await prisma.program.update({
        where: { id: program.id },
        data: { requiredApprovals },
      });
    }
  }

  /**
   * Handles ("milestn", "ver_upd") event
   */
  public async handleMilestoneVerifiersUpdated(event: ParsedEvent): Promise<void> {
    const { programId, requiredApprovals } = event.data;
    const program = await prisma.program.findUnique({
      where: { onChainId: programId },
    });

    if (program) {
      await prisma.program.update({
        where: { id: program.id },
        data: { requiredApprovals },
      });
    }
  }

  /**
   * Handles ("milestn", "apprvd") event
   */
  public async handleMilestoneApproved(event: ParsedEvent): Promise<void> {
    const { programId, milestoneIndex, verifierAddress, approvalsCount } = event.data;
    const program = await prisma.program.findUnique({
      where: { onChainId: programId },
    });

    if (program) {
      const milestone = await prisma.milestone.findUnique({
        where: {
          programId_onChainIndex: {
            programId: program.id,
            onChainIndex: milestoneIndex,
          },
        },
      });

      if (milestone) {
        await prisma.milestoneApproval.upsert({
          where: {
            milestoneId_verifierAddress: {
              milestoneId: milestone.id,
              verifierAddress,
            },
          },
          update: {
            txHash: event.txHash,
            ledger: event.ledger,
          },
          create: {
            milestoneId: milestone.id,
            verifierAddress,
            txHash: event.txHash,
            ledger: event.ledger,
            createdAt: event.ledgerClosedAt,
          },
        });

        // Check if consensus threshold reached
        if (approvalsCount >= program.requiredApprovals) {
          await prisma.milestone.update({
            where: { id: milestone.id },
            data: {
              isApproved: true,
              approvedLedger: event.ledger,
            },
          });
        }
      }
    }
  }

  /**
   * Handles ("milestn", "release") event
   */
  public async handleMilestoneReleased(event: ParsedEvent): Promise<void> {
    const { programId, milestoneIndex, amount } = event.data;
    const program = await prisma.program.findUnique({
      where: { onChainId: programId },
    });

    if (program) {
      const currentReleased = BigInt(program.totalReleased);
      const newReleased = (currentReleased + amount).toString();

      await prisma.$transaction([
        prisma.milestone.update({
          where: {
            programId_onChainIndex: {
              programId: program.id,
              onChainIndex: milestoneIndex,
            },
          },
          data: {
            isReleased: true,
            releasedLedger: event.ledger,
          },
        }),
        prisma.program.update({
          where: { id: program.id },
          data: { totalReleased: newReleased },
        }),
      ]);
    }
  }

  /**
   * Handles ("contract", "paused") event
   */
  public async handleContractPaused(event: ParsedEvent): Promise<void> {
    const { paused } = event.data;
    await prisma.program.updateMany({
      data: { isPaused: paused },
    });
  }
}

export const programEventHandler = new ProgramEventHandler();
