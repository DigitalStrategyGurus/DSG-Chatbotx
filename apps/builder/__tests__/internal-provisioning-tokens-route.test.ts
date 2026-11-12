// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const SECRET = "s".repeat(40)
const PLAINTEXT_TOKEN = "cbx_ws_plaintext-only-in-the-response"

const mocks = vi.hoisted(() => ({
  env: { CHATBOTX_PROVISIONING_SECRET: undefined as string | undefined },
  issueWorkspaceToken: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock("@/env", () => ({ env: mocks.env }))

vi.mock("@/lib/log", () => ({ logger: mocks.logger }))

vi.mock("@chatbotx.io/business", () => ({
  provisioningService: { issueWorkspaceToken: mocks.issueWorkspaceToken },
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

const { POST, GET, HEAD, PUT, PATCH, DELETE, OPTIONS } = await import(
  "@/app/internal/provisioning/workspaces/[workspaceId]/tokens/route"
)
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
  options: {
    bearer?: string | null
    rawBody?: string
    workspaceId?: string
  } = {},
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
    { params: Promise.resolve({ workspaceId: options.workspaceId ?? "123" }) },
  )
}

const allLogPayloads = () =>
  JSON.stringify([
    ...mocks.logger.error.mock.calls,
    ...mocks.logger.warn.mock.calls,
    ...mocks.logger.info.mock.calls,
  ])

const expectNoProvisioningSideEffects = () => {
  expect(mocks.issueWorkspaceToken).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.env.CHATBOTX_PROVISIONING_SECRET = SECRET
  mocks.issueWorkspaceToken.mockResolvedValue({
    kind: "created",
    workspaceId: "123",
    ownerId: "user-1",
    ownerCreated: true,
    token: PLAINTEXT_TOKEN,
  })
})

const check = async (response: Response, status: number, body: unknown) => {
  expect(response.status).toBe(status)
  expect(response.headers.get("Cache-Control")).toBe("no-store")
  expect(await response.json()).toEqual(body)
}

describe("provisioning token recovery route", () => {
  test.each([
    undefined,
    "",
    "short",
    " ".repeat(40),
  ])("disabled secret %s", async (secret) => {
    mocks.env.CHATBOTX_PROVISIONING_SECRET = secret
    await check(await post(validBody), 503, { error: "provisioning_disabled" })
    expectNoProvisioningSideEffects()
  })
  test.each([null, "wrong"])("rejects bearer %s", async (bearer) => {
    await check(await post(validBody, { bearer }), 401, {
      error: "unauthorized",
    })
    expectNoProvisioningSideEffects()
  })
  test.each([
    {},
    { ...validBody, ownerEmail: "bad" },
    { ...validBody, scopes: [] },
    { ...validBody, scopes: ["unknown"] },
    { ...validBody, tokenName: "" },
    { ...validBody, tokenName: "x".repeat(101) },
    { ...validBody, permission: "admin" },
  ])("rejects invalid body %j", async (body) => {
    await check(await post(body), 400, { error: "invalid_body" })
    expectNoProvisioningSideEffects()
  })
  test.each([
    "abc",
    "0",
    "-1",
    "1.5",
    "9223372036854775808",
  ])("invalid workspace id %s", async (workspaceId) => {
    await check(await post(validBody, { workspaceId }), 400, {
      error: "invalid_workspace_id",
    })
    expectNoProvisioningSideEffects()
  })
  test("invalid JSON", async () => {
    await check(await post(validBody, { rawBody: "{" }), 400, {
      error: "invalid_json",
    })
  })
  test("uniform 404", async () => {
    mocks.issueWorkspaceToken.mockResolvedValue({ kind: "not_found" })
    await check(await post(validBody), 404, { error: "workspace_not_found" })
  })
  test("201 returns token once and passes normalized fields with default permission", async () => {
    await check(await post(validBody), 201, {
      workspaceId: "123",
      token: PLAINTEXT_TOKEN,
    })
    expect(mocks.issueWorkspaceToken).toHaveBeenCalledWith({
      actorId: "system",
      workspaceId: "123",
      ownerEmail: "owner@clinic.example",
      token: {
        name: "odaveth",
        permission: "full",
        scopes: ["contacts", "inbox"],
      },
    })
    expect(allLogPayloads()).not.toContain(PLAINTEXT_TOKEN)
  })
  test("all scopes become null and read_only is forwarded", async () => {
    await post({ ...validBody, scopes: "all", permission: "read_only" })
    expect(mocks.issueWorkspaceToken).toHaveBeenCalledWith(
      expect.objectContaining({
        token: { name: "odaveth", scopes: null, permission: "read_only" },
      }),
    )
  })
  test.each([
    GET,
    HEAD,
    PUT,
    PATCH,
    DELETE,
    OPTIONS,
  ])("unsupported method has 405 and no-store", (handler) => {
    const response = handler()
    expect(response.status).toBe(405)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(response.headers.get("Allow")).toBe("POST")
  })
  test("token cap keeps the existing domain status without credentials", async () => {
    mocks.issueWorkspaceToken.mockRejectedValue(
      new ChatbotXException("cap reached", "workspaceApiTokenLimitReached"),
    )
    await check(await post(validBody), 400, {
      error: "workspaceApiTokenLimitReached",
    })
  })
  test("failure has no token in response, console or logger", async () => {
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "info"),
    ]
    try {
      mocks.issueWorkspaceToken.mockRejectedValue(new Error(PLAINTEXT_TOKEN))
      await check(await post(validBody), 500, { error: "system_error" })
      expect(allLogPayloads()).not.toContain(PLAINTEXT_TOKEN)
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled()
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore()
      }
    }
  })
})
