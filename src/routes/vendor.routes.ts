import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middlewares/auth.middleware.js';
import { UserRole } from '../types/auth.js';
import { prisma, serializeBigInt } from '../db/prisma.js';
import { cryptoService } from '../services/crypto.service.js';
import { storageService } from '../services/storage.service.js';
import { VendorCategory, VendorStatus } from '@prisma/client';

const vendorOnboardJsonSchema = z.object({
  businessName: z.string().min(2).max(120),
  category: z.nativeEnum(VendorCategory),
  contactEmail: z.string().email(),
  contactPhone: z.string().min(5).max(30),
  country: z.string().length(3).optional(),
});

export const vendorRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * POST /api/v1/vendors/onboard
   * Onboard business vendor with category selection, encrypted PII, and document upload
   */
  fastify.post(
    '/onboard',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Vendors'],
        summary: 'Onboard commercial vendor with category & credentials',
        description:
          'Submits vendor onboarding application with selected aid category and verification documents. Vendor status is initially PENDING until verified and registered on-chain.',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const user = request.user!;

      let businessName = '';
      let category: VendorCategory = VendorCategory.FOOD;
      let contactEmail = '';
      let contactPhone = '';
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
            if (field === 'businessName') businessName = value;
            else if (field === 'category') category = value as VendorCategory;
            else if (field === 'contactEmail') contactEmail = value;
            else if (field === 'contactPhone') contactPhone = value;
            else if (field === 'country') country = value;
          }
        }
      } else {
        const parsed = vendorOnboardJsonSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({
            title: 'Validation Error',
            status: 400,
            detail: parsed.error.errors.map((e) => e.message).join(', '),
          });
        }
        businessName = parsed.data.businessName;
        category = parsed.data.category;
        contactEmail = parsed.data.contactEmail;
        contactPhone = parsed.data.contactPhone;
        country = parsed.data.country;
      }

      if (!businessName || !category || !contactEmail) {
        return reply.status(400).send({
          title: 'Validation Error',
          status: 400,
          detail: 'businessName, category, and contactEmail are required for vendor onboarding',
        });
      }

      // Encrypt sensitive PII
      const legalNameEncrypted = cryptoService.encrypt(businessName);
      const emailEncrypted = cryptoService.encrypt(contactEmail);
      const phoneEncrypted = contactPhone ? cryptoService.encrypt(contactPhone) : null;

      // Update user role to VENDOR
      await prisma.user.update({
        where: { id: user.userId },
        data: {
          role: UserRole.VENDOR,
          profile: {
            upsert: {
              create: {
                legalNameEncrypted,
                emailEncrypted,
                phoneEncrypted,
                organizationName: businessName,
                country: country || 'KEN',
              },
              update: {
                legalNameEncrypted,
                emailEncrypted,
                phoneEncrypted,
                organizationName: businessName,
                country: country || 'KEN',
              },
            },
          },
        },
      });

      // Handle business license/registration document if provided
      let uploadedDocument = null;
      if (fileBuffer && fileName && fileMime) {
        const uploadResult = await storageService.uploadDocument({
          buffer: fileBuffer,
          filename: fileName,
          mimeType: fileMime,
          userId: user.userId,
          docType: 'BUSINESS_REGISTRATION',
        });

        uploadedDocument = await prisma.document.create({
          data: {
            userId: user.userId,
            docType: 'BUSINESS_REGISTRATION',
            s3Key: uploadResult.s3Key,
            fileHash: uploadResult.fileHash,
            mimeType: uploadResult.mimeType,
            sizeBytes: uploadResult.sizeBytes,
          },
        });
      }

      // Upsert Vendor entity
      const vendorRecord = await prisma.vendor.upsert({
        where: { stellarAddress: user.stellarAddress },
        update: {
          businessName,
          category,
          status: VendorStatus.PENDING,
          userId: user.userId,
        },
        create: {
          stellarAddress: user.stellarAddress,
          businessName,
          category,
          status: VendorStatus.PENDING,
          onChainRegistered: false,
          userId: user.userId,
        },
      });

      return reply.status(201).send({
        message: 'Vendor application submitted successfully. Pending NGO/Admin approval.',
        vendor: {
          id: vendorRecord.id,
          stellarAddress: vendorRecord.stellarAddress,
          businessName: vendorRecord.businessName,
          category: vendorRecord.category,
          status: vendorRecord.status,
          onChainRegistered: vendorRecord.onChainRegistered,
          hasLicenseDocument: !!uploadedDocument,
          documentHash: uploadedDocument?.fileHash,
        },
      });
    }
  );

  /**
   * GET /api/v1/vendors/profile
   * Returns current authenticated vendor status and documents
   */
  fastify.get(
    '/profile',
    {
      preHandler: [authenticate, requireRole([UserRole.VENDOR, UserRole.ADMIN])],
      schema: {
        tags: ['Vendors'],
        summary: 'Get vendor profile and registration status',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const vendor = await prisma.vendor.findUnique({
        where: { stellarAddress: user.stellarAddress },
        include: {
          user: {
            include: {
              documents: true,
            },
          },
        },
      });

      if (!vendor) {
        return reply.status(404).send({
          title: 'Vendor Not Found',
          status: 404,
          detail: 'No vendor profile associated with this account',
        });
      }

      return reply.send({
        id: vendor.id,
        stellarAddress: vendor.stellarAddress,
        businessName: vendor.businessName,
        category: vendor.category,
        status: vendor.status,
        onChainRegistered: vendor.onChainRegistered,
        registeredTxHash: vendor.registeredTxHash,
        registeredAt: vendor.registeredAt,
        documents: vendor.user?.documents.map((d) => ({
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
   * GET /api/v1/vendors/payouts
   * Returns list of payouts processed for the authenticated vendor
   */
  fastify.get(
    '/payouts',
    {
      preHandler: [authenticate, requireRole([UserRole.VENDOR, UserRole.ADMIN])],
      schema: {
        tags: ['Vendors'],
        summary: 'Get vendor payout transaction history',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const payouts = await prisma.vendorPayout.findMany({
        where: { vendorAddress: user.stellarAddress },
        include: {
          program: {
            select: {
              title: true,
              tokenContractId: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return reply.send({
        total: payouts.length,
        payouts: serializeBigInt(payouts),
      });
    }
  );
};
