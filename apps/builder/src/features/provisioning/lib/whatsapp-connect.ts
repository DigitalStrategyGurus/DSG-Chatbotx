import "server-only"

import {
  integrationWhatsappService,
  platformCredentialService,
  workspaceService,
} from "@chatbotx.io/business"
import { exchangeAccessToken } from "@chatbotx.io/integration-whatsapp/api/auth"
import { WhatsappException } from "@chatbotx.io/integration-whatsapp/exception"
import { connectWhatsappNumber } from "@/features/integration-whatsapp/actions/connect-number"
import {
  CONNECT_WHATSAPP_RESULT_TYPES,
  type ConnectWhatsappSchema,
} from "@/features/integration-whatsapp/schema"
import type { ConnectWhatsappRequest } from "../schema/whatsapp-requests"

/**
 * DSG forkpatch 6: server-to-server WhatsApp connect for a provisioned
 * workspace. Unibox calls it on behalf of a clinic that finished Embedded
 * Signup in the browser of an afnemer; no ChatbotX user session exists.
 *
 * The workspace owner acts as the user. On a self-hosted (non-cloud) edition
 * `resolvePlatformOwnerId` returns that user, and the owner holds a real
 * membership row, so every gate inside `connectWhatsappNumber` applies
 * unchanged. Nothing here logs a request body: it carries a code or a token.
 */

type Workspace = { id: string; ownerId: string }

const findWorkspace = async (
  workspaceId: string,
): Promise<Workspace | null> => {
  const workspace = await workspaceService.find({ where: { id: workspaceId } })
  return workspace ? { id: workspace.id, ownerId: workspace.ownerId } : null
}

export type ExchangeResult =
  | { kind: "exchanged"; accessToken: string }
  | { kind: "not_found" }
  | { kind: "credential_missing" }
  | { kind: "rejected"; metaStatus: number | undefined }
  | { kind: "unavailable" }

/**
 * 6a. Exchanges the popup's `code` without a `redirect_uri`: a code from the
 * JS SDK popup was not issued for one (see `exchangeAccessToken`'s own note),
 * unlike the fork's OAuth dialog path which passes its callback URL.
 */
export async function exchangeWhatsappCode(props: {
  workspaceId: string
  code: string
}): Promise<ExchangeResult> {
  const workspace = await findWorkspace(props.workspaceId)
  if (!workspace) {
    return { kind: "not_found" }
  }
  const credential = await platformCredentialService.resolveForOwner({
    ownerId: workspace.ownerId,
    type: "whatsapp",
  })
  if (!credential) {
    return { kind: "credential_missing" }
  }
  try {
    const result = await exchangeAccessToken(credential.config, props.code)
    return { kind: "exchanged", accessToken: result.access_token }
  } catch (err) {
    if (
      err instanceof WhatsappException &&
      err.httpStatusCode !== undefined &&
      err.httpStatusCode >= 400 &&
      err.httpStatusCode < 500
    ) {
      return { kind: "rejected", metaStatus: err.httpStatusCode }
    }
    return { kind: "unavailable" }
  }
}

export type ConnectResult =
  | {
      kind: "connected"
      alreadyConnected: boolean
      workspaceId: string
      integrationId: string | undefined
      phoneNumberId: string
      displayPhoneNumber: string | undefined
      warning: string | undefined
      coexist: boolean
      requiresPhoneVerification: boolean
    }
  | { kind: "not_found" }
  | { kind: "in_other_workspace" }
  | { kind: "rejected"; reason: string }
  | { kind: "retryable"; reason: string }

/**
 * 6b. Connects the number with a business token. Safe to retry: the fork
 * reports any connected number as `duplicated`, so a retry after a connect
 * that landed is recognised here by looking the number up in this workspace.
 */
export async function connectWhatsappForOwner(props: {
  workspaceId: string
  request: ConnectWhatsappRequest
}): Promise<ConnectResult> {
  const { request } = props
  const workspace = await findWorkspace(props.workspaceId)
  if (!workspace) {
    return { kind: "not_found" }
  }

  const input: ConnectWhatsappSchema = {
    businessId: request.businessId,
    wabaId: request.wabaId,
    phoneNumberId: request.phoneNumberId,
    accessToken: request.accessToken,
    workspaceId: workspace.id,
    connectExisting: request.coexistence,
    transferPhoneNumber: false,
    manualConnect: false,
    marketingMessageLite: false,
  }

  const result = await connectWhatsappNumber({
    userId: workspace.ownerId,
    input,
  })

  if ("type" in result) {
    if (result.type === CONNECT_WHATSAPP_RESULT_TYPES.CONNECTED) {
      return {
        kind: "connected",
        alreadyConnected: false,
        workspaceId: result.workspaceId,
        integrationId: result.outcome.integrationId,
        phoneNumberId: result.outcome.sourceId,
        displayPhoneNumber: result.outcome.extra?.displayPhoneNumber,
        warning: result.outcome.warning,
        coexist: result.outcome.coexistEligible,
        requiresPhoneVerification:
          result.outcome.extra?.requiresPhoneVerification ?? false,
      }
    }
    // Picker results cannot occur with an explicit phoneNumberId; treat any
    // that does as a request the caller must not repeat unchanged.
    return { kind: "rejected", reason: result.type }
  }

  if (result.kind === "sessionError") {
    return { kind: "rejected", reason: result.code }
  }

  const { outcome } = result
  if (outcome.status === "duplicated") {
    return await resolveDuplicate({ workspaceId: workspace.id, request })
  }

  // A wrong "retryable" only costs Unibox a few bounded attempts; a wrong
  // "rejected" costs the clinic a new popup. So only reasons that a retry with
  // the same token cannot change are final (CONNECT_FAILURE_REASONS in
  // packages/business/src/inbox/connect-outcome-types.ts).
  const reason = outcome.reason ?? "unknown"
  return FINAL_FAILURE_REASONS.has(reason)
    ? { kind: "rejected", reason }
    : { kind: "retryable", reason }
}

/**
 * Meta refused (revoked token, invalid number), the number is not on the
 * granted WABA, or a plan limit is reached. Everything else — Meta
 * unavailable, a concurrent connect holding the lease, an internal or unknown
 * error — is worth another attempt with the same token.
 */
const FINAL_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "providerRejected",
  "notSelectable",
  "channelLimit",
  "workspaceLimit",
])

async function resolveDuplicate(props: {
  workspaceId: string
  request: ConnectWhatsappRequest
}): Promise<ConnectResult> {
  const existing =
    await integrationWhatsappService.findByPhoneNumberIdForWorkspace({
      phoneNumberId: props.request.phoneNumberId,
      workspaceId: props.workspaceId,
    })
  if (!existing) {
    return { kind: "in_other_workspace" }
  }
  return {
    kind: "connected",
    alreadyConnected: true,
    workspaceId: props.workspaceId,
    integrationId: existing.id,
    phoneNumberId: existing.phoneNumberId,
    displayPhoneNumber: undefined,
    warning: undefined,
    coexist: false,
    requiresPhoneVerification: false,
  }
}
