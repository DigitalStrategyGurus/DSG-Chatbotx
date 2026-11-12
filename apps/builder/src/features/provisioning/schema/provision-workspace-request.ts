import {
  workspaceApiTokenPermissions,
  workspaceApiTokenScopes,
} from "@chatbotx.io/database/partials"
import { z } from "zod"

const NAME_MAX_LENGTH = 100
const EMAIL_MAX_LENGTH = 254

/**
 * Body of `POST /internal/provisioning/workspaces` (DSG forkpatch 5).
 *
 * `scopes` follows the workspace-token model (`WorkspaceApiToken.scopes`):
 * a non-empty list of scopes, or the literal `"all"` which is stored as NULL
 * (unrestricted) — the same explicit choice the token form forces with
 * `allScopes`. An empty list is a validation error, never a silent default.
 */
export const provisionWorkspaceRequest = z.object({
  ownerEmail: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email().max(EMAIL_MAX_LENGTH)),
  ownerName: z.string().trim().min(1).max(NAME_MAX_LENGTH),
  workspaceName: z.string().trim().min(1).max(NAME_MAX_LENGTH),
  tokenName: z.string().trim().min(1).max(NAME_MAX_LENGTH),
  scopes: z.union([z.literal("all"), z.array(workspaceApiTokenScopes).min(1)]),
  permission: workspaceApiTokenPermissions.default("full"),
})

export type ProvisionWorkspaceRequest = z.infer<
  typeof provisionWorkspaceRequest
>
