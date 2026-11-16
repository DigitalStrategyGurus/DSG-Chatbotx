// @vitest-environment node
// DSG forkpatch 6: HTTP contract of the internal WhatsApp routes (6a, 6b).
import { beforeEach, describe, expect, test, vi } from "vitest"

const SECRET = "s".repeat(40)

const mocks = vi.hoisted(() => ({
  env: { CHATBOTX_PROVISIONING_SECRET: undefined as string | undefined },
  exchangeWhatsappCode: vi.fn(),
  connectWhatsappForOwner: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock("@/env", () => ({ env: mocks.env }))
vi.mock("@/lib/log", () => ({ logger: mocks.logger }))
vi.mock("@/features/provisioning/lib/whatsapp-connect", () => ({
  exchangeWhatsappCode: mocks.exchangeWhatsappCode,
  connectWhatsappForOwner: mocks.connectWhatsappForOwner,
}))

const exchange = await import(
  "@/app/internal/provisioning/workspaces/[workspaceId]/whatsapp/exchange/route"
)
const connect = await import(
  "@/app/internal/provisioning/workspaces/[workspaceId]/whatsapp/connect/route"
)

type Handler = typeof exchange.POST

const call = (
  handler: Handler,
  body: unknown,
  options: {
    bearer?: string | null
    rawBody?: string
    workspaceId?: string
  } = {},
) => {
  const headers: Record<string, string> = { "content-type": "application/json" }
  const bearer = options.bearer === undefined ? SECRET : options.bearer
  if (bearer !== null) {
    headers.Authorization = `Bearer ${bearer}`
  }
  return handler(
    new Request(
      "http://builder.internal/internal/provisioning/workspaces/1/whatsapp",
      {
        method: "POST",
        headers,
        body: options.rawBody ?? JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ workspaceId: options.workspaceId ?? "123" }) },
  )
}

const connectBody = {
  accessToken: "EAAG-business-token",
  wabaId: "111",
  phoneNumberId: "222",
  businessId: "333",
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.env.CHATBOTX_PROVISIONING_SECRET = SECRET
})

describe.each([
  ["6a exchange", exchange.POST, { code: "AQB-code" }],
  ["6b connect", connect.POST, connectBody],
] as const)("%s: shared guards", (_name, handler, body) => {
  test("503 when the secret is not configured", async () => {
    mocks.env.CHATBOTX_PROVISIONING_SECRET = undefined
    const res = await call(handler, body)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "provisioning_disabled" })
  })

  test("401 without or with a wrong bearer", async () => {
    expect((await call(handler, body, { bearer: null })).status).toBe(401)
    expect((await call(handler, body, { bearer: "x".repeat(40) })).status).toBe(
      401,
    )
  })

  test("400 for a non-numeric workspace id, bad json or bad body", async () => {
    expect((await call(handler, body, { workspaceId: "abc" })).status).toBe(400)
    expect((await call(handler, body, { rawBody: "{" })).status).toBe(400)
    expect((await call(handler, {})).status).toBe(400)
  })

  test("every response is no-store and nothing is logged", async () => {
    const res = await call(handler, body, { bearer: null })
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(mocks.logger.error).not.toHaveBeenCalled()
    expect(mocks.logger.warn).not.toHaveBeenCalled()
  })
})

describe("6a exchange", () => {
  test("200 with the business token", async () => {
    mocks.exchangeWhatsappCode.mockResolvedValue({
      kind: "exchanged",
      accessToken: "EAAG-token",
    })
    const res = await call(exchange.POST, { code: " AQB-code " })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accessToken: "EAAG-token" })
    expect(mocks.exchangeWhatsappCode).toHaveBeenCalledWith({
      workspaceId: "123",
      code: "AQB-code",
    })
  })

  test.each([
    [{ kind: "not_found" }, 404, "workspace_not_found"],
    [{ kind: "credential_missing" }, 503, "whatsapp_credential_missing"],
    [{ kind: "rejected", metaStatus: 400 }, 422, "code_exchange_rejected"],
    [{ kind: "unavailable" }, 502, "meta_unavailable"],
  ])("%o maps to %i", async (result, status, error) => {
    mocks.exchangeWhatsappCode.mockResolvedValue(result)
    const res = await call(exchange.POST, { code: "AQB-code" })
    expect(res.status).toBe(status)
    expect((await res.json()).error).toBe(error)
  })

  test("500 without leaking the error", async () => {
    mocks.exchangeWhatsappCode.mockRejectedValue(
      new Error("GET ...?client_secret=leak&code=AQB-code"),
    )
    const res = await call(exchange.POST, { code: "AQB-code" })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("leak")
  })

  test("other methods answer 405", () => {
    for (const method of [exchange.GET, exchange.PUT, exchange.DELETE]) {
      expect(method().status).toBe(405)
    }
  })
})

describe("6b connect", () => {
  test("defaults coexistence to false and passes the parsed body", async () => {
    mocks.connectWhatsappForOwner.mockResolvedValue({
      kind: "connected",
      alreadyConnected: false,
      workspaceId: "123",
      integrationId: "int_1",
      phoneNumberId: "222",
      displayPhoneNumber: "+34 600 000 000",
      warning: undefined,
      coexist: false,
      requiresPhoneVerification: false,
    })
    const res = await call(connect.POST, connectBody)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      integrationId: "int_1",
      alreadyConnected: false,
    })
    expect(mocks.connectWhatsappForOwner).toHaveBeenCalledWith({
      workspaceId: "123",
      request: { ...connectBody, coexistence: false },
    })
  })

  test("400 for a non-numeric Meta id", async () => {
    const res = await call(connect.POST, { ...connectBody, wabaId: "waba" })
    expect(res.status).toBe(400)
  })

  test.each([
    [{ kind: "not_found" }, 404],
    [{ kind: "in_other_workspace" }, 409],
    [{ kind: "rejected", reason: "notSelectable" }, 422],
    [{ kind: "retryable", reason: "unknown" }, 502],
  ])("%o maps to %i", async (result, status) => {
    mocks.connectWhatsappForOwner.mockResolvedValue(result)
    expect((await call(connect.POST, connectBody)).status).toBe(status)
  })

  test("500 without echoing the token", async () => {
    mocks.connectWhatsappForOwner.mockRejectedValue(
      new Error("EAAG-business-token"),
    )
    const res = await call(connect.POST, connectBody)
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("EAAG")
  })
})
