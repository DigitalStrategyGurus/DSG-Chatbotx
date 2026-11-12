import { db } from "@chatbotx.io/database/client"
import {
  ROOT_TENANT_ID,
  type WorkspaceApiTokenPermission,
  type WorkspaceApiTokenScope,
} from "@chatbotx.io/database/partials"
import {
  userRepository,
  workspaceRepository,
} from "@chatbotx.io/database/repositories"
import { isPlaceholderEmail } from "@chatbotx.io/utils/placeholder-email"
import { generateRandomString, hashPassword } from "better-auth/crypto"
import { dispatchAuditRecordSafely } from "../audit/dispatcher"
import { BaseService } from "../base.service"
import { ChatbotXException, teamMembersLimitReachedException } from "../errors"
import { logger } from "../logger"
import { quotaEnforcementService } from "../quota-enforcement/service"
import { userQuotaService } from "../user-quota/service"
import {
  compensateWorkspaceQuotaConsumption,
  type WorkspaceQuotaConsumption,
} from "../workspace/quota-consumption"
import { workspaceService } from "../workspace/service"
import { generateWorkspaceToken } from "../workspace-api-token/credentials"
import { workspaceApiTokenService } from "../workspace-api-token/service"
import {
  workspaceMemberCacheTag,
  workspaceMemberService,
  workspaceRosterCacheTag,
} from "../workspace-member/service"

// DSG forkpatch 5. This file is fork-only: upstream has no counterpart, so an
// upstream update can only break it through the services it calls.

const UNUSABLE_PASSWORD_LENGTH = 64

export type ProvisionWorkspaceInput = {
  /** Audit actor. A machine caller passes `SYSTEM_ACTOR` (persisted as a NULL user). */
  actorId: string
  ownerEmail: string
  ownerName: string
  workspaceName: string
  token: {
    name: string
    permission: WorkspaceApiTokenPermission
    /** `null` = unrestricted ("All scopes"). */
    scopes: WorkspaceApiTokenScope[] | null
  }
}

export type ProvisionWorkspaceResult =
  | {
      kind: "created"
      workspaceId: string
      ownerId: string
      /** False when the owner account already existed without a live workspace. */
      ownerCreated: boolean
      /** Plaintext, handed out exactly once. Only its hash is stored. */
      token: string
    }
  | { kind: "conflict"; workspaceId: string }

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

class ProvisioningService extends BaseService {
  /** Mint an additional token; never revoke or recover an existing token. */
  async issueWorkspaceToken(props: {
    actorId: string
    workspaceId: string
    ownerEmail: string
    token: ProvisionWorkspaceInput["token"]
  }): Promise<
    | { kind: "created"; workspaceId: string; token: string }
    | { kind: "not_found" }
  > {
    const result = await db.transaction(async (tx) => {
      const owner = await userRepository.findIdByEmail(
        {
          email: normalizeEmail(props.ownerEmail),
          tenantId: ROOT_TENANT_ID,
        },
        tx,
      )
      if (!owner) {
        return
      }
      const membership = await workspaceMemberService.findMembership({
        workspaceId: props.workspaceId,
        userId: owner.id,
        tx,
      })
      const workspace = membership?.workspace
      if (
        membership?.role !== "owner" ||
        !workspace ||
        workspace.ownerId !== owner.id ||
        !workspace.isActive ||
        workspace.scheduledDeletionAt ||
        workspace.purgeStartedAt
      ) {
        return
      }
      const { token, tokenHash, tokenPrefix } = await generateWorkspaceToken()
      await workspaceApiTokenService.createToken({
        workspaceId: workspace.id,
        ...props.token,
        tokenHash,
        tokenPrefix,
        tx,
      })
      return { kind: "created" as const, workspaceId: workspace.id, token }
    })
    if (!result) {
      return { kind: "not_found" }
    }
    // createToken suppresses its own audit in a caller-owned transaction.
    await dispatchAuditRecordSafely(
      {
        userId: props.actorId,
        workspaceId: result.workspaceId,
        action: "create",
        detail: `created workspace API token through the provisioning recovery API (${props.token.permission})`,
      },
      "Provisioning: failed to record token recovery audit after commit",
    )
    return result
  }

  /**
   * Server-to-server provisioning: an owner account, its workspace with the
   * owner membership, and one workspace API token.
   *
   * Differs from `adminWorkspaceService.createWithMembers` in three ways: no
   * mail is sent (the owner is a technical account whose address receives no
   * mail), the owner's name is stored, and the token is minted in the same
   * transaction as the workspace.
   *
   * Two commits, not one:
   * 1. the owner account (`userRepository.insertWithCredential`);
   * 2. workspace + owner membership + usage row + API token, atomically.
   *
   * The account has to be committed first: `workspaceService.create` takes
   * the `workspaces` seat on the global connection, which upserts a
   * `UserQuota` row whose foreign key points at the user. An owner that only
   * exists inside an open transaction is invisible to that connection and the
   * seat write fails.
   *
   * A failure after step 1 leaves an account without a workspace and nothing
   * else: no mail went out, nobody knows its password. A retry finds it by
   * email and continues. A failure inside step 2 rolls back every row of
   * step 2 and hands the seat back.
   *
   * Idempotent per owner email: an owner with a live workspace gets
   * `conflict` and no token. Concurrent calls are serialized on the same
   * advisory lock `workspaceService.ensureFirstForOwner` uses, so the loser
   * also gets `conflict`.
   */
  async provisionWorkspace(
    props: ProvisionWorkspaceInput,
  ): Promise<ProvisionWorkspaceResult> {
    const ownerEmail = normalizeEmail(props.ownerEmail)
    const owner = await this.findOrCreateOwner({
      email: ownerEmail,
      name: props.ownerName.trim(),
    })
    const ownerId = owner.userId

    // Same reads, same precedence as `createWithMembers`: an existing
    // workspace wins over a team-member quota refusal.
    const [existingWorkspace, tenantId, hasRoom] = await Promise.all([
      workspaceService.findActiveByOwner({ ownerId }),
      workspaceService.resolveTenantForOwner(ownerId),
      quotaEnforcementService.hasRoomForTeamMembers({
        userId: ownerId,
        additionalCount: 1,
      }),
    ])
    if (existingWorkspace) {
      return { kind: "conflict", workspaceId: existingWorkspace.id }
    }
    if (!hasRoom) {
      throw teamMembersLimitReachedException()
    }

    const { token, tokenHash, tokenPrefix } = await generateWorkspaceToken()
    const quotaConsumption: WorkspaceQuotaConsumption = { consumed: false }

    let outcome: { workspaceId: string; created: boolean }
    try {
      outcome = await db.transaction(async (tx) => {
        // Held until commit, so a second provisioning call (or the owner
        // opening the builder, `ensureFirstForOwner`) waits here and then
        // sees the workspace this transaction wrote.
        await workspaceRepository.lockFirstWorkspace({ ownerId }, tx)
        const raced = await workspaceService.findActiveByOwner({ ownerId, tx })
        if (raced) {
          return { workspaceId: raced.id, created: false }
        }

        const workspace = await workspaceService.create({
          data: { name: props.workspaceName, ownerId, tenantId },
          createdBy: ownerId,
          tx,
          quotaConsumption,
        })
        await workspaceApiTokenService.createToken({
          workspaceId: workspace.id,
          name: props.token.name,
          permission: props.token.permission,
          tokenHash,
          tokenPrefix,
          scopes: props.token.scopes,
          tx,
        })
        return { workspaceId: workspace.id, created: true }
      })
    } catch (err) {
      // The seat and the live team-member counter live outside SQL; the
      // rollback above does not return them.
      await compensateWorkspaceQuotaConsumption(quotaConsumption)
      throw err
    }

    if (!outcome.created) {
      return { kind: "conflict", workspaceId: outcome.workspaceId }
    }
    const { workspaceId } = outcome

    await this.afterCommit({
      actorId: props.actorId,
      ownerEmail,
      ownerId,
      ownerCreated: owner.created,
      workspaceId,
      token: props.token,
    })

    return {
      kind: "created",
      workspaceId,
      ownerId,
      ownerCreated: owner.created,
      token,
    }
  }

  /**
   * Root tenant only, like `findOrProvisionRootUser`, minus the credentials
   * mail. The password is random and dropped right after hashing: the
   * account can only be entered through a password reset or by an operator.
   * `insertWithCredential` stores `emailVerified: true` and
   * `mustChangePassword: true`; the latter is kept on purpose, so a session
   * that ever does exist for this account is held at the change-password
   * page. Workspace API tokens do not read the flag.
   *
   * An existing account is reused as it is; its name is left alone.
   */
  private async findOrCreateOwner(props: {
    email: string
    name: string
  }): Promise<{ userId: string; created: boolean }> {
    const existing = await userRepository.findIdByEmail({
      email: props.email,
      tenantId: ROOT_TENANT_ID,
    })

    let owner: { userId: string; created: boolean }
    if (existing) {
      owner = { userId: existing.id, created: false }
    } else {
      if (isPlaceholderEmail(props.email)) {
        throw new ChatbotXException(
          "Email address is reserved and cannot be provisioned",
          "invalidEmail",
          400,
        )
      }
      owner = await userRepository.insertWithCredential({
        email: props.email,
        name: props.name,
        hashedPassword: await hashPassword(
          generateRandomString(UNUSABLE_PASSWORD_LENGTH, "a-z", "A-Z", "0-9"),
        ),
        tenantId: ROOT_TENANT_ID,
      })
    }

    // Idempotent (and a no-op off cloud). Also runs for an existing account,
    // so a retry repairs a run that died between the insert and this stamp.
    await userQuotaService.ensureBootstrapPlan({
      userId: owner.userId,
      tenantId: ROOT_TENANT_ID,
    })

    return owner
  }

  /**
   * Inside a caller-owned transaction `workspaceService.create` busts the
   * membership cache tags before the commit, so a concurrent read can cache
   * the owner's list again without the new workspace; and neither `create`
   * nor `createToken` writes an audit record there. Both are redone here,
   * after the commit. Best-effort: the rows are committed and the token
   * cannot be minted again, so a failure here must not fail the request.
   */
  private async afterCommit(props: {
    actorId: string
    ownerEmail: string
    ownerId: string
    ownerCreated: boolean
    workspaceId: string
    token: ProvisionWorkspaceInput["token"]
  }): Promise<void> {
    const { workspaceId } = props
    try {
      await this.invalidateCacheTags([
        workspaceMemberCacheTag(props.ownerId),
        workspaceRosterCacheTag(workspaceId),
      ])
    } catch (err) {
      logger.warn(
        { err, workspaceId },
        "Provisioning: cache invalidation failed after commit",
      )
    }

    const scopeSummary =
      props.token.scopes && props.token.scopes.length > 0
        ? props.token.scopes.join(",")
        : "all"
    await dispatchAuditRecordSafely(
      {
        userId: props.actorId,
        workspaceId,
        action: "create",
        detail:
          `created the workspace (#${workspaceId}) for ${props.ownerEmail}` +
          (props.ownerCreated ? " (new account)" : "") +
          ` through the provisioning API, with workspace API token "${props.token.name}"` +
          ` (${props.token.permission}, scopes: ${scopeSummary})`,
      },
      "Provisioning: failed to record audit log after commit",
    )
  }
}

export const provisioningService = new ProvisioningService()
