import { NextResponse } from "next/server"
import { authorizeProvisioningRequest } from "@/features/provisioning/lib/provisioning-secret"
import { connectWhatsappForOwner } from "@/features/provisioning/lib/whatsapp-connect"
import { provisioningWorkspaceId } from "@/features/provisioning/schema/issue-workspace-token-request"
import { connectWhatsappRequest } from "@/features/provisioning/schema/whatsapp-requests"

// DSG forkpatch 6b: connect a WhatsApp number to a provisioned workspace with
// a business token from 6a. Idempotent per phone number, so Unibox may retry:
// 4xx means stop (the clinic must start again), 5xx means retry later.

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
  const parsed = connectWhatsappRequest.safeParse(raw)
  if (!parsed.success) {
    return json(400, { error: "invalid_body" })
  }
  try {
    const result = await connectWhatsappForOwner({
      workspaceId: id.data,
      request: parsed.data,
    })
    switch (result.kind) {
      case "connected":
        return json(200, {
          workspaceId: result.workspaceId,
          integrationId: result.integrationId,
          phoneNumberId: result.phoneNumberId,
          displayPhoneNumber: result.displayPhoneNumber,
          alreadyConnected: result.alreadyConnected,
          coexist: result.coexist,
          requiresPhoneVerification: result.requiresPhoneVerification,
          warning: result.warning,
        })
      case "not_found":
        return json(404, { error: "workspace_not_found" })
      case "in_other_workspace":
        return json(409, { error: "phone_number_in_other_workspace" })
      case "rejected":
        return json(422, { error: "connect_rejected", reason: result.reason })
      case "retryable":
        return json(502, { error: "connect_failed", reason: result.reason })
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
