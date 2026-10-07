import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

// Global declaration for singleton instance across dev hot reloads
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error', 'warn'],
  });

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Cleanly closes the database connection pool during server shutdown.
 */
export async function closeDatabaseConnection(): Promise<void> {
  await prisma.$disconnect();
}

/**
 * Utility to convert BigInt values in Prisma records to strings for JSON serialization.
 */
export function serializeBigInt<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (_, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )
  );
}

export default prisma;
