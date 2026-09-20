/**
 * Gate 4 — the tier — pm/apis.mdx §4.7, §6.
 *
 * Three tiers, two switches, and admin is NOT "write plus".
 *
 * The two are held for different reasons at different times: write is "I
 * intend to let a program edit my budget this week"; admin is "I am doing
 * surgery right now and I am watching". Making admin imply write would be
 * convenient and would mean the operator who enabled deletes for ten minutes
 * left writes on for a month.
 *
 * The MCP is never granted admin (§6.1). That is enforced HERE, on the server,
 * rather than by the MCP declining to expose an admin tool — a client-side
 * omission is a policy, and this is a gate.
 */
import { MachineError } from './envelope.js';

export const TIERS = ['read', 'write', 'admin'] as const;
export type Tier = (typeof TIERS)[number];

export type TierGrants = {
  read: true;
  write: boolean;
  admin: boolean;
};

export function grantsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TierGrants {
  return {
    read: true,
    write: env.ACTUAL_MACHINE_ALLOW_WRITE === '1',
    admin: env.ACTUAL_MACHINE_ALLOW_ADMIN === '1',
  };
}

/**
 * Both switches are named in the refusal, because the commonest cause of a
 * write failing is that the operator turned on the one they were reading about
 * and not the other (§5.4).
 */
export function assertTier(required: Tier, grants: TierGrants): void {
  if (required === 'read') {
    return;
  }

  if (required === 'write' && !grants.write) {
    throw new MachineError(
      'write_disabled',
      'The write tier is off on this server.',
      'restart the sync server with ACTUAL_MACHINE_ALLOW_WRITE=1, and pass --write (abx) or set ABMCP_ALLOW_WRITE=1 (mcp)',
    );
  }

  if (required === 'admin' && !grants.admin) {
    throw new MachineError(
      'forbidden',
      'This route needs the admin tier, which is off on this server.',
      'restart the sync server with ACTUAL_MACHINE_ALLOW_ADMIN=1 — admin routes can lose data, and the MCP is never given this tier',
    );
  }
}
