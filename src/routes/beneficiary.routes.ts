import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middlewares/auth.middleware.js';
import { UserRole } from '../types/auth.js';
import { prisma } from '../db/prisma.js';
import { cryptoService } from '../services/crypto.service.js';
import { storageService } from '../services/storage.service.js';
import { serializeBigInt } from '../db/prisma.js';

const onboardJsonSchema = z.object({
  legalName: z.string().min(2).max(100),
  phone: z.string().min(5).max(30),
  email: z.string().email().optional(),
  country: z.string().length(3).optional(), // ISO-3166-1 alpha-3
});

export const beneficiaryRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * POST /api/v1/beneficiaries/onboard
   * Onboard beneficiary with encrypted PII and optional KYC document upload
   */
  fastify.post(
    '/onboard',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Beneficiaries'],
        summary: 'Onboard beneficiary with encrypted PII',
        description:
          'Submits beneficiary profile. All PII (legal name, phone, email) is encrypted with AES-256-GCM before storage. Only hashes and S3 keys are retained.',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const user = request.user!;

      // Handle either multipart or JSON request
      let legalName = '';
      let phone = '';
      let email: string | undefined;
      let country: string | undefined;
      let fileBuffer: Buffer | undefined;
      let fileName = '';
      let fileMime = '';

      if (request.isMultipart()) {
        const parts = request.parts();
        for await (const part of parts) {
          if (part.type === 'file') {
            fileBuffer = await part.toBuffer();
            fileName = part.filename;
            fileMime = part.mimetype;
          } else {
            const field = part.fieldname;
            const value = part.value as string;
            if (field === 'legalName') legalName = value;
            else if (field === 'phone') phone = value;
            else if (field === 'email') email = value;
            else if (field === 'country') country = value;
          }
        }
      } else {
        const parsed = onboardJsonSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({
            title: 'Validation Error',
            status: 400,
            detail: parsed.error.errors.map((e) => e.message).join(', '),
          });
        }
        legalName = parsed.data.legalName;
        phone = parsed.data.phone;
        email = parsed.data.email;
        country = parsed.data.country;
      }

      if (!legalName || !phone) {
        return reply.status(400).send({
          title: 'Validation Error',
          status: 400,
          detail: 'legalName and phone are required for beneficiary onboarding',
        });
      }

      // Encrypt sensitive PII fields
      const legalNameEncrypted = cryptoService.encrypt(legalName);
      const phoneEncrypted = cryptoService.encrypt(phone);
      const emailEncrypted = email ? cryptoService.encrypt(email) : null;

      // Update user role to BENEFICIARY and create/update Profile
      const updatedUser = await prisma.user.update({
        where: { id: user.userId },
        data: {
          role: UserRole.BENEFICIARY,
          profile: {
            upsert: {
              create: {
                legalNameEncrypted,
                phoneEncrypted,
                emailEncrypted,
                country: country || 'KEN',
              },
              update: {
                legalNameEncrypted,
                phoneEncrypted,
                emailEncrypted,
                country: country || 'KEN',
              },
            },
          },
        },
        include: { profile: true },
      });

      // Handle KYC document upload if provided
      let uploadedDocument = null;
      if (fileBuffer && fileName && fileMime) {
        const uploadResult = await storageService.uploadDocument({
          buffer: fileBuffer,
          filename: fileName,
          mimeType: fileMime,
          userId: user.userId,
          docType: 'KYC_IDENTIFICATION',
        });

        uploadedDocument = await prisma.document.create({
          data: {
            userId: user.userId,
            docType: 'KYC_IDENTIFICATION',
            s3Key: uploadResult.s3Key,
            fileHash: uploadResult.fileHash,
            mimeType: uploadResult.mimeType,
            sizeBytes: uploadResult.sizeBytes,
          },
        });
      }

      const anonAuditId = cryptoService.pseudonymize(updatedUser.stellarAddress);

      return reply.status(201).send({
        message: 'Beneficiary successfully onboarded with zero-plaintext PII protection',
        beneficiary: {
          userId: updatedUser.id,
          stellarAddress: updatedUser.stellarAddress,
          anonAuditId,
          role: updatedUser.role,
          country: updatedUser.profile?.country,
          hasKycDocument: !!uploadedDocument,
          documentHash: uploadedDocument?.fileHash,
        },
      });
    }
  );

  /**
   * GET /api/v1/beneficiaries/profile
   * Returns decrypted profile and document metadata for authenticated beneficiary
   */
  fastify.get(
    '/profile',
    {
      preHandler: [authenticate, requireRole([UserRole.BENEFICIARY, UserRole.ADMIN])],
      schema: {
        tags: ['Beneficiaries'],
        summary: 'Get decrypted beneficiary profile',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const userRecord = await prisma.user.findUnique({
        where: { id: user.userId },
        include: { profile: true, documents: true },
      });

      if (!userRecord || !userRecord.profile) {
        return reply.status(404).send({
          title: 'Profile Not Found',
          status: 404,
          detail: 'No onboarding profile found for this beneficiary',
        });
      }

      // Decrypt PII for authorized owner
      const legalName = cryptoService.decrypt(userRecord.profile.legalNameEncrypted);
      const phone = userRecord.profile.phoneEncrypted
        ? cryptoService.decrypt(userRecord.profile.phoneEncrypted)
        : null;
      const email = userRecord.profile.emailEncrypted
        ? cryptoService.decrypt(userRecord.profile.emailEncrypted)
        : null;

      return reply.send({
        userId: userRecord.id,
        stellarAddress: userRecord.stellarAddress,
        role: userRecord.role,
        legalName,
        phone,
        email,
        country: userRecord.profile.country,
        documents: userRecord.documents.map((d) => ({
          id: d.id,
          docType: d.docType,
          fileHash: d.fileHash,
          mimeType: d.mimeType,
          sizeBytes: d.sizeBytes,
          status: d.status,
          createdAt: d.createdAt,
        })),
      });
    }
  );

  /**
   * GET /api/v1/beneficiaries/vouchers
   * Returns list of claimable or redeemed vouchers assigned to the beneficiary
   */
  fastify.get(
    '/vouchers',
    {
      preHandler: [authenticate, requireRole([UserRole.BENEFICIARY, UserRole.ADMIN])],
      schema: {
        tags: ['Beneficiaries'],
        summary: 'Get vouchers issued to authenticated beneficiary',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const vouchers = await prisma.voucher.findMany({
        where: { beneficiaryAddress: user.stellarAddress },
        include: {
          program: {
            select: {
              title: true,
              tokenContractId: true,
              creatorAddress: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return reply.send({
        total: vouchers.length,
        vouchers: serializeBigInt(vouchers),
      });
    }
  );
};
