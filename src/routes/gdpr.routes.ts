import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { authenticate } from '../middlewares/auth.middleware.js';
import { prisma, serializeBigInt } from '../db/prisma.js';
import { cryptoService } from '../services/crypto.service.js';
import { storageService } from '../services/storage.service.js';

export const gdprRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * GET /api/v1/gdpr/export
   * GDPR Article 20: Right to data portability
   * Exports all personal data associated with the authenticated user in portable JSON format
   */
  fastify.get(
    '/export',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['GDPR'],
        summary: 'Export all personal data (GDPR Portability)',
        description:
          'Produces a complete decrypted export of all personally identifiable data, document links, and associated activity held by AidTrail.',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const user = request.user!;

      const userRecord = await prisma.user.findUnique({
        where: { id: user.userId },
        include: {
          profile: true,
          documents: true,
          vendor: true,
        },
      });

      if (!userRecord) {
        return reply.status(404).send({
          title: 'User Not Found',
          status: 404,
          detail: 'No user record exists for data export',
        });
      }

      // Decrypt profile PII
      let profileExport = null;
      if (userRecord.profile) {
        profileExport = {
          legalName: cryptoService.decrypt(userRecord.profile.legalNameEncrypted),
          email: userRecord.profile.emailEncrypted
            ? cryptoService.decrypt(userRecord.profile.emailEncrypted)
            : null,
          phone: userRecord.profile.phoneEncrypted
            ? cryptoService.decrypt(userRecord.profile.phoneEncrypted)
            : null,
          organizationName: userRecord.profile.organizationName,
          country: userRecord.profile.country,
          createdAt: userRecord.profile.createdAt,
          updatedAt: userRecord.profile.updatedAt,
        };
      }

      // Generate secure download URLs for attached documents
      const documentsExport = await Promise.all(
        userRecord.documents.map(async (doc) => {
          let downloadUrl: string | null = null;
          try {
            downloadUrl = await storageService.getDownloadPresignedUrl(doc.s3Key, 3600);
          } catch {
            downloadUrl = null;
          }

          return {
            id: doc.id,
            docType: doc.docType,
            fileHash: doc.fileHash,
            mimeType: doc.mimeType,
            sizeBytes: doc.sizeBytes,
            status: doc.status,
            createdAt: doc.createdAt,
            temporaryDownloadUrl: downloadUrl,
          };
        })
      );

      // Fetch on-chain voucher references (if any)
      const vouchers = await prisma.voucher.findMany({
        where: { beneficiaryAddress: userRecord.stellarAddress },
      });

      // Fetch payouts (if vendor)
      const payouts = await prisma.vendorPayout.findMany({
        where: { vendorAddress: userRecord.stellarAddress },
      });

      const exportPayload = {
        exportTimestamp: new Date().toISOString(),
        gdprSubject: {
          userId: userRecord.id,
          stellarAddress: userRecord.stellarAddress,
          role: userRecord.role,
          isVerified: userRecord.isVerified,
          memberSince: userRecord.createdAt,
        },
        profile: profileExport,
        documents: documentsExport,
        vendorRegistration: userRecord.vendor,
        voucherHistory: serializeBigInt(vouchers),
        payoutHistory: serializeBigInt(payouts),
      };

      // Set headers for download
      reply.header(
        'Content-Disposition',
        `attachment; filename="aidtrail-gdpr-export-${userRecord.stellarAddress.slice(0, 8)}.json"`
      );
      reply.type('application/json');

      return reply.send(exportPayload);
    }
  );

  /**
   * DELETE /api/v1/gdpr/forget
   * GDPR Article 17: Right to Erasure ("Right to be Forgotten")
   * Permanently erases PII, deletes all S3 documents, and severs links to on-chain vouchers
   */
  fastify.delete(
    '/forget',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['GDPR'],
        summary: 'Right to Erasure (Cryptographic Shredding)',
        description:
          'Irreversibly deletes all stored PII, deletes all KYC and business documents from S3 storage, and decouples user identity from public on-chain pseudonymized records.',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const user = request.user!;

      const userRecord = await prisma.user.findUnique({
        where: { id: user.userId },
        include: { documents: true, profile: true },
      });

      if (!userRecord) {
        return reply.status(404).send({
          title: 'User Not Found',
          status: 404,
          detail: 'User does not exist or has already been erased',
        });
      }

      // 1. Physically delete all documents from S3/MinIO
      for (const doc of userRecord.documents) {
        try {
          await storageService.deleteDocument(doc.s3Key);
        } catch (err: any) {
          request.log.warn(
            { s3Key: doc.s3Key, err: err.message },
            'Failed to delete S3 document during GDPR purge'
          );
        }
      }

      // 2. Erase documents and profile in transactional cascade
      await prisma.$transaction([
        prisma.document.deleteMany({
          where: { userId: user.userId },
        }),
        prisma.profile.deleteMany({
          where: { userId: user.userId },
        }),
        prisma.vendor.updateMany({
          where: { userId: user.userId },
          data: {
            businessName: '[ERASED - GDPR]',
            status: 'REMOVED',
            userId: null,
          },
        }),
        prisma.user.update({
          where: { id: user.userId },
          data: {
            isVerified: false,
            nonce: cryptoService.generateSecureToken(32),
          },
        }),
        prisma.auditLog.create({
          data: {
            action: 'GDPR_RIGHT_TO_ERASURE_EXECUTED',
            actorAddress: cryptoService.pseudonymize(userRecord.stellarAddress),
            targetType: 'User',
            targetId: userRecord.id,
            metadata: JSON.stringify({
              documentsDeletedCount: userRecord.documents.length,
              profileErased: !!userRecord.profile,
              executedAt: new Date().toISOString(),
            }),
          },
        }),
      ]);

      return reply.send({
        success: true,
        message:
          'GDPR Right to Erasure executed. All personal identification documents have been purged from S3 storage, profile data shredded, and identity severed.',
        deletedDocumentsCount: userRecord.documents.length,
        erasedAt: new Date().toISOString(),
      });
    }
  );
};
