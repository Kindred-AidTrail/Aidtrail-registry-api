import fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import { env } from './config/env.js';
import { APP_CONSTANTS } from './config/index.js';
import { requestIdPlugin } from './plugins/request-id.plugin.js';
import { rateLimitPlugin } from './plugins/rate-limit.plugin.js';
import { swaggerPlugin } from './plugins/swagger.plugin.js';
import { authRoutes } from './routes/auth.routes.js';
import { beneficiaryRoutes } from './routes/beneficiary.routes.js';
import { vendorRoutes } from './routes/vendor.routes.js';
import { gdprRoutes } from './routes/gdpr.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { auditRoutes } from './routes/audit.routes.js';

export interface AppOptions {
  logger?: boolean | object;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = fastify({
    logger: options.logger ?? {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
              },
            }
          : undefined,
    },
    disableRequestLogging: false,
  });

  // 1. Request Correlation ID
  app.register(requestIdPlugin);

  // 2. Rate Limiting
  app.register(rateLimitPlugin);

  // 3. Security Headers via Helmet
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'validator.swagger.io'],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  // 4. Cross-Origin Resource Sharing
  app.register(cors, {
    origin: true, // Allow all origins in dev/test, or configure per origin
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-Id'],
  });

  // 5. OpenAPI Swagger Documentation
  app.register(swaggerPlugin);

  // 5. HTTP Utilities & Error Helpers
  app.register(sensible);

  // 6. Multipart File Upload Support
  app.register(multipart, {
    limits: {
      fieldNameSize: 100,
      fieldSize: 1024 * 1024, // 1MB for text fields
      fields: 20,
      fileSize: APP_CONSTANTS.MAX_DOCUMENT_SIZE_BYTES, // 10MB
      files: 5,
    },
  });

  // 7. API Routes
  app.register(authRoutes, { prefix: '/api/v1/auth' });
  app.register(beneficiaryRoutes, { prefix: '/api/v1/beneficiaries' });
  app.register(vendorRoutes, { prefix: '/api/v1/vendors' });
  app.register(gdprRoutes, { prefix: '/api/v1/gdpr' });
  app.register(adminRoutes, { prefix: '/api/v1/admin' });
  app.register(auditRoutes, { prefix: '/api/v1/audit' });

  // 8. Global Health Check
  app.get('/health', async () => {
    return {
      status: 'healthy',
      service: APP_CONSTANTS.NAME,
      version: APP_CONSTANTS.VERSION,
      environment: env.NODE_ENV,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  });

  // 6. Centralized Structured Error Handler
  app.setErrorHandler((error: any, request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error.statusCode || (error.status ? Number(error.status) : 500);
    const correlationId = request.headers['x-request-id'] || request.id;

    if (statusCode >= 500) {
      request.log.error({ err: error, correlationId }, 'Unhandled server error');
    } else {
      request.log.warn({ err: error, correlationId }, 'Client error occurred');
    }

    reply.status(statusCode).send({
      type: `https://httpstatuses.com/${statusCode}`,
      title: error.name || 'Application Error',
      status: statusCode,
      detail: error.message || 'An unexpected internal error occurred',
      instance: request.raw.url,
      requestId: correlationId,
      timestamp: new Date().toISOString(),
    });
  });

  // 7. Not Found Handler
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply.status(404).send({
      type: 'https://httpstatuses.com/404',
      title: 'Not Found',
      status: 404,
      detail: `Resource '${request.raw.url}' does not exist on this server`,
      instance: request.raw.url,
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}
