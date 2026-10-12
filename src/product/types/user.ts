/**
 * User Domain Contract — Build 11: Hosted MVP Foundation.
 *
 * Defines the user identity entity within CrashLab's hosted architecture.
 * Contains ZERO secrets, password fields, or authentication tokens.
 */

export interface User {
  readonly id: string;
  readonly schemaVersion: '1.0';
  readonly email: string;
  readonly name: string;
  readonly status: 'active' | 'suspended';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateUserInput {
  readonly email: string;
  readonly name: string;
}
