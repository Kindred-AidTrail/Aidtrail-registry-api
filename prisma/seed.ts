import { PrismaClient, UserRole, VendorCategory, VendorStatus } from '@prisma/client';
import { cryptoService } from '../src/services/crypto.service.js';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting AidTrail Registry database seed...');

  // 1. Initialize Indexer Cursor
  await prisma.indexerCursor.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      cursor: null,
      lastLedger: 0,
    },
  });
  console.log('  ✓ Initialized indexer cursor');

  // 2. Seed Admin User
  const adminAddress = 'GBZXN7PIRZGNMHGA728VY3CW2QEMPL4UKNM42CRXS2VAEBFA4T6EOC43';
  const admin = await prisma.user.upsert({
    where: { stellarAddress: adminAddress },
    update: {},
    create: {
      stellarAddress: adminAddress,
      role: UserRole.ADMIN,
      isVerified: true,
      profile: {
        create: {
          legalNameEncrypted: cryptoService.encrypt('Kindred Global Admin'),
          emailEncrypted: cryptoService.encrypt('admin@aidtrail.kindred.org'),
          organizationName: 'Kindred AidTrail Foundation',
          country: 'CHE',
        },
      },
    },
  });
  console.log(`  ✓ Seeded Admin: ${admin.stellarAddress}`);

  // 3. Seed NGO User
  const ngoAddress = 'GDH6VCO5HQ3QYEMD3S5A6H6O43T5SXRHYXWJ4Q74P5POG2BJZG27Y5W4';
  const ngo = await prisma.user.upsert({
    where: { stellarAddress: ngoAddress },
    update: {},
    create: {
      stellarAddress: ngoAddress,
      role: UserRole.NGO,
      isVerified: true,
      profile: {
        create: {
          legalNameEncrypted: cryptoService.encrypt('International Relief Corps'),
          emailEncrypted: cryptoService.encrypt('programs@relief-corps.org'),
          organizationName: 'International Relief Corps',
          country: 'KEN',
        },
      },
    },
  });
  console.log(`  ✓ Seeded NGO: ${ngo.stellarAddress}`);

  // 4. Seed Verifiers (M-of-N consensus)
  const verifierAddresses = [
    'GCABG722A76MOKP7J3S7X4CVUXJ27DFG7T2RUX2K2H6ECLWGYX4XU5Z2',
    'GBQW7V3Z4P6X52M2N7C3Q5V2K3H6R2T2J5B4X3M2N7C3Q5V2K3H6R2T2',
    'GDUY5N6M2X7C4V3B2N1M8K7J6H5G4F3D2S1A0P9O8I7U6Y5T4R3E2W1Q',
  ];

  for (let i = 0; i < verifierAddresses.length; i++) {
    const address = verifierAddresses[i];
    await prisma.user.upsert({
      where: { stellarAddress: address },
      update: {},
      create: {
        stellarAddress: address,
        role: UserRole.VERIFIER,
        isVerified: true,
        profile: {
          create: {
            legalNameEncrypted: cryptoService.encrypt(`Independent Auditor #${i + 1}`),
            emailEncrypted: cryptoService.encrypt(`audit${i + 1}@global-verification.org`),
            organizationName: 'Global Humanitarian Audit Bureau',
            country: 'CHE',
          },
        },
      },
    });
  }
  console.log(`  ✓ Seeded ${verifierAddresses.length} Independent Verifiers`);

  // 5. Seed Whitelisted Vendor
  const vendorAddress = 'GBUY6V5B4N3M2X1Z0K9J8H7G6F5D4S3A2P1O0I9U8Y7T6R5E4W3Q2Z1X';
  const vendorUser = await prisma.user.upsert({
    where: { stellarAddress: vendorAddress },
    update: {},
    create: {
      stellarAddress: vendorAddress,
      role: UserRole.VENDOR,
      isVerified: true,
      profile: {
        create: {
          legalNameEncrypted: cryptoService.encrypt('Nairobi Fresh Grocers & Supplies Ltd'),
          emailEncrypted: cryptoService.encrypt('dispatch@nairobigrocers.co.ke'),
          organizationName: 'Nairobi Fresh Grocers',
          country: 'KEN',
        },
      },
      vendor: {
        create: {
          stellarAddress: vendorAddress,
          businessName: 'Nairobi Fresh Grocers',
          category: VendorCategory.FOOD,
          status: VendorStatus.APPROVED,
          onChainRegistered: true,
          registeredAt: new Date(),
        },
      },
    },
  });
  console.log(`  ✓ Seeded Vendor: ${vendorAddress}`);

  // 6. Seed Beneficiary
  const beneficiaryAddress = 'GCAX7Y8Z9W0V1U2T3S4R5Q6P7O8N9M0L1K2J3I4H5G6F7E8D9C0B1A2Z';
  const beneficiary = await prisma.user.upsert({
    where: { stellarAddress: beneficiaryAddress },
    update: {},
    create: {
      stellarAddress: beneficiaryAddress,
      role: UserRole.BENEFICIARY,
      isVerified: true,
      profile: {
        create: {
          legalNameEncrypted: cryptoService.encrypt('Amina Mohamed'),
          phoneEncrypted: cryptoService.encrypt('+254712345678'),
          country: 'KEN',
        },
      },
    },
  });
  console.log(`  ✓ Seeded Beneficiary: ${beneficiaryAddress} (Anon ID: ${cryptoService.pseudonymize(beneficiaryAddress)})`);

  // 7. Seed Demo Aid Program
  const tokenContractId = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
  const program = await prisma.program.upsert({
    where: { onChainId: BigInt(1) },
    update: {},
    create: {
      onChainId: BigInt(1),
      creatorAddress: ngoAddress,
      tokenContractId,
      title: 'Horn of Africa Emergency Food Voucher Relief',
      description: 'Transparent targeted digital food assistance for vulnerable households in drought-affected counties.',
      category: VendorCategory.FOOD,
      targetAmount: '1000000000000', // 100,000.00 XLM (stroops)
      totalFunded: '500000000000',
      totalReleased: '250000000000',
      totalAllocated: '100000000000',
      totalRedeemed: '75000000000',
      totalReclaimed: '0',
      requiredApprovals: 2,
      isPaused: false,
      isCancelled: false,
      createdAtLedger: 1042300,
      createdAtTxHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      milestones: {
        create: [
          {
            onChainIndex: 0,
            title: 'Phase 1: Emergency Staple Food Distribution (500 Households)',
            targetAmount: '250000000000',
            evidenceUri: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
            isApproved: true,
            isReleased: true,
            approvedLedger: 1042500,
            releasedLedger: 1042550,
          },
          {
            onChainIndex: 1,
            title: 'Phase 2: Supplementary Nutrition for Mothers and Infants',
            targetAmount: '250000000000',
            evidenceUri: 'ipfs://bafybeihkoviema7g3gxyt6la7bduj2hn2uvtfv4e26nf3efuylqabf3ocl',
            isApproved: false,
            isReleased: false,
          },
        ],
      },
    },
  });
  console.log(`  ✓ Seeded Aid Program #${program.onChainId.toString()}: "${program.title}"`);

  console.log('✅ AidTrail database seed completed successfully!\n');
}

main()
  .catch((e) => {
    console.error('❌ Database seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
