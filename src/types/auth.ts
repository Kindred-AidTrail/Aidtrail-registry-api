import { UserRole } from '@prisma/client';

export { UserRole };

export interface AuthTokenPayload {
  userId: string;
  stellarAddress: string;
  role: UserRole;
  isVerified: boolean;
}

export interface JwtTokenDecoded extends AuthTokenPayload {
  iat: number;
  exp: number;
}

export type Permission =
  | 'program:create'
  | 'program:pause'
  | 'program:cancel'
  | 'milestone:add'
  | 'milestone:approve'
  | 'voucher:issue'
  | 'voucher:redeem'
  | 'voucher:reclaim'
  | 'vendor:onboard'
  | 'vendor:approve'
  | 'beneficiary:onboard'
  | 'audit:read'
  | 'gdpr:manage';

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  ADMIN: [
    'program:create',
    'program:pause',
    'program:cancel',
    'milestone:add',
    'milestone:approve',
    'voucher:issue',
    'voucher:redeem',
    'voucher:reclaim',
    'vendor:onboard',
    'vendor:approve',
    'beneficiary:onboard',
    'audit:read',
    'gdpr:manage',
  ],
  NGO: [
    'program:create',
    'milestone:add',
    'voucher:issue',
    'voucher:reclaim',
    'vendor:approve',
    'beneficiary:onboard',
    'audit:read',
  ],
  VERIFIER: [
    'milestone:approve',
    'audit:read',
  ],
  BENEFICIARY: [
    'voucher:redeem',
    'gdpr:manage',
    'audit:read',
  ],
  VENDOR: [
    'vendor:onboard',
    'voucher:redeem',
    'audit:read',
    'gdpr:manage',
  ],
  DONOR: [
    'audit:read',
    'gdpr:manage',
  ],
};
