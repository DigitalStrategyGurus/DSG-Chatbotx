import { provisioningService } from "@chatbotx.io/business"
// Also registers the audit recorder the service dispatches to.
import { SYSTEM_ACTOR } from "@chatbotx.io/business/audit"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { toLoggableDatabaseError } from "@chatbotx.io/database/client"
import { NextResponse } from "next/server"
import { authorizeProvisioningRequest } from "@/features/provisioning/lib/provisioning-secret"
import { provisionWorkspaceRequest } from "@/features/provisioning/schema/provision-workspace-request"
import { logger } from "@/lib/log"

/**
 * `POST /internal/provisioning/workspaces` (DSG forkpatch 5).
 *
 * Server-to-server only. Lives under `app/internal/...` (not `app/api/...`) so
 * the external path carries no `/api` prefix and never meets the oRPC
 * catch-all at `app/api/[[...rest]]`. `/internal` is session-free in
 * `PUBLIC_ROUTES`; the bearer secret below is the only authentication, and the
 * reverse proxy must refuse `/internal/*` from the public internet.
 *
 * Status codes: 503 while `CHATBOTX_PROVISIONING_SECRET` is unset (fail
 * closed — a 404 would send the operator hunting for a routing bug instead of
 * the missing env), 401 on a missing or wrong bearer, 400 on an invalid body,
 * 409 when the owner already has a live workspace, 201 with the one-time token.
 *
 * The work itself is `provisioningService.provisionWorkspace` in
 * `packages/business`: no mail, and workspace + owner membership + token in
 * one transaction, so a 5xx never leaves a workspace without its token.
 */

const NO_STORE = { "Cache-Control": "no-store" }

const json = (
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
) => NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } })

export async function POST(request: Request) {
  const auth = authorizeProvisioningRequest(request.headers)
  if (auth === "unconfigured") {
    logger.warn(
      "Provisioning request refused: CHATBOTX_PROVISIONING_SECRET is unset or shorter than 32 characters",
    )
    return json(503, { error: "provisioning_disabled" })
  }
  if (auth === "unauthorized") {
    return json(
      401,
      { error: "unauthorized" },
      { "WWW-Authenticate": "Bearer" },
    )
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json(400, { error: "invalid_json" })
  }
  const parsed = provisionWorkspaceRequest.safeParse(raw)
  if (!parsed.success) {
    return json(400, {
      error: "invalid_body",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    })
  }

  try {
    const { ownerEmail, ownerName, workspaceName, tokenName, permission } =
      parsed.data
    const result = await provisioningService.provisionWorkspace({
      // No signed-in actor exists for a machine caller; the audit pipeline
      // persists this sentinel as a NULL user (`send-audit-log` handler).
      actorId: SYSTEM_ACTOR,
      ownerEmail,
      ownerName,
      workspaceName,
      token: {
        name: tokenName,
        permission,
        scopes: parsed.data.scopes === "all" ? null : parsed.data.scopes,
      },
    })
    if (result.kind === "conflict") {
      return json(409, {
        error: "owner_already_has_workspace",
        workspaceId: result.workspaceId,
      })
    }
    // The only place the plaintext token ever appears.
    return json(201, {
      workspaceId: result.workspaceId,
      ownerId: result.ownerId,
      token: result.token,
    })
  } catch (err) {
    if (err instanceof ChatbotXException) {
      // Domain refusals (quota, reserved email, token cap…) keep their code.
      return json(err.httpStatusCode, { error: err.code, message: err.message })
    }
    // Never log the body: it carries the owner's email and name.
    logger.error(
      { err: toLoggableDatabaseError(err) },
      "Provisioning request failed",
    )
    return json(500, { error: "system_error" })
  }
}
