import jwt, { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AuthTokenPayload, JwtTokenDecoded, UserRole, ROLE_PERMISSIONS, Permission } from '../types/auth.js';

export class JwtService {
  private readonly secret: string;
  private readonly expiresIn: string;

  constructor() {
    this.secret = env.JWT_SECRET;
    this.expiresIn = env.JWT_EXPIRES_IN;
  }

  /**
   * Generates a signed JWT authentication token for a validated user.
   */
  public generateToken(
    payload: AuthTokenPayload,
    expiresIn?: string
  ): string {
    const options: SignOptions = {
      expiresIn: (expiresIn || this.expiresIn) as any,
      issuer: 'aidtrail-registry-api',
      audience: 'aidtrail-platform',
    };
    return jwt.sign(payload, this.secret, options);
  }

  /**
   * Cryptographically verifies and unpacks a JWT Bearer token.
   */
  public verifyToken(token: string): JwtTokenDecoded {
    try {
      const decoded = jwt.verify(token, this.secret, {
        issuer: 'aidtrail-registry-api',
        audience: 'aidtrail-platform',
      }) as JwtTokenDecoded;
      return decoded;
    } catch (err: any) {
      throw new Error(`Invalid or expired authentication token: ${err.message}`);
    }
  }

  /**
   * Checks if a user's role satisfies any of the required roles.
   */
  public hasRole(userRole: UserRole, requiredRoles: UserRole[]): boolean {
    if (requiredRoles.length === 0) return true;
    if (userRole === UserRole.ADMIN) return true; // Superadmin has blanket role satisfaction
    return requiredRoles.includes(userRole);
  }

  /**
   * Checks if a user's role grants a specific permission.
   */
  public hasPermission(userRole: UserRole, permission: Permission): boolean {
    const permissions = ROLE_PERMISSIONS[userRole] || [];
    return permissions.includes(permission);
  }
}

export const jwtService = new JwtService();
