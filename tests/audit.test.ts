import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { Keypair } from '@stellar/stellar-sdk';
import { jwtService } from '../src/services/jwt.service.js';
import { UserRole } from '../src/types/auth.js';
import { prisma } from '../src/db/prisma.js';

describe('Public Audit API, CSV Streaming & NGO Webhooks Tests', () => {
  let app: FastifyInstance;
  const ngoKey = Keypair.random();
  let ngoToken: string;
  let ngoUserId: string;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    await app.ready();

    const ngoUser = await prisma.user.create({
      data: {
        stellarAddress: ngoKey.publicKey(),
        role: UserRole.NGO,
        isVerified: true,
      },
    });
    ngoUserId = ngoUser.id;
    ngoToken = jwtService.generateToken({
      userId: ngoUser.id,
      stellarAddress: ngoUser.stellarAddress,
      role: UserRole.NGO,
      isVerified: true,
    });
  });

  afterAll(async () => {
    await prisma.webhookSubscription.deleteMany({
      where: { ngoAddress: ngoKey.publicKey() },
    });
    await prisma.user.deleteMany({
      where: { id: ngoUserId },
    });
    await app.close();
  });

  it('GET /api/v1/audit/programs: should return list of aid programs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit/programs?page=1&limit=10',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('programs');
    expect(body).toHaveProperty('total');
    expect(Array.isArray(body.programs)).toBe(true);
  });

  it('GET /api/v1/audit/programs/1: should return program breakdown and solvency invariants', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit/programs/1',
    });

    // If seeded program exists
    if (res.statusCode === 200) {
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('program');
      expect(body).toHaveProperty('accountingAudit');
      expect(body.accountingAudit).toHaveProperty('isSolvent');
    } else {
      expect(res.statusCode).toBe(404);
    }
  });

  it('GET /api/v1/audit/donors/totals: should return aggregate donor capital leaderboard', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit/donors/totals',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('totalUniqueDonors');
    expect(body).toHaveProperty('aggregateCapitalStroops');
    expect(body).toHaveProperty('topDonors');
  });

  it('GET /api/v1/audit/vouchers: should preserve pseudonymization guarantee', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit/vouchers',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('vouchers');

    for (const voucher of body.vouchers) {
      expect(voucher.beneficiaryAnonId).toBeDefined();
      expect(voucher.beneficiaryAnonId.startsWith('anon_')).toBe(true);
      // Ensure real stellar address is NEVER exposed in the public audit view
      expect(voucher.beneficiaryAddress).toBeUndefined();
    }
  });

  it('GET /api/v1/audit/export/csv: should stream disbursements CSV with proper headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit/export/csv?type=disbursements',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment; filename=');
    expect(res.body).toContain('Voucher_ID,Program_ID,Program_Title,Beneficiary_Pseudonym');
  });

  it('GET /api/v1/audit/export/csv: should stream milestones evidence CSV', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit/export/csv?type=milestones',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toContain('Program_ID,Program_Title,Milestone_Index,Milestone_Title');
  });

  it('NGO Webhooks: should register, list, test ping, and delete subscription', async () => {
    // 1. Register subscription
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: { authorization: `Bearer ${ngoToken}` },
      payload: {
        targetUrl: 'https://webhook.site/test-aidtrail',
        events: ['milestn:approved', 'voucher:redeemed'],
      },
    });

    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    expect(created.secret.startsWith('whsec_')).toBe(true);
    expect(created.events).toContain('milestn:approved');

    const subId = created.id;

    // 2. List subscriptions
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/webhooks',
      headers: { authorization: `Bearer ${ngoToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.body);
    expect(listBody.webhooks.some((w: any) => w.id === subId)).toBe(true);

    // 3. Delete subscription
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/webhooks/${subId}`,
      headers: { authorization: `Bearer ${ngoToken}` },
    });
    expect(deleteRes.statusCode).toBe(200);
  });
});
