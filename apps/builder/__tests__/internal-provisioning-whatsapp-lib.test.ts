// @vitest-environment node
// DSG forkpatch 6: connect logic behind the internal WhatsApp routes.
import { beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  findWorkspace: vi.fn(),
  resolveForOwner: vi.fn(),
  findByPhone: vi.fn(),
  exchangeAccessToken: vi.fn(),
  connectWhatsappNumber: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  workspaceService: { find: mocks.findWorkspace },
  platformCredentialService: { resolveForOwner: mocks.resolveForOwner },
  integrationWhatsappService: {
    findByPhoneNumberIdForWorkspace: mocks.findByPhone,
  },
}))

vi.mock("@chatbotx.io/integration-whatsapp/api/auth", () => ({
  exchangeAccessToken: mocks.exchangeAccessToken,
}))

vi.mock("@chatbotx.io/integration-whatsapp/exception", () => ({
  WhatsappException: class WhatsappException extends Error {
    httpStatusCode: number | undefined
    constructor(message: string, httpStatusCode?: number) {
      super(message)
      this.httpStatusCode = httpStatusCode
    }
  },
}))

vi.mock("@/features/integration-whatsapp/actions/connect-number", () => ({
  connectWhatsappNumber: mocks.connectWhatsappNumber,
}))

vi.mock("@/features/integration-whatsapp/schema", () => ({
  CONNECT_WHATSAPP_RESULT_TYPES: {
    CONNECTED: "connected",
    PHONE_NUMBER_SELECTION: "phoneNumberSelection",
  },
}))

const { exchangeWhatsappCode, connectWhatsappForOwner } = await import(
  "@/features/provisioning/lib/whatsapp-connect"
)
const { WhatsappException } = await import(
  "@chatbotx.io/integration-whatsapp/exception"
)

const request = {
  accessToken: "EAAG-token",
  wabaId: "111",
  phoneNumberId: "222",
  businessId: "333",
  coexistence: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findWorkspace.mockResolvedValue({ id: "123", ownerId: "owner_1" })
  mocks.resolveForOwner.mockResolvedValue({
    config: { clientId: "app", clientSecret: "secret", version: "v23.0" },
  })
})

describe("exchangeWhatsappCode (6a)", () => {
  test("exchanges with the owner's credential and without a redirect_uri", async () => {
    mocks.exchangeAccessToken.mockResolvedValue({ access_token: "EAAG-token" })
    const result = await exchangeWhatsappCode({ workspaceId: "123", code: "c" })
    expect(result).toEqual({ kind: "exchanged", accessToken: "EAAG-token" })
    expect(mocks.resolveForOwner).toHaveBeenCalledWith({
      ownerId: "owner_1",
      type: "whatsapp",
    })
    expect(mocks.exchangeAccessToken).toHaveBeenCalledTimes(1)
    expect(mocks.exchangeAccessToken.mock.calls[0]).toHaveLength(2)
  })

  test("unknown workspace", async () => {
    mocks.findWorkspace.mockResolvedValue(null)
    expect(await exchangeWhatsappCode({ workspaceId: "9", code: "c" })).toEqual(
      {
        kind: "not_found",
      },
    )
    expect(mocks.exchangeAccessToken).not.toHaveBeenCalled()
  })

  test("no WhatsApp credential", async () => {
    mocks.resolveForOwner.mockResolvedValue(null)
    expect(
      await exchangeWhatsappCode({ workspaceId: "123", code: "c" }),
    ).toEqual({
      kind: "credential_missing",
    })
  })

  test("a 4xx from Meta is a rejection, anything else is unavailable", async () => {
    mocks.exchangeAccessToken.mockRejectedValueOnce(
      new WhatsappException("bad", 400),
    )
    expect(
      await exchangeWhatsappCode({ workspaceId: "123", code: "c" }),
    ).toEqual({
      kind: "rejected",
      metaStatus: 400,
    })
    mocks.exchangeAccessToken.mockRejectedValueOnce(
      new WhatsappException("down", 503),
    )
    expect(
      await exchangeWhatsappCode({ workspaceId: "123", code: "c" }),
    ).toEqual({
      kind: "unavailable",
    })
    mocks.exchangeAccessToken.mockRejectedValueOnce(new Error("socket"))
    expect(
      await exchangeWhatsappCode({ workspaceId: "123", code: "c" }),
    ).toEqual({
      kind: "unavailable",
    })
  })
})

describe("connectWhatsappForOwner (6b)", () => {
  test("acts as the workspace owner and maps coexistence to connectExisting", async () => {
    mocks.connectWhatsappNumber.mockResolvedValue({
      type: "connected",
      workspaceId: "123",
      isManual: false,
      redirectUrl: "/space/123",
      outcome: {
        sourceId: "222",
        name: "Clinic",
        status: "connected",
        integrationId: "int_1",
        coexistEligible: true,
        warning: undefined,
        extra: {
          displayPhoneNumber: "+34 600",
          requiresPhoneVerification: true,
        },
      },
    })
    const result = await connectWhatsappForOwner({
      workspaceId: "123",
      request: { ...request, coexistence: true },
    })
    expect(mocks.connectWhatsappNumber).toHaveBeenCalledWith({
      userId: "owner_1",
      input: expect.objectContaining({
        workspaceId: "123",
        accessToken: "EAAG-token",
        phoneNumberId: "222",
        wabaId: "111",
        businessId: "333",
        connectExisting: true,
        manualConnect: false,
        transferPhoneNumber: false,
      }),
    })
    expect(
      mocks.connectWhatsappNumber.mock.calls[0][0].input,
    ).not.toHaveProperty("code")
    expect(result).toMatchObject({
      kind: "connected",
      alreadyConnected: false,
      integrationId: "int_1",
      coexist: true,
      requiresPhoneVerification: true,
    })
  })

  test("a retry after a connect that landed returns the existing integration", async () => {
    mocks.connectWhatsappNumber.mockResolvedValue({
      kind: "outcome",
      outcome: { sourceId: "222", name: "222", status: "duplicated" },
    })
    mocks.findByPhone.mockResolvedValue({ id: "int_1", phoneNumberId: "222" })
    const result = await connectWhatsappForOwner({
      workspaceId: "123",
      request,
    })
    expect(mocks.findByPhone).toHaveBeenCalledWith({
      phoneNumberId: "222",
      workspaceId: "123",
    })
    expect(result).toMatchObject({
      kind: "connected",
      alreadyConnected: true,
      integrationId: "int_1",
    })
  })

  test("a number held by another workspace is a conflict", async () => {
    mocks.connectWhatsappNumber.mockResolvedValue({
      kind: "outcome",
      outcome: { sourceId: "222", name: "222", status: "duplicated" },
    })
    mocks.findByPhone.mockResolvedValue(null)
    expect(
      await connectWhatsappForOwner({ workspaceId: "123", request }),
    ).toEqual({
      kind: "in_other_workspace",
    })
  })

  test("session errors and picker results are rejections", async () => {
    mocks.connectWhatsappNumber.mockResolvedValueOnce({
      kind: "sessionError",
      code: "credentialMissing",
    })
    expect(
      await connectWhatsappForOwner({ workspaceId: "123", request }),
    ).toEqual({
      kind: "rejected",
      reason: "credentialMissing",
    })
    mocks.connectWhatsappNumber.mockResolvedValueOnce({
      type: "phoneNumberSelection",
    })
    expect(
      await connectWhatsappForOwner({ workspaceId: "123", request }),
    ).toEqual({
      kind: "rejected",
      reason: "phoneNumberSelection",
    })
  })

  test.each([
    ["providerRejected", "rejected"],
    ["notSelectable", "rejected"],
    ["channelLimit", "rejected"],
    ["workspaceLimit", "rejected"],
    ["providerUnavailable", "retryable"],
    ["inProgress", "retryable"],
    ["internalError", "retryable"],
    ["unknown", "retryable"],
    [undefined, "retryable"],
  ])("failed outcome %s is %s", async (reason, kind) => {
    mocks.connectWhatsappNumber.mockResolvedValue({
      kind: "outcome",
      outcome: { sourceId: "222", name: "222", status: "failed", reason },
    })
    expect(
      await connectWhatsappForOwner({ workspaceId: "123", request }),
    ).toEqual({
      kind,
      reason: reason ?? "unknown",
    })
  })

  test("unknown workspace never reaches the connect flow", async () => {
    mocks.findWorkspace.mockResolvedValue(null)
    expect(
      await connectWhatsappForOwner({ workspaceId: "9", request }),
    ).toEqual({
      kind: "not_found",
    })
    expect(mocks.connectWhatsappNumber).not.toHaveBeenCalled()
  })
})
