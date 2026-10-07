import { FastifyRequest, FastifyReply } from 'fastify';
import { jwtService } from '../services/jwt.service.js';
import { JwtTokenDecoded, UserRole } from '../types/auth.js';

// Augment FastifyRequest with typed user property
declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtTokenDecoded;
  }
}

/**
 * Pre-handler hook to authenticate requests using JWT Bearer token.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({
      type: 'https://httpstatuses.com/401',
      title: 'Unauthorized',
      status: 401,
      detail: 'Missing or malformed Authorization header. Bearer token required.',
      instance: request.raw.url,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const token = authHeader.substring(7).trim();
  try {
    const payload = jwtService.verifyToken(token);
    request.user = payload;
  } catch (err: any) {
    reply.status(401).send({
      type: 'https://httpstatuses.com/401',
      title: 'Unauthorized',
      status: 401,
      detail: err.message || 'Invalid or expired token',
      instance: request.raw.url,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Higher-order pre-handler hook to enforce Role-Based Access Control.
 */
export function requireRole(allowedRoles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      reply.status(401).send({
        type: 'https://httpstatuses.com/401',
        title: 'Unauthorized',
        status: 401,
        detail: 'Authentication required before checking permissions',
        instance: request.raw.url,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const hasAccess = jwtService.hasRole(request.user.role, allowedRoles);
    if (!hasAccess) {
      reply.status(403).send({
        type: 'https://httpstatuses.com/403',
        title: 'Forbidden',
        status: 403,
        detail: `Access denied. Role '${request.user.role}' is not authorized. Required: [${allowedRoles.join(', ')}]`,
        instance: request.raw.url,
        timestamp: new Date().toISOString(),
      });
    }
  };
}
