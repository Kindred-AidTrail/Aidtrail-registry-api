import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { buildApp } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { sep10Service } from '../src/services/sep10.service.js';
import { jwtService } from '../src/services/jwt.service.js';
import { UserRole } from '../src/types/auth.js';
import { prisma } from '../src/db/prisma.js';

describe('SEP-10 Authentication & RBAC Integration Tests', () => {
  let app: FastifyInstance;
  const clientKeypair = Keypair.random();
  const clientAddress = clientKeypair.publicKey();

  beforeAll(async () => {
    app = buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/auth/challenge: should reject invalid Stellar public key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/challenge?account=invalid-key',
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.title).toBe('Validation Error');
  });

  it('GET /api/v1/auth/challenge: should return valid SEP-10 challenge transaction envelope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/challenge?account=${clientAddress}`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('transaction');
    expect(body).toHaveProperty('network_passphrase');
    expect(body).toHaveProperty('home_domain');
    expect(body).toHaveProperty('expires_at');
    expect(typeof body.transaction).toBe('string');
  });

  it('POST /api/v1/auth/token: should reject challenge signed with incorrect key', async () => {
    // Generate challenge for clientAddress
    const challenge = sep10Service.generateChallenge(clientAddress);

    // Sign with an attacker keypair instead
    const attackerKeypair = Keypair.random();
    const tx = TransactionBuilder.fromXDR(
      challenge.transactionXdr,
      challenge.networkPassphrase
    ) as any;
    tx.sign(attackerKeypair);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: {
        transaction: tx.toXDR(),
        account: clientAddress,
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.title).toBe('Authentication Failed');
  });

  it('POST /api/v1/auth/token: should accept genuine client signature and return JWT token', async () => {
    // Generate challenge for clientAddress
    const challenge = sep10Service.generateChallenge(clientAddress);

    // Sign with client's actual private key
    const tx = TransactionBuilder.fromXDR(
      challenge.transactionXdr,
      challenge.networkPassphrase
    ) as any;
    tx.sign(clientKeypair);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: {
        transaction: tx.toXDR(),
        account: clientAddress,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('token');
    expect(body.user.stellarAddress).toBe(clientAddress);
    expect(body.user.isVerified).toBe(true);

    // Verify token can be unpacked
    const decoded = jwtService.verifyToken(body.token);
    expect(decoded.stellarAddress).toBe(clientAddress);
  });

  it('GET /api/v1/auth/me: should reject unauthenticated request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
    });

    expect(res.statusCode).toBe(401);
  });

  it('GET /api/v1/auth/me: should return authenticated user profile with Bearer token', async () => {
    // Generate token for clientAddress
    const token = jwtService.generateToken({
      userId: 'test-user-id',
      stellarAddress: clientAddress,
      role: UserRole.DONOR,
      isVerified: true,
    });

    // Mock findUnique in test
    const originalFindUnique = prisma.user.findUnique;
    (prisma.user as any).findUnique = async () => ({
      id: 'test-user-id',
      stellarAddress: clientAddress,
      role: UserRole.DONOR,
      isVerified: true,
      createdAt: new Date(),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.stellarAddress).toBe(clientAddress);
    expect(body.role).toBe(UserRole.DONOR);

    // Restore
    prisma.user.findUnique = originalFindUnique;
  });

  it('RBAC permission checks: should correctly validate role permissions', () => {
    expect(jwtService.hasRole(UserRole.ADMIN, [UserRole.NGO])).toBe(true);
    expect(jwtService.hasRole(UserRole.DONOR, [UserRole.ADMIN])).toBe(false);
    expect(jwtService.hasRole(UserRole.NGO, [UserRole.NGO, UserRole.ADMIN])).toBe(true);
    expect(jwtService.hasPermission(UserRole.NGO, 'voucher:issue')).toBe(true);
    expect(jwtService.hasPermission(UserRole.BENEFICIARY, 'voucher:issue')).toBe(false);
  });
});
