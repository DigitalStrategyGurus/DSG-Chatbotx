import { provisioningService } from "@chatbotx.io/business"
import { SYSTEM_ACTOR } from "@chatbotx.io/business/audit"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { NextResponse } from "next/server"
import { authorizeProvisioningRequest } from "@/features/provisioning/lib/provisioning-secret"
import {
  issueWorkspaceTokenRequest,
  provisioningWorkspaceId,
} from "@/features/provisioning/schema/issue-workspace-token-request"

const json = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })

export async function POST(
  request: Request,
  context: {
    params: Promise<{ workspaceId: string }>
  },
) {
  const auth = authorizeProvisioningRequest(request.headers)
  if (auth === "unconfigured") {
    return json(503, { error: "provisioning_disabled" })
  }
  if (auth === "unauthorized") {
    return json(401, { error: "unauthorized" })
  }
  const id = provisioningWorkspaceId.safeParse(
    (await context.params).workspaceId,
  )
  if (!id.success) {
    return json(400, { error: "invalid_workspace_id" })
  }
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json(400, { error: "invalid_json" })
  }
  const parsed = issueWorkspaceTokenRequest.safeParse(raw)
  if (!parsed.success) {
    return json(400, { error: "invalid_body" })
  }
  const { ownerEmail, tokenName, permission, scopes } = parsed.data
  try {
    const result = await provisioningService.issueWorkspaceToken({
      actorId: SYSTEM_ACTOR,
      workspaceId: id.data,
      ownerEmail,
      token: {
        name: tokenName,
        permission,
        scopes: scopes === "all" ? null : scopes,
      },
    })
    if (result.kind === "not_found") {
      return json(404, { error: "workspace_not_found" })
    }
    return json(201, { workspaceId: result.workspaceId, token: result.token })
  } catch (err) {
    // No error payload is logged: dependency errors can carry credentials.
    if (err instanceof ChatbotXException) {
      return json(err.httpStatusCode, { error: err.code })
    }
    return json(500, { error: "system_error" })
  }
}

// Explicit handlers ensure Next's automatic 405 also has no-store.
const methodNotAllowed = () =>
  new NextResponse(null, {
    status: 405,
    headers: { "Cache-Control": "no-store", Allow: "POST" },
  })
export const GET = methodNotAllowed
export const HEAD = methodNotAllowed
export const PUT = methodNotAllowed
export const PATCH = methodNotAllowed
export const DELETE = methodNotAllowed
export const OPTIONS = methodNotAllowed
