import { beforeEach, describe, expect, test, vi } from "vitest"

const PLAINTEXT_TOKEN = "cbx_ws_plaintext-only-in-the-result"
const TOKEN_HASH = "hash-of-token"
const HASHED_PASSWORD = "hashed-password"
const TX = { marker: "provisioning-tx" }

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  findIdByEmail: vi.fn(),
  insertWithCredential: vi.fn(),
  lockFirstWorkspace: vi.fn(),
  findMembership: vi.fn(),
  generateRandomString: vi.fn(),
  hashPassword: vi.fn(),
  dispatchAuditRecordSafely: vi.fn(),
  invalidateCacheByTags: vi.fn(),
  hasRoomForTeamMembers: vi.fn(),
  ensureBootstrapPlan: vi.fn(),
  compensateWorkspaceQuotaConsumption: vi.fn(),
  findActiveByOwner: vi.fn(),
  resolveTenantForOwner: vi.fn(),
  create: vi.fn(),
  generateWorkspaceToken: vi.fn(),
  createToken: vi.fn(),
  findOrProvisionRootUser: vi.fn(),
  sendAccountCredentials: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock("@chatbotx.io/database/client", () => ({
  db: { transaction: mocks.transaction },
}))

vi.mock("@chatbotx.io/database/partials", () => ({
  ROOT_TENANT_ID: "1",
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  userRepository: {
    findIdByEmail: mocks.findIdByEmail,
    insertWithCredential: mocks.insertWithCredential,
  },
  workspaceRepository: {
    lockFirstWorkspace: mocks.lockFirstWorkspace,
  },
}))

vi.mock("@chatbotx.io/redis", () => ({
  invalidateCacheByTags: mocks.invalidateCacheByTags,
}))

vi.mock("better-auth/crypto", () => ({
  generateRandomString: mocks.generateRandomString,
  hashPassword: mocks.hashPassword,
}))

// Neither may be reached: this flow sends no mail.
vi.mock("@chatbotx.io/mail", () => ({
  sendAccountCredentials: mocks.sendAccountCredentials,
}))
vi.mock("../src/user/provision-root-user", () => ({
  findOrProvisionRootUser: mocks.findOrProvisionRootUser,
}))

vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn(),
  dispatchAuditRecordSafely: mocks.dispatchAuditRecordSafely,
}))

vi.mock("../src/logger", () => ({ logger: mocks.logger }))

vi.mock("../src/quota-enforcement/service", () => ({
  quotaEnforcementService: {
    hasRoomForTeamMembers: mocks.hasRoomForTeamMembers,
  },
}))

vi.mock("../src/user-quota/service", () => ({
  userQuotaService: { ensureBootstrapPlan: mocks.ensureBootstrapPlan },
}))

vi.mock("../src/workspace/quota-consumption", () => ({
  compensateWorkspaceQuotaConsumption:
    mocks.compensateWorkspaceQuotaConsumption,
}))

vi.mock("../src/workspace/service", () => ({
  workspaceService: {
    findActiveByOwner: mocks.findActiveByOwner,
    resolveTenantForOwner: mocks.resolveTenantForOwner,
    create: mocks.create,
  },
}))

vi.mock("../src/workspace-api-token/credentials", () => ({
  generateWorkspaceToken: mocks.generateWorkspaceToken,
}))

vi.mock("../src/workspace-api-token/service", () => ({
  workspaceApiTokenService: { createToken: mocks.createToken },
}))

vi.mock("../src/workspace-member/service", () => ({
  workspaceMemberService: { findMembership: mocks.findMembership },
  workspaceMemberCacheTag: (userId: string) => `member:${userId}`,
  workspaceRosterCacheTag: (workspaceId: string) => `roster:${workspaceId}`,
}))

const { provisioningService } = await import("../src/provisioning/service")

type Input = Parameters<typeof provisioningService.provisionWorkspace>[0]

function createInput(overrides?: Partial<Input>): Input {
  return {
    actorId: "system",
    ownerEmail: " Owner@Clinic.Example ",
    ownerName: " Clinic Owner ",
    workspaceName: "Clinic Montgo",
    token: {
      name: "odaveth",
      permission: "full",
      scopes: ["contacts", "inbox"],
    },
    ...overrides,
  } as Input
}

/** Every argument any mock received, plus what the logger saw. */
const everythingObserved = () =>
  JSON.stringify(
    Object.values(mocks).flatMap((mock) =>
      "mock" in mock
        ? mock.mock.calls
        : Object.values(mock).flatMap((fn) => fn.mock.calls),
    ),
  )

beforeEach(() => {
  vi.clearAllMocks()
  mocks.transaction.mockImplementation(
    async (fn: (tx: unknown) => unknown) => await fn(TX),
  )
  mocks.findIdByEmail.mockResolvedValue(undefined)
  mocks.insertWithCredential.mockResolvedValue({
    userId: "owner-1",
    created: true,
  })
  mocks.lockFirstWorkspace.mockResolvedValue(undefined)
  mocks.generateRandomString.mockImplementation((length: number) =>
    "p".repeat(length),
  )
  mocks.hashPassword.mockResolvedValue(HASHED_PASSWORD)
  mocks.dispatchAuditRecordSafely.mockResolvedValue(undefined)
  mocks.invalidateCacheByTags.mockResolvedValue(undefined)
  mocks.hasRoomForTeamMembers.mockResolvedValue(true)
  mocks.ensureBootstrapPlan.mockResolvedValue(undefined)
  mocks.compensateWorkspaceQuotaConsumption.mockResolvedValue(undefined)
  mocks.findActiveByOwner.mockResolvedValue(undefined)
  mocks.resolveTenantForOwner.mockResolvedValue("1")
  mocks.create.mockResolvedValue({ id: "ws-1", ownerId: "owner-1" })
  mocks.generateWorkspaceToken.mockResolvedValue({
    token: PLAINTEXT_TOKEN,
    tokenHash: TOKEN_HASH,
    tokenPrefix: "cbx_ws_plain",
  })
  mocks.createToken.mockResolvedValue({ id: "token-1" })
})

const issue = (token = createInput().token) =>
  provisioningService.issueWorkspaceToken({
    actorId: "system",
    workspaceId: "123",
    ownerEmail: " Owner@Clinic.Example ",
    token,
  })

beforeEach(() => {
  mocks.findIdByEmail.mockResolvedValue({ id: "owner-1" })
  mocks.findMembership.mockResolvedValue({
    role: "owner",
    workspace: {
      id: "123",
      ownerId: "owner-1",
      isActive: true,
      scheduledDeletionAt: null,
    },
  })
})

describe("provisioningService.issueWorkspaceToken", () => {
  test("owner gets an additional token, with root-tenant normalized lookup", async () => {
    expect(await issue()).toEqual({
      kind: "created",
      workspaceId: "123",
      token: PLAINTEXT_TOKEN,
    })
    expect(mocks.findIdByEmail).toHaveBeenCalledWith(
      { email: "owner@clinic.example", tenantId: "1" },
      TX,
    )
    expect(mocks.findMembership).toHaveBeenCalledWith({
      workspaceId: "123",
      userId: "owner-1",
      tx: TX,
    })
    expect(mocks.createToken).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "123",
        tokenHash: TOKEN_HASH,
        tx: TX,
      }),
    )
    expect(everythingObserved()).not.toContain(PLAINTEXT_TOKEN)
  })

  test.each([
    ["unknown workspace", undefined],
    ["inactive workspace", { id: "123", isActive: false }],
    [
      "deleted workspace",
      { id: "123", isActive: true, scheduledDeletionAt: new Date() },
    ],
    [
      "purging workspace",
      { id: "123", isActive: true, purgeStartedAt: new Date() },
    ],
  ])("%s returns not_found without creating a token", async (_name, workspace) => {
    mocks.findMembership.mockResolvedValue(
      workspace
        ? { role: "owner", workspace: { ownerId: "owner-1", ...workspace } }
        : undefined,
    )
    expect(await issue()).toEqual({ kind: "not_found" })
    expect(mocks.createToken).not.toHaveBeenCalled()
    expect(mocks.dispatchAuditRecordSafely).not.toHaveBeenCalled()
  })

  test("a regular member cannot issue a token", async () => {
    mocks.findMembership.mockResolvedValue({
      role: "agent",
      workspace: { id: "123", ownerId: "other-owner", isActive: true },
    })
    expect(await issue()).toEqual({ kind: "not_found" })
    expect(mocks.createToken).not.toHaveBeenCalled()
  })

  test("unknown user returns the same not_found", async () => {
    mocks.findIdByEmail.mockResolvedValue(undefined)
    expect(await issue()).toEqual({ kind: "not_found" })
    expect(mocks.createToken).not.toHaveBeenCalled()
  })

  test("unrestricted scopes and read_only are passed unchanged", async () => {
    await issue({ name: "recovery", permission: "read_only", scopes: null })
    expect(mocks.createToken).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "recovery",
        scopes: null,
        permission: "read_only",
      }),
    )
  })

  test("audit happens only after commit with system actor and no credential", async () => {
    let committed = false
    mocks.transaction.mockImplementation(async (fn) => {
      const result = await fn(TX)
      expect(mocks.dispatchAuditRecordSafely).not.toHaveBeenCalled()
      committed = true
      return result
    })
    mocks.dispatchAuditRecordSafely.mockImplementation(() => {
      expect(committed).toBe(true)
    })
    await issue()
    expect(mocks.dispatchAuditRecordSafely).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "system", workspaceId: "123" }),
      expect.any(String),
    )
    expect(everythingObserved()).not.toContain(PLAINTEXT_TOKEN)
  })

  test("createToken failure rejects without a token or audit", async () => {
    mocks.createToken.mockRejectedValueOnce(new Error("insert failed"))
    await expect(issue()).rejects.toThrow("insert failed")
    expect(mocks.dispatchAuditRecordSafely).not.toHaveBeenCalled()
    expect(everythingObserved()).not.toContain(PLAINTEXT_TOKEN)
  })
})
