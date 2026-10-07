import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { buildApp } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { jwtService } from '../src/services/jwt.service.js';
import { UserRole } from '../src/types/auth.js';
import { prisma } from '../src/db/prisma.js';
import { cryptoService } from '../src/services/crypto.service.js';
import { VendorCategory, VendorStatus } from '@prisma/client';

describe('Onboarding, GDPR & Admin Approval Integration Tests', () => {
  let app: FastifyInstance;

  const adminKey = Keypair.random();
  const ngoKey = Keypair.random();
  const beneficiaryKey = Keypair.random();
  const vendorKey = Keypair.random();

  let adminToken: string;
  let ngoToken: string;
  let beneficiaryToken: string;
  let vendorToken: string;

  let beneficiaryUserId: string;
  let vendorUserId: string;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    await app.ready();

    // Create users in mock/test db state
    const adminUser = await prisma.user.create({
      data: {
        stellarAddress: adminKey.publicKey(),
        role: UserRole.ADMIN,
        isVerified: true,
      },
    });
    adminToken = jwtService.generateToken({
      userId: adminUser.id,
      stellarAddress: adminUser.stellarAddress,
      role: adminUser.role,
      isVerified: true,
    });

    const ngoUser = await prisma.user.create({
      data: {
        stellarAddress: ngoKey.publicKey(),
        role: UserRole.NGO,
        isVerified: true,
      },
    });
    ngoToken = jwtService.generateToken({
      userId: ngoUser.id,
      stellarAddress: ngoUser.stellarAddress,
      role: ngoUser.role,
      isVerified: true,
    });

    const benUser = await prisma.user.create({
      data: {
        stellarAddress: beneficiaryKey.publicKey(),
        role: UserRole.DONOR, // initial role
      },
    });
    beneficiaryUserId = benUser.id;
    beneficiaryToken = jwtService.generateToken({
      userId: benUser.id,
      stellarAddress: benUser.stellarAddress,
      role: benUser.role,
      isVerified: false,
    });

    const venUser = await prisma.user.create({
      data: {
        stellarAddress: vendorKey.publicKey(),
        role: UserRole.DONOR, // initial role
      },
    });
    vendorUserId = venUser.id;
    vendorToken = jwtService.generateToken({
      userId: venUser.id,
      stellarAddress: venUser.stellarAddress,
      role: venUser.role,
      isVerified: false,
    });
  });

  afterAll(async () => {
    // Clean up created test users
    await prisma.user.deleteMany({
      where: {
        stellarAddress: {
          in: [
            adminKey.publicKey(),
            ngoKey.publicKey(),
            beneficiaryKey.publicKey(),
            vendorKey.publicKey(),
          ],
        },
      },
    });
    await app.close();
  });

  it('Beneficiary Onboarding: should encrypt PII and assign BENEFICIARY role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/beneficiaries/onboard',
      headers: { authorization: `Bearer ${beneficiaryToken}` },
      payload: {
        legalName: 'Fatima Zahra',
        phone: '+254700112233',
        email: 'fatima@community.org',
        country: 'KEN',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.beneficiary.role).toBe(UserRole.BENEFICIARY);
    expect(body.beneficiary.anonAuditId).toContain('anon_');

    // Verify in database that plaintext is NOT stored in DB
    const profile = await prisma.profile.findUnique({
      where: { userId: beneficiaryUserId },
    });
    expect(profile).not.toBeNull();
    expect(profile!.legalNameEncrypted).not.toBe('Fatima Zahra');
    expect(cryptoService.decrypt(profile!.legalNameEncrypted)).toBe('Fatima Zahra');
  });

  it('Vendor Onboarding: should register pending vendor application with category', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vendors/onboard',
      headers: { authorization: `Bearer ${vendorToken}` },
      payload: {
        businessName: 'Sahara Fresh Produce Hub',
        category: VendorCategory.FOOD,
        contactEmail: 'orders@saharaproduce.org',
        contactPhone: '+254711998877',
        country: 'KEN',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.vendor.status).toBe(VendorStatus.PENDING);
    expect(body.vendor.onChainRegistered).toBe(false);
    expect(body.vendor.category).toBe(VendorCategory.FOOD);
  });

  it('Admin Approval: should forbid non-admin/non-NGO users from approving vendors', async () => {
    const vendor = await prisma.vendor.findUnique({
      where: { stellarAddress: vendorKey.publicKey() },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/vendors/${vendor!.id}/approve`,
      headers: { authorization: `Bearer ${beneficiaryToken}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('Admin Approval: NGO should approve vendor and record transaction dispatch', async () => {
    const vendor = await prisma.vendor.findUnique({
      where: { stellarAddress: vendorKey.publicKey() },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/vendors/${vendor!.id}/approve`,
      headers: { authorization: `Bearer ${ngoToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.vendor.status).toBe(VendorStatus.APPROVED);
    expect(body.vendor.onChainRegistered).toBe(true);
    expect(body.vendor.registeredTxHash).toBeDefined();

    // Verify audit log created
    const log = await prisma.auditLog.findFirst({
      where: { action: 'VENDOR_APPROVED_ON_CHAIN', targetId: vendor!.id },
    });
    expect(log).not.toBeNull();
  });

  it('Admin Approval: should reject approving already approved vendor with 409 Conflict', async () => {
    const vendor = await prisma.vendor.findUnique({
      where: { stellarAddress: vendorKey.publicKey() },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/vendors/${vendor!.id}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(409);
  });

  it('GDPR Portability: should export complete decrypted archive for beneficiary', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/gdpr/export',
      headers: { authorization: `Bearer ${beneficiaryToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.gdprSubject.stellarAddress).toBe(beneficiaryKey.publicKey());
    expect(body.profile.legalName).toBe('Fatima Zahra');
  });

  it('GDPR Right to Erasure: should purge PII data and unlink records', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/gdpr/forget',
      headers: { authorization: `Bearer ${beneficiaryToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // Verify profile is shredded
    const profile = await prisma.profile.findUnique({
      where: { userId: beneficiaryUserId },
    });
    expect(profile).toBeNull();
  });
});
