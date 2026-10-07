import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sep10Service } from '../services/sep10.service.js';
import { jwtService } from '../services/jwt.service.js';
import { prisma } from '../db/prisma.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { UserRole } from '../types/auth.js';

const challengeQuerySchema = z.object({
  account: z.string().min(56).max(56).regex(/^G[A-Z0-9]{55}$/, 'Invalid Stellar public key format'),
  home_domain: z.string().optional(),
});

const tokenBodySchema = z.object({
  transaction: z.string().min(20, 'Transaction envelope XDR required'),
  account: z.string().min(56).max(56).regex(/^G[A-Z0-9]{55}$/, 'Invalid Stellar public key format'),
});

export const authRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * GET /api/v1/auth/challenge
   * Generates a SEP-10 challenge transaction for the requesting wallet
   */
  fastify.get(
    '/challenge',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Request SEP-10 challenge transaction',
        description:
          'Generates a SEP-10 compliant challenge transaction envelope for wallet signing.',
        querystring: {
          type: 'object',
          required: ['account'],
          properties: {
            account: {
              type: 'string',
              description: 'Stellar G... public key of the client wallet',
            },
            home_domain: {
              type: 'string',
              description: 'Optional home domain filter',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              transaction: { type: 'string' },
              network_passphrase: { type: 'string' },
              home_domain: { type: 'string' },
              expires_at: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = challengeQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          title: 'Validation Error',
          status: 400,
          detail: parsed.error.errors.map((e) => e.message).join(', '),
        });
      }

      const { account } = parsed.data;

      // Ensure user entry exists or retrieve existing
      await prisma.user.upsert({
        where: { stellarAddress: account },
        update: {},
        create: {
          stellarAddress: account,
          role: UserRole.DONOR, // Default role until specific onboarding completed
        },
      });

      const challenge = sep10Service.generateChallenge(account);

      return reply.send({
        transaction: challenge.transactionXdr,
        network_passphrase: challenge.networkPassphrase,
        home_domain: challenge.homeDomain,
        expires_at: challenge.expiresAt,
      });
    }
  );

  /**
   * POST /api/v1/auth/token
   * Submits client-signed challenge transaction to obtain JWT authentication token
   */
  fastify.post(
    '/token',
    {
      schema: {
        tags: ['Authentication'],
        summary: 'Exchange signed SEP-10 challenge for JWT',
        description:
          'Verifies cryptographic signatures on the challenge transaction and returns a signed JWT session token.',
        body: {
          type: 'object',
          required: ['transaction', 'account'],
          properties: {
            transaction: { type: 'string', description: 'Base64 XDR of signed challenge transaction' },
            account: { type: 'string', description: 'Client Stellar public key' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  stellarAddress: { type: 'string' },
                  role: { type: 'string' },
                  isVerified: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = tokenBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          title: 'Validation Error',
          status: 400,
          detail: parsed.error.errors.map((e) => e.message).join(', '),
        });
      }

      const { transaction, account } = parsed.data;

      // Verify cryptographic signatures on challenge
      const verification = sep10Service.verifyChallenge(transaction, account);
      if (!verification.isValid) {
        return reply.status(401).send({
          title: 'Authentication Failed',
          status: 401,
          detail: verification.error || 'Challenge signature verification failed',
        });
      }

      // Retrieve or update user
      const user = await prisma.user.upsert({
        where: { stellarAddress: account },
        update: { isVerified: true },
        create: {
          stellarAddress: account,
          role: UserRole.DONOR,
          isVerified: true,
        },
      });

      // Generate JWT
      const token = jwtService.generateToken({
        userId: user.id,
        stellarAddress: user.stellarAddress,
        role: user.role,
        isVerified: user.isVerified,
      });

      return reply.send({
        token,
        user: {
          id: user.id,
          stellarAddress: user.stellarAddress,
          role: user.role,
          isVerified: user.isVerified,
        },
      });
    }
  );

  /**
   * GET /api/v1/auth/me
   * Returns current authenticated user profile
   */
  fastify.get(
    '/me',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Authentication'],
        summary: 'Get current user session info',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              stellarAddress: { type: 'string' },
              role: { type: 'string' },
              isVerified: { type: 'boolean' },
              createdAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const user = await prisma.user.findUnique({
        where: { id: request.user!.userId },
      });

      if (!user) {
        return reply.status(404).send({
          title: 'User Not Found',
          status: 404,
          detail: 'User record associated with token was not found',
        });
      }

      return reply.send({
        id: user.id,
        stellarAddress: user.stellarAddress,
        role: user.role,
        isVerified: user.isVerified,
        createdAt: user.createdAt.toISOString(),
      });
    }
  );
};
