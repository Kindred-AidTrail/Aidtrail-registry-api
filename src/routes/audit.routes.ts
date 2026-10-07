import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma, serializeBigInt } from '../db/prisma.js';

const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  category: z.string().optional(),
});

export const auditRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * GET /api/v1/audit/programs
   * Public list of all aid disbursement programs with on-chain accounting totals
   */
  fastify.get(
    '/programs',
    {
      schema: {
        tags: ['Audit'],
        summary: 'List aid programs with financial audit metrics',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', default: 1 },
            limit: { type: 'integer', default: 20 },
            category: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { page, limit, category } = paginationQuerySchema.parse(request.query);
      const skip = (page - 1) * limit;

      const where: any = {};
      if (category) {
        where.category = category.toUpperCase();
      }

      const [total, programs] = await Promise.all([
        prisma.program.count({ where }),
        prisma.program.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            _count: {
              select: {
                milestones: true,
                vouchers: true,
                contributions: true,
                payouts: true,
              },
            },
          },
        }),
      ]);

      return reply.send({
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        programs: serializeBigInt(programs),
      });
    }
  );

  /**
   * GET /api/v1/audit/programs/:id
   * Complete transparent audit view of a specific program including milestones and evidence
   */
  fastify.get(
    '/programs/:id',
    {
      schema: {
        tags: ['Audit'],
        summary: 'Get transparent program breakdown with milestone evidence',
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', description: 'Program UUID or on-chain numeric ID' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      // Query by either UUID or BigInt onChainId
      const isNumeric = /^\d+$/.test(id);
      const program = await prisma.program.findFirst({
        where: isNumeric ? { onChainId: BigInt(id) } : { id },
        include: {
          milestones: {
            orderBy: { onChainIndex: 'asc' },
            include: {
              approvals: {
                orderBy: { createdAt: 'asc' },
              },
            },
          },
          _count: {
            select: {
              vouchers: true,
              contributions: true,
              payouts: true,
            },
          },
        },
      });

      if (!program) {
        return reply.status(404).send({
          title: 'Program Not Found',
          status: 404,
          detail: `Aid program '${id}' was not found`,
        });
      }

      // Compute accounting integrity invariants
      const funded = BigInt(program.totalFunded);
      const released = BigInt(program.totalReleased);
      const allocated = BigInt(program.totalAllocated);
      const redeemed = BigInt(program.totalRedeemed);
      const reclaimed = BigInt(program.totalReclaimed);

      const isSolvent = funded >= released && released >= allocated && allocated >= (redeemed + reclaimed);

      return reply.send({
        program: serializeBigInt(program),
        accountingAudit: {
          isSolvent,
          fundedStroops: funded.toString(),
          releasedStroops: released.toString(),
          allocatedStroops: allocated.toString(),
          redeemedStroops: redeemed.toString(),
          reclaimedStroops: reclaimed.toString(),
          availableLiquidity: (funded - released).toString(),
          unspentAllocated: (allocated - redeemed - reclaimed).toString(),
        },
      });
    }
  );

  /**
   * GET /api/v1/audit/donors/totals
   * Public donor leaderboard and aggregate humanitarian capital flows
   */
  fastify.get(
    '/donors/totals',
    {
      schema: {
        tags: ['Audit'],
        summary: 'Public aggregate donor contribution totals',
      },
    },
    async (_request, reply) => {
      const contributions = await prisma.donorContribution.findMany({
        select: {
          donorAddress: true,
          amount: true,
          programId: true,
        },
      });

      // Aggregate totals per donor
      const donorMap = new Map<string, { totalAmount: bigint; contributionCount: number }>();
      let aggregateCapital = BigInt(0);

      for (const c of contributions) {
        const amt = BigInt(c.amount);
        aggregateCapital += amt;

        const current = donorMap.get(c.donorAddress) || {
          totalAmount: BigInt(0),
          contributionCount: 0,
        };
        current.totalAmount += amt;
        current.contributionCount += 1;
        donorMap.set(c.donorAddress, current);
      }

      const leaderboard = Array.from(donorMap.entries())
        .map(([donorAddress, data]) => ({
          donorAddress,
          totalAmountStroops: data.totalAmount.toString(),
          contributionCount: data.contributionCount,
        }))
        .sort((a, b) => (BigInt(b.totalAmountStroops) > BigInt(a.totalAmountStroops) ? 1 : -1))
        .slice(0, 50);

      return reply.send({
        totalUniqueDonors: donorMap.size,
        totalContributionsCount: contributions.length,
        aggregateCapitalStroops: aggregateCapital.toString(),
        topDonors: leaderboard,
      });
    }
  );

  /**
   * GET /api/v1/audit/milestones
   * Audit feed of milestone evidence and verifier attestations
   */
  fastify.get(
    '/milestones',
    {
      schema: {
        tags: ['Audit'],
        summary: 'Milestone verification audit feed',
        querystring: {
          type: 'object',
          properties: {
            isApproved: { type: 'boolean' },
            isReleased: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { isApproved, isReleased } = request.query as any;
      const where: any = {};
      if (typeof isApproved === 'boolean' || isApproved === 'true' || isApproved === 'false') {
        where.isApproved = isApproved === true || isApproved === 'true';
      }
      if (typeof isReleased === 'boolean' || isReleased === 'true' || isReleased === 'false') {
        where.isReleased = isReleased === true || isReleased === 'true';
      }

      const milestones = await prisma.milestone.findMany({
        where,
        take: 50,
        orderBy: { updatedAt: 'desc' },
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
      });

      return reply.send({
        total: milestones.length,
        milestones: serializeBigInt(milestones),
      });
    }
  );

  /**
   * GET /api/v1/audit/vouchers
   * Pseudonymous public audit feed of vouchers (real addresses masked)
   */
  fastify.get(
    '/vouchers',
    {
      schema: {
        tags: ['Audit'],
        summary: 'Public pseudonymous voucher transparency audit feed',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', default: 1 },
            limit: { type: 'integer', default: 20 },
            programId: { type: 'string' },
            category: { type: 'string' },
            isRedeemed: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { page, limit, category } = paginationQuerySchema.parse(request.query);
      const { programId, isRedeemed } = request.query as any;
      const skip = (page - 1) * limit;

      const where: any = {};
      if (category) where.category = category.toUpperCase();
      if (programId) {
        where.program = /^\d+$/.test(programId)
          ? { onChainId: BigInt(programId) }
          : { id: programId };
      }
      if (typeof isRedeemed === 'boolean' || isRedeemed === 'true' || isRedeemed === 'false') {
        where.isRedeemed = isRedeemed === true || isRedeemed === 'true';
      }

      const [total, vouchers] = await Promise.all([
        prisma.voucher.count({ where }),
        prisma.voucher.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          select: {
            onChainVoucherId: true,
            programId: true,
            beneficiaryAnonId: true, // ONLY pseudonymous identifier exposed
            category: true,
            amount: true,
            isRedeemed: true,
            isExpired: true,
            isReclaimed: true,
            expiresAt: true,
            issuedLedger: true,
            issuedTxHash: true,
            redeemedLedger: true,
            redeemedTxHash: true,
            createdAt: true,
            program: {
              select: {
                onChainId: true,
                title: true,
              },
            },
          },
        }),
      ]);

      return reply.send({
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        vouchers: serializeBigInt(vouchers),
      });
    }
  );

  /**
   * GET /api/v1/audit/vendors/payouts
   * Public list of on-chain payouts disbursed directly to verified vendors
   */
  fastify.get(
    '/vendors/payouts',
    {
      schema: {
        tags: ['Audit'],
        summary: 'Public on-chain vendor payout disbursement history',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', default: 1 },
            limit: { type: 'integer', default: 20 },
            vendorAddress: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { page, limit } = paginationQuerySchema.parse(request.query);
      const { vendorAddress } = request.query as any;
      const skip = (page - 1) * limit;

      const where: any = {};
      if (vendorAddress) where.vendorAddress = vendorAddress;

      const [total, payouts] = await Promise.all([
        prisma.vendorPayout.count({ where }),
        prisma.vendorPayout.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            program: {
              select: {
                onChainId: true,
                title: true,
              },
            },
          },
        }),
      ]);

      const formatted = payouts.map((p) => ({
        ...p,
        stellarExpertTxUrl: `https://stellar.expert/explorer/testnet/tx/${p.txHash}`,
      }));

      return reply.send({
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        payouts: serializeBigInt(formatted),
      });
    }
  );

  /**
   * GET /api/v1/audit/summary
   * High-level platform transparency health metrics
   */
  fastify.get(
    '/summary',
    {
      schema: {
        tags: ['Audit'],
        summary: 'Platform-wide humanitarian disbursement metrics',
      },
    },
    async (_request, reply) => {
      const [programsCount, vouchersCount, vendorsCount, contributions] = await Promise.all([
        prisma.program.count(),
        prisma.voucher.count(),
        prisma.vendor.count({ where: { onChainRegistered: true } }),
        prisma.donorContribution.findMany({ select: { amount: true } }),
      ]);

      const totalCapitalFunded = contributions.reduce(
        (acc, c) => acc + BigInt(c.amount),
        BigInt(0)
      );

      return reply.send({
        totalPrograms: programsCount,
        totalVouchersIssued: vouchersCount,
        totalWhitelistedVendors: vendorsCount,
        totalCapitalFundedStroops: totalCapitalFunded.toString(),
        network: 'Stellar Testnet',
        contractId: fastify.initialConfig || 'AidTrail Soroban Contract',
      });
    }
  );
};

