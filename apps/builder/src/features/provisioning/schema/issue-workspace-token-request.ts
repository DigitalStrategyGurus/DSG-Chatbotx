import { z } from "zod"
import { provisionWorkspaceRequest } from "./provision-workspace-request"

export const issueWorkspaceTokenRequest = provisionWorkspaceRequest.pick({
  ownerEmail: true,
  tokenName: true,
  scopes: true,
  permission: true,
})

const WORKSPACE_ID_PATTERN = /^[1-9][0-9]{0,18}$/

// Workspace IDs are positive PostgreSQL bigint strings, not UUIDs.
export const provisioningWorkspaceId = z
  .string()
  .regex(WORKSPACE_ID_PATTERN)
  .refine(
    (id) => WORKSPACE_ID_PATTERN.test(id) && BigInt(id) <= 9223372036854775807n,
  )
