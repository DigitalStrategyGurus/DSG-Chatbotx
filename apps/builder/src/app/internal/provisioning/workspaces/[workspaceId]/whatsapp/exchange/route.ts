import { NextResponse } from "next/server"
import { authorizeProvisioningRequest } from "@/features/provisioning/lib/provisioning-secret"
import { exchangeWhatsappCode } from "@/features/provisioning/lib/whatsapp-connect"
import { provisioningWorkspaceId } from "@/features/provisioning/schema/issue-workspace-token-request"
import { exchangeWhatsappCodeRequest } from "@/features/provisioning/schema/whatsapp-requests"

// DSG forkpatch 6a: exchange an Embedded Signup code for a business token.
// The code lives 30 s, so this route does nothing else and stores nothing.

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
  const parsed = exchangeWhatsappCodeRequest.safeParse(raw)
  if (!parsed.success) {
    return json(400, { error: "invalid_body" })
  }
  try {
    const result = await exchangeWhatsappCode({
      workspaceId: id.data,
      code: parsed.data.code,
    })
    switch (result.kind) {
      case "exchanged":
        return json(200, { accessToken: result.accessToken })
      case "not_found":
        return json(404, { error: "workspace_not_found" })
      case "credential_missing":
        return json(503, { error: "whatsapp_credential_missing" })
      case "rejected":
        return json(422, {
          error: "code_exchange_rejected",
          metaStatus: result.metaStatus,
        })
      case "unavailable":
        return json(502, { error: "meta_unavailable" })
      default:
        return json(500, { error: "system_error" })
    }
  } catch {
    // No error payload is logged: dependency errors can carry credentials.
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
