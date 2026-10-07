import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';

const rateLimitPluginAsync: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  await fastify.register(rateLimit, {
    max: 120, // Max 120 requests per minute
    timeWindow: '1 minute',
    allowList: (req) => {
      // Exclude healthcheck from rate limits
      return req.url === '/health';
    },
    errorResponseBuilder: (req, context) => {
      return {
        type: 'https://httpstatuses.com/429',
        title: 'Too Many Requests',
        status: 429,
        detail: `Rate limit exceeded. You have reached the maximum of ${context.max} requests per ${context.after}. Please try again later.`,
        instance: req.url,
        timestamp: new Date().toISOString(),
      };
    },
  });
};

export const rateLimitPlugin = fp(rateLimitPluginAsync, {
  name: 'rateLimitPlugin',
});
