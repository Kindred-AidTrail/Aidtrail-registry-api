import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { cryptoService } from '../services/crypto.service.js';

const requestIdPluginAsync: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('onRequest', async (request, reply) => {
    const headerId = request.headers['x-request-id'];
    const correlationId =
      typeof headerId === 'string' && headerId.trim().length > 0
        ? headerId.trim()
        : cryptoService.generateSecureToken(16);

    // Set correlation ID header in reply
    reply.header('x-request-id', correlationId);
    (request as any).correlationId = correlationId;
  });
};

export const requestIdPlugin = fp(requestIdPluginAsync, {
  name: 'requestIdPlugin',
});
