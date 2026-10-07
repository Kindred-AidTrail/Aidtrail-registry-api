import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { APP_CONSTANTS } from '../config/index.js';

const swaggerPluginAsync: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: APP_CONSTANTS.NAME,
        description:
          'AidTrail Registry API: Beneficiary/Vendor onboarding, SEP-10 wallet authentication, Soroban smart contract event indexing, and tamper-evident public audit trails.',
        version: APP_CONSTANTS.VERSION,
        contact: {
          name: 'Kindred AidTrail Team',
          url: 'https://aidtrail.kindred.org',
        },
        license: {
          name: 'Apache-2.0',
          url: 'https://www.apache.org/licenses/LICENSE-2.0.html',
        },
      },
      servers: [
        {
          url: 'http://localhost:4000',
          description: 'Local development server',
        },
        {
          url: 'https://api-testnet.aidtrail.kindred.org',
          description: 'Stellar Testnet Staging API',
        },
      ],
      tags: [
        { name: 'System', description: 'Health and service diagnostics' },
        { name: 'Authentication', description: 'SEP-10 challenge-response authentication and JWT exchange' },
        { name: 'Beneficiaries', description: 'Beneficiary profile intake and voucher claims' },
        { name: 'Vendors', description: 'Vendor onboarding and category qualification' },
        { name: 'Admin', description: 'On-chain vendor approval dispatch and system administration' },
        { name: 'Audit', description: 'Public read-only transparent ledger audit endpoints and CSV reports' },
        { name: 'Webhooks', description: 'NGO event subscriptions and automated webhook notifications' },
        { name: 'GDPR', description: 'Data portability export and cryptographic right-to-erasure' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Enter your JWT token obtained from /api/v1/auth/token',
          },
        },
      },
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      displayRequestDuration: true,
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
  });
};

export const swaggerPlugin = fp(swaggerPluginAsync, {
  name: 'swaggerPlugin',
});
