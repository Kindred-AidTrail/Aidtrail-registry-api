import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { authenticate, requireRole } from '../middlewares/auth.middleware.js';
import { UserRole } from '../types/auth.js';
import { prisma } from '../db/prisma.js';
import { webhookService } from '../services/webhook.service.js';

const createSubscriptionSchema = z.object({
  targetUrl: z.string().url(),
  events: z
    .array(
      z.enum([
        'program:created',
        'program:funded',
        'milestn:approved',
        'milestn:released',
        'voucher:issued',
        'voucher:redeemed',
        'voucher:reclaimed',
      ])
    )
    .min(1),
});

export const webhookRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * POST /api/v1/webhooks
   * Registers a new webhook subscription for an authorized NGO
   */
  fastify.post(
    '/',
    {
      preHandler: [authenticate, requireRole([UserRole.NGO, UserRole.ADMIN])],
      schema: {
        tags: ['Webhooks'],
        summary: 'Register webhook endpoint for NGO event notifications',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const parsed = createSubscriptionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          title: 'Validation Error',
          status: 400,
          detail: parsed.error.errors.map((e) => e.message).join(', '),
        });
      }

      const { targetUrl, events } = parsed.data;
      const ngoAddress = request.user!.stellarAddress;
      const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;

      const subscription = await prisma.webhookSubscription.create({
        data: {
          ngoAddress,
          targetUrl,
          secret,
          events,
          active: true,
          failureCount: 0,
        },
      });

      return reply.status(201).send({
        id: subscription.id,
        ngoAddress: subscription.ngoAddress,
        targetUrl: subscription.targetUrl,
        events: subscription.events,
        secret: subscription.secret, // Only returned at creation time
        createdAt: subscription.createdAt,
      });
    }
  );

  /**
   * GET /api/v1/webhooks
   * Lists all active webhook endpoints for authenticated NGO
   */
  fastify.get(
    '/',
    {
      preHandler: [authenticate, requireRole([UserRole.NGO, UserRole.ADMIN])],
      schema: {
        tags: ['Webhooks'],
        summary: 'List registered webhooks for authenticated NGO',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const ngoAddress = request.user!.stellarAddress;
      const subscriptions = await prisma.webhookSubscription.findMany({
        where: request.user!.role === UserRole.ADMIN ? {} : { ngoAddress },
        select: {
          id: true,
          ngoAddress: true,
          targetUrl: true,
          events: true,
          active: true,
          failureCount: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      return reply.send({
        total: subscriptions.length,
        webhooks: subscriptions,
      });
    }
  );

  /**
   * POST /api/v1/webhooks/:id/test
   * Sends a test ping event to verify connectivity and signature validation
   */
  fastify.post(
    '/:id/test',
    {
      preHandler: [authenticate, requireRole([UserRole.NGO, UserRole.ADMIN])],
      schema: {
        tags: ['Webhooks'],
        summary: 'Send test ping to webhook endpoint',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const sub = await prisma.webhookSubscription.findUnique({ where: { id } });

      if (!sub) {
        return reply.status(404).send({
          title: 'Subscription Not Found',
          status: 404,
          detail: 'Webhook subscription does not exist',
        });
      }

      const testPayload = JSON.stringify({
        event: 'test:ping',
        timestamp: new Date().toISOString(),
        deliveryId: crypto.randomUUID(),
        data: { message: 'AidTrail Webhook Test Delivery' },
      });

      const success = await webhookService.sendWebhook(sub, testPayload, crypto.randomUUID());

      return reply.send({
        success,
        targetUrl: sub.targetUrl,
        message: success
          ? 'Webhook endpoint responded successfully with 2xx status.'
          : 'Webhook delivery failed. Please check endpoint accessibility and SSL configuration.',
      });
    }
  );

  /**
   * DELETE /api/v1/webhooks/:id
   * Removes a webhook subscription
   */
  fastify.delete(
    '/:id',
    {
      preHandler: [authenticate, requireRole([UserRole.NGO, UserRole.ADMIN])],
      schema: {
        tags: ['Webhooks'],
        summary: 'Delete webhook subscription',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await prisma.webhookSubscription.deleteMany({ where: { id } });

      return reply.send({
        success: true,
        message: 'Webhook subscription deleted successfully.',
      });
    }
  );
};
