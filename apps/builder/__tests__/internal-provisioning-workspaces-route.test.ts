// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const SECRET = "s".repeat(40)
const PLAINTEXT_TOKEN = "cbx_ws_plaintext-only-in-the-response"

const mocks = vi.hoisted(() => ({
  env: { CHATBOTX_PROVISIONING_SECRET: undefined as string | undefined },
  provisionWorkspace: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock("@/env", () => ({ env: mocks.env }))

vi.mock("@/lib/log", () => ({ logger: mocks.logger }))

vi.mock("@chatbotx.io/business", () => ({
  provisioningService: { provisionWorkspace: mocks.provisionWorkspace },
}))

vi.mock("@chatbotx.io/business/audit", () => ({ SYSTEM_ACTOR: "system" }))

vi.mock("@chatbotx.io/business/errors", () => ({
  ChatbotXException: class ChatbotXException extends Error {
    code: string
    httpStatusCode: number
    constructor(message: string, code = "systemError", httpStatusCode = 400) {
      super(message)
      this.code = code
      this.httpStatusCode = httpStatusCode
    }
  },
}))

vi.mock("@chatbotx.io/database/client", () => ({
  toLoggableDatabaseError: (error: unknown) => error,
}))

const { POST } = await import("@/app/internal/provisioning/workspaces/route")
const { ChatbotXException } = await import("@chatbotx.io/business/errors")

const validBody = {
  ownerEmail: "Owner@Clinic.example",
  ownerName: "Clinic Owner",
  workspaceName: "Clinic Montgo",
  tokenName: "odaveth",
  scopes: ["contacts", "inbox"],
}

const post = (
  body: unknown,
  options: { bearer?: string | null; rawBody?: string } = {},
) => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  }
  const bearer = options.bearer === undefined ? SECRET : options.bearer
  if (bearer !== null) {
    headers.Authorization = `Bearer ${bearer}`
  }
  return POST(
    new Request("http://builder.internal/internal/provisioning/workspaces", {
      method: "POST",
      headers,
      body: options.rawBody ?? JSON.stringify(body),
    }),
  )
}

const allLogPayloads = () =>
  JSON.stringify([
    ...mocks.logger.error.mock.calls,
    ...mocks.logger.warn.mock.calls,
    ...mocks.logger.info.mock.calls,
  ])

const expectNoProvisioningSideEffects = () => {
  expect(mocks.provisionWorkspace).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.env.CHATBOTX_PROVISIONING_SECRET = SECRET
  mocks.provisionWorkspace.mockResolvedValue({
    kind: "created",
    workspaceId: "ws-1",
    ownerId: "user-1",
    ownerCreated: true,
    token: PLAINTEXT_TOKEN,
  })
})

describe("fail closed without a configured secret", () => {
  test("503 when the env is unset, even with a bearer that would otherwise match", async () => {
    mocks.env.CHATBOTX_PROVISIONING_SECRET = undefined

    const response = await post(validBody)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "provisioning_disabled" })
    expectNoProvisioningSideEffects()
  })

  test("503 when the env is empty or too short", async () => {
    mocks.env.CHATBOTX_PROVISIONING_SECRET = ""
    expect((await post(validBody, { bearer: "" })).status).toBe(503)

    mocks.env.CHATBOTX_PROVISIONING_SECRET = "short"
    expect((await post(validBody, { bearer: "short" })).status).toBe(503)
    expectNoProvisioningSideEffects()
  })
})

describe("bearer authentication", () => {
  test("401 without an Authorization header", async () => {
    const response = await post(validBody, { bearer: null })

    expect(response.status).toBe(401)
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer")
    expectNoProvisioningSideEffects()
  })

  test("401 with a wrong secret, also when it differs only in length", async () => {
    expect((await post(validBody, { bearer: "x".repeat(40) })).status).toBe(401)
    expect((await post(validBody, { bearer: SECRET.slice(1) })).status).toBe(
      401,
    )
    expect((await post(validBody, { bearer: `${SECRET}x` })).status).toBe(401)
    expectNoProvisioningSideEffects()
  })
})

describe("body validation", () => {
  test("400 on malformed JSON", async () => {
    const response = await post(null, { rawBody: "{not json" })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_json" })
    expectNoProvisioningSideEffects()
  })

  test("400 on a missing field, a bad email, an unknown scope and an empty scope list", async () => {
    const { tokenName: _omitted, ...withoutTokenName } = validBody
    const cases = [
      withoutTokenName,
      { ...validBody, ownerEmail: "not-an-email" },
      { ...validBody, scopes: ["contacts", "nope"] },
      { ...validBody, scopes: [] },
    ]
    for (const body of cases) {
      const response = await post(body)
      expect(response.status).toBe(400)
      const payload = await response.json()
      expect(payload.error).toBe("invalid_body")
      expect(payload.issues.length).toBeGreaterThan(0)
    }
    expectNoProvisioningSideEffects()
  })
})

describe("happy path", () => {
  test("201 with workspaceId, ownerId and the plaintext token exactly once", async () => {
    const response = await post(validBody)

    expect(response.status).toBe(201)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    // Exactly these three fields: `ownerCreated` stays internal.
    expect(await response.json()).toEqual({
      workspaceId: "ws-1",
      ownerId: "user-1",
      token: PLAINTEXT_TOKEN,
    })

    // Normalised email, the owner's name, and the system actor for the audit
    // record all reach the service.
    expect(mocks.provisionWorkspace).toHaveBeenCalledTimes(1)
    expect(mocks.provisionWorkspace).toHaveBeenCalledWith({
      actorId: "system",
      ownerEmail: "owner@clinic.example",
      ownerName: "Clinic Owner",
      workspaceName: "Clinic Montgo",
      token: {
        name: "odaveth",
        permission: "full",
        scopes: ["contacts", "inbox"],
      },
    })

    // Neither the bearer secret nor the minted token reaches the logs.
    expect(allLogPayloads()).not.toContain(PLAINTEXT_TOKEN)
    expect(allLogPayloads()).not.toContain(SECRET)
  })

  test('scopes "all" becomes null (unrestricted), read_only permission is passed through', async () => {
    const response = await post({
      ...validBody,
      scopes: "all",
      permission: "read_only",
    })

    expect(response.status).toBe(201)
    expect(mocks.provisionWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        token: { name: "odaveth", permission: "read_only", scopes: null },
      }),
    )
  })
})

describe("idempotency on ownerEmail", () => {
  test("409 with the existing workspaceId and no token when the service reports a conflict", async () => {
    mocks.provisionWorkspace.mockResolvedValue({
      kind: "conflict",
      workspaceId: "ws-existing",
    })

    const response = await post(validBody)

    expect(response.status).toBe(409)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(await response.json()).toEqual({
      error: "owner_already_has_workspace",
      workspaceId: "ws-existing",
    })
  })

  test("a second call after a successful first call answers 409 without a token", async () => {
    const first = await post(validBody)
    expect(first.status).toBe(201)

    // The first call committed the owner and workspace rows.
    mocks.provisionWorkspace.mockResolvedValue({
      kind: "conflict",
      workspaceId: "ws-1",
    })

    const second = await post(validBody)

    expect(second.status).toBe(409)
    const payload = await second.json()
    expect(payload).toEqual({
      error: "owner_already_has_workspace",
      workspaceId: "ws-1",
    })
    expect(JSON.stringify(payload)).not.toContain(PLAINTEXT_TOKEN)
  })
})

describe("failures", () => {
  test("a domain refusal keeps its code and status", async () => {
    mocks.provisionWorkspace.mockRejectedValue(
      new ChatbotXException("Team member limit reached", "teamMembersLimit"),
    )

    const response = await post(validBody)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "teamMembersLimit",
      message: "Team member limit reached",
    })
  })

  test("any other failure answers 500 system_error without a workspaceId or token, and logs no secret", async () => {
    mocks.provisionWorkspace.mockRejectedValue(new Error("db down"))

    const response = await post(validBody)

    expect(response.status).toBe(500)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(await response.json()).toEqual({ error: "system_error" })
    expect(mocks.logger.error).toHaveBeenCalledTimes(1)
    expect(allLogPayloads()).not.toContain(PLAINTEXT_TOKEN)
    expect(allLogPayloads()).not.toContain(SECRET)
    expect(allLogPayloads()).not.toContain("owner@clinic.example")
  })
})
