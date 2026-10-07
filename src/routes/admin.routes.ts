import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middlewares/auth.middleware.js';
import { UserRole } from '../types/auth.js';
import { prisma, serializeBigInt } from '../db/prisma.js';
import { contractService } from '../services/contract.service.js';
import { storageService } from '../services/storage.service.js';
import { VendorStatus, DocumentStatus } from '@prisma/client';

const vendorIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const adminRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * GET /api/v1/admin/vendors/pending
   * Lists all vendors awaiting administrative / NGO verification
   */
  fastify.get(
    '/vendors/pending',
    {
      preHandler: [authenticate, requireRole([UserRole.ADMIN, UserRole.NGO])],
      schema: {
        tags: ['Admin'],
        summary: 'List pending vendor verification applications',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const pendingVendors = await prisma.vendor.findMany({
        where: { status: VendorStatus.PENDING },
        include: {
          user: {
            include: {
              documents: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      const responseData = await Promise.all(
        pendingVendors.map(async (v) => {
          const docsWithUrls = await Promise.all(
            (v.user?.documents || []).map(async (d) => {
              let downloadUrl = null;
              try {
                downloadUrl = await storageService.getDownloadPresignedUrl(d.s3Key, 1800);
              } catch {}
              return {
                id: d.id,
                docType: d.docType,
                fileHash: d.fileHash,
                mimeType: d.mimeType,
                status: d.status,
                downloadUrl,
              };
            })
          );

          return {
            id: v.id,
            stellarAddress: v.stellarAddress,
            businessName: v.businessName,
            category: v.category,
            status: v.status,
            createdAt: v.createdAt,
            documents: docsWithUrls,
          };
        })
      );

      return reply.send({
        total: responseData.length,
        vendors: responseData,
      });
    }
  );

  /**
   * POST /api/v1/admin/vendors/:id/approve
   * Approves vendor and dispatches on-chain register_vendor contract transaction
   */
  fastify.post(
    '/vendors/:id/approve',
    {
      preHandler: [authenticate, requireRole([UserRole.ADMIN, UserRole.NGO])],
      schema: {
        tags: ['Admin'],
        summary: 'Approve vendor and invoke on-chain register_vendor',
        description:
          'Validates vendor credentials and dispatches a signed Soroban contract transaction to register the vendor on-chain.',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const parsedParams = vendorIdParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.status(400).send({
          title: 'Validation Error',
          status: 400,
          detail: 'Invalid vendor UUID format',
        });
      }

      const { id } = parsedParams.data;
      const vendor = await prisma.vendor.findUnique({
        where: { id },
        include: { user: { include: { documents: true } } },
      });

      if (!vendor) {
        return reply.status(404).send({
          title: 'Vendor Not Found',
          status: 404,
          detail: `Vendor with ID ${id} does not exist`,
        });
      }

      if (vendor.onChainRegistered && vendor.status === VendorStatus.APPROVED) {
        return reply.status(409).send({
          title: 'Already Approved',
          status: 409,
          detail: 'Vendor is already approved and registered on-chain',
        });
      }

      // Dispatch register_vendor transaction to Soroban contract
      request.log.info(
        { vendorAddress: vendor.stellarAddress, category: vendor.category },
        'Dispatching on-chain register_vendor transaction'
      );

      const dispatchResult = await contractService.registerVendorOnChain(
        vendor.stellarAddress,
        vendor.category
      );

      if (!dispatchResult.success) {
        return reply.status(502).send({
          title: 'On-Chain Execution Failed',
          status: 502,
          detail: dispatchResult.error || 'Failed to execute register_vendor on Soroban contract',
        });
      }

      // Update vendor and related records in atomic transaction
      const updatedVendor = await prisma.$transaction(async (tx) => {
        const updated = await tx.vendor.update({
          where: { id },
          data: {
            status: VendorStatus.APPROVED,
            onChainRegistered: true,
            registeredTxHash: dispatchResult.txHash,
            registeredAt: new Date(),
          },
        });

        if (vendor.userId) {
          await tx.user.update({
            where: { id: vendor.userId },
            data: { isVerified: true },
          });

          await tx.document.updateMany({
            where: { userId: vendor.userId },
            data: { status: DocumentStatus.VERIFIED },
          });
        }

        await tx.auditLog.create({
          data: {
            action: 'VENDOR_APPROVED_ON_CHAIN',
            actorAddress: request.user!.stellarAddress,
            actorId: request.user!.userId,
            targetType: 'Vendor',
            targetId: vendor.id,
            metadata: JSON.stringify({
              vendorAddress: vendor.stellarAddress,
              category: vendor.category,
              txHash: dispatchResult.txHash,
              ledger: dispatchResult.ledger,
            }),
          },
        });

        return updated;
      });

      return reply.send({
        success: true,
        message: 'Vendor successfully approved and registered on-chain in AidTrail contract.',
        vendor: {
          id: updatedVendor.id,
          stellarAddress: updatedVendor.stellarAddress,
          businessName: updatedVendor.businessName,
          category: updatedVendor.category,
          status: updatedVendor.status,
          onChainRegistered: updatedVendor.onChainRegistered,
          registeredTxHash: updatedVendor.registeredTxHash,
          registeredAt: updatedVendor.registeredAt,
          stellarExpertUrl: `https://stellar.expert/explorer/testnet/tx/${dispatchResult.txHash}`,
        },
      });
    }
  );

  /**
   * POST /api/v1/admin/vendors/:id/reject
   * Rejects vendor onboarding application
   */
  fastify.post(
    '/vendors/:id/reject',
    {
      preHandler: [authenticate, requireRole([UserRole.ADMIN, UserRole.NGO])],
      schema: {
        tags: ['Admin'],
        summary: 'Reject vendor onboarding application',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const parsedParams = vendorIdParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.status(400).send({
          title: 'Validation Error',
          status: 400,
          detail: 'Invalid vendor UUID format',
        });
      }

      const { id } = parsedParams.data;
      const vendor = await prisma.vendor.findUnique({ where: { id } });

      if (!vendor) {
        return reply.status(404).send({
          title: 'Vendor Not Found',
          status: 404,
          detail: `Vendor with ID ${id} does not exist`,
        });
      }

      await prisma.$transaction(async (tx) => {
        await tx.vendor.update({
          where: { id },
          data: { status: VendorStatus.REJECTED },
        });

        if (vendor.userId) {
          await tx.document.updateMany({
            where: { userId: vendor.userId },
            data: { status: DocumentStatus.REJECTED },
          });
        }

        await tx.auditLog.create({
          data: {
            action: 'VENDOR_APPLICATION_REJECTED',
            actorAddress: request.user!.stellarAddress,
            actorId: request.user!.userId,
            targetType: 'Vendor',
            targetId: vendor.id,
            metadata: JSON.stringify({
              vendorAddress: vendor.stellarAddress,
              businessName: vendor.businessName,
            }),
          },
        });
      });

      return reply.send({
        success: true,
        message: 'Vendor application marked as rejected.',
      });
    }
  );

  /**
   * GET /api/v1/admin/audit-logs
   * Returns system audit trail log
   */
  fastify.get(
    '/audit-logs',
    {
      preHandler: [authenticate, requireRole([UserRole.ADMIN])],
      schema: {
        tags: ['Admin'],
        summary: 'Inspect system administrative audit logs',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const logs = await prisma.auditLog.findMany({
        take: 100,
        orderBy: { createdAt: 'desc' },
      });

      return reply.send({
        total: logs.length,
        logs,
      });
    }
  );
};
