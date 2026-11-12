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
  workspaceRepository: { lockFirstWorkspace: mocks.lockFirstWorkspace },
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
  workspaceMemberCacheTag: (userId: string) => `member:${userId}`,
  workspaceRosterCacheTag: (workspaceId: string) => `roster:${workspaceId}`,
}))

const { provisioningService } = await import("../src/provisioning/service")
const { ChatbotXException } = await import("../src/errors")

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

describe("provisioningService.provisionWorkspace — owner account", () => {
  test("creates the owner in the root tenant with the given name and only the hash of a random password", async () => {
    const result = await provisioningService.provisionWorkspace(createInput())

    expect(mocks.findIdByEmail).toHaveBeenCalledWith({
      email: "owner@clinic.example",
      tenantId: "1",
    })
    expect(mocks.generateRandomString).toHaveBeenCalledWith(
      64,
      "a-z",
      "A-Z",
      "0-9",
    )
    const plaintextPassword = "p".repeat(64)
    expect(mocks.hashPassword).toHaveBeenCalledWith(plaintextPassword)
    expect(mocks.insertWithCredential).toHaveBeenCalledTimes(1)
    expect(mocks.insertWithCredential).toHaveBeenCalledWith({
      email: "owner@clinic.example",
      name: "Clinic Owner",
      hashedPassword: HASHED_PASSWORD,
      tenantId: "1",
    })
    expect(mocks.ensureBootstrapPlan).toHaveBeenCalledWith({
      userId: "owner-1",
      tenantId: "1",
    })

    // The plaintext exists only between generation and hashing.
    expect(JSON.stringify(result)).not.toContain(plaintextPassword)
    const outsideHashing = JSON.stringify([
      mocks.insertWithCredential.mock.calls,
      mocks.dispatchAuditRecordSafely.mock.calls,
      mocks.create.mock.calls,
      mocks.createToken.mock.calls,
      mocks.logger.warn.mock.calls,
      mocks.logger.error.mock.calls,
    ])
    expect(outsideHashing).not.toContain(plaintextPassword)
  })

  test("sends no mail and does not go through the mailing provisioning helper", async () => {
    await provisioningService.provisionWorkspace(createInput())

    expect(mocks.sendAccountCredentials).not.toHaveBeenCalled()
    expect(mocks.findOrProvisionRootUser).not.toHaveBeenCalled()
  })

  test("refuses a reserved placeholder address before writing anything", async () => {
    const attempt = provisioningService.provisionWorkspace(
      createInput({ ownerEmail: "fb-123@facebook.placeholder.invalid" }),
    )

    await expect(attempt).rejects.toMatchObject({
      code: "invalidEmail",
      httpStatusCode: 400,
    })
    expect(mocks.insertWithCredential).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  test("an account that already exists without a workspace is reused: no insert, name untouched, workspace and token created", async () => {
    mocks.findIdByEmail.mockResolvedValue({ id: "owner-existing" })
    mocks.create.mockResolvedValue({ id: "ws-2", ownerId: "owner-existing" })

    const result = await provisioningService.provisionWorkspace(createInput())

    expect(mocks.insertWithCredential).not.toHaveBeenCalled()
    expect(mocks.hashPassword).not.toHaveBeenCalled()
    // Repairs a run that died between the insert and the plan stamp.
    expect(mocks.ensureBootstrapPlan).toHaveBeenCalledWith({
      userId: "owner-existing",
      tenantId: "1",
    })
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          name: "Clinic Montgo",
          ownerId: "owner-existing",
          tenantId: "1",
        },
        createdBy: "owner-existing",
      }),
    )
    expect(mocks.createToken).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      kind: "created",
      workspaceId: "ws-2",
      ownerId: "owner-existing",
      ownerCreated: false,
      token: PLAINTEXT_TOKEN,
    })
  })

  test("losing the insert race to a concurrent call continues with the winner's account", async () => {
    mocks.insertWithCredential.mockResolvedValue({
      userId: "owner-raced",
      created: false,
    })

    const result = await provisioningService.provisionWorkspace(createInput())

    expect(result).toMatchObject({
      kind: "created",
      ownerId: "owner-raced",
      ownerCreated: false,
    })
  })
})

describe("provisioningService.provisionWorkspace — one transaction for workspace, membership and token", () => {
  test("locks, re-checks, creates the workspace and mints the token on the same transaction", async () => {
    const result = await provisioningService.provisionWorkspace(createInput())

    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.lockFirstWorkspace).toHaveBeenCalledWith(
      { ownerId: "owner-1" },
      TX,
    )
    expect(mocks.findActiveByOwner).toHaveBeenLastCalledWith({
      ownerId: "owner-1",
      tx: TX,
    })
    expect(mocks.create).toHaveBeenCalledWith({
      data: { name: "Clinic Montgo", ownerId: "owner-1", tenantId: "1" },
      createdBy: "owner-1",
      tx: TX,
      quotaConsumption: expect.any(Object),
    })
    expect(mocks.createToken).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      name: "odaveth",
      permission: "full",
      tokenHash: TOKEN_HASH,
      tokenPrefix: "cbx_ws_plain",
      scopes: ["contacts", "inbox"],
      tx: TX,
    })

    const order = (mock: { mock: { invocationCallOrder: number[] } }) =>
      mock.mock.invocationCallOrder.at(-1) ?? 0
    expect(order(mocks.lockFirstWorkspace)).toBeLessThan(order(mocks.create))
    expect(order(mocks.create)).toBeLessThan(order(mocks.createToken))

    expect(result).toEqual({
      kind: "created",
      workspaceId: "ws-1",
      ownerId: "owner-1",
      ownerCreated: true,
      token: PLAINTEXT_TOKEN,
    })
    expect(mocks.compensateWorkspaceQuotaConsumption).not.toHaveBeenCalled()
  })

  test("resolves the tenant from the owner and passes unrestricted scopes and read_only through", async () => {
    mocks.resolveTenantForOwner.mockResolvedValue("tenant-7")

    await provisioningService.provisionWorkspace(
      createInput({
        token: { name: "odaveth", permission: "read_only", scopes: null },
      }),
    )

    expect(mocks.resolveTenantForOwner).toHaveBeenCalledWith("owner-1")
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: "tenant-7" }),
      }),
    )
    expect(mocks.createToken).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: null, permission: "read_only" }),
    )
  })

  test("a token failure rejects, hands the seat back and leaves no audit record and no token", async () => {
    const failure = new Error("token insert failed")
    mocks.createToken.mockRejectedValue(failure)
    let tracker: unknown
    mocks.create.mockImplementation(
      (props: { quotaConsumption: Record<string, unknown> }) => {
        Object.assign(props.quotaConsumption, {
          consumed: true,
          userId: "owner-1",
          workspaceId: "ws-1",
          teamMembersLiveIncrementedCount: 1,
        })
        tracker = props.quotaConsumption
        return Promise.resolve({ id: "ws-1", ownerId: "owner-1" })
      },
    )

    await expect(
      provisioningService.provisionWorkspace(createInput()),
    ).rejects.toBe(failure)

    expect(mocks.compensateWorkspaceQuotaConsumption).toHaveBeenCalledTimes(1)
    expect(mocks.compensateWorkspaceQuotaConsumption).toHaveBeenCalledWith(
      tracker,
    )
    expect(mocks.dispatchAuditRecordSafely).not.toHaveBeenCalled()
    expect(mocks.invalidateCacheByTags).not.toHaveBeenCalled()
  })

  test("a workspace failure rejects with the domain error and never reaches the token", async () => {
    const failure = new ChatbotXException("limit", "workspaceLimitReached")
    mocks.create.mockRejectedValue(failure)

    await expect(
      provisioningService.provisionWorkspace(createInput()),
    ).rejects.toBe(failure)

    expect(mocks.createToken).not.toHaveBeenCalled()
    // Nothing was tracked, so the compensation is a no-op by contract.
    expect(mocks.compensateWorkspaceQuotaConsumption).toHaveBeenCalledWith({
      consumed: false,
    })
    expect(mocks.dispatchAuditRecordSafely).not.toHaveBeenCalled()
  })
})

describe("provisioningService.provisionWorkspace — idempotency per owner", () => {
  test("an owner with a live workspace gets conflict: no transaction, no seat, no token", async () => {
    mocks.findIdByEmail.mockResolvedValue({ id: "owner-1" })
    mocks.findActiveByOwner.mockResolvedValue({ id: "ws-existing" })

    const result = await provisioningService.provisionWorkspace(createInput())

    expect(result).toEqual({ kind: "conflict", workspaceId: "ws-existing" })
    expect(mocks.insertWithCredential).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.generateWorkspaceToken).not.toHaveBeenCalled()
    expect(mocks.createToken).not.toHaveBeenCalled()
    expect(mocks.dispatchAuditRecordSafely).not.toHaveBeenCalled()
  })

  test("an existing workspace wins over a team-member quota refusal", async () => {
    mocks.findIdByEmail.mockResolvedValue({ id: "owner-1" })
    mocks.findActiveByOwner.mockResolvedValue({ id: "ws-existing" })
    mocks.hasRoomForTeamMembers.mockResolvedValue(false)

    const result = await provisioningService.provisionWorkspace(createInput())

    expect(result).toEqual({ kind: "conflict", workspaceId: "ws-existing" })
  })

  test("a call that lost the race sees the winner's workspace under the lock and gets conflict", async () => {
    mocks.findActiveByOwner
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: "ws-raced" })

    const result = await provisioningService.provisionWorkspace(createInput())

    expect(result).toEqual({ kind: "conflict", workspaceId: "ws-raced" })
    expect(mocks.lockFirstWorkspace).toHaveBeenCalledTimes(1)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.createToken).not.toHaveBeenCalled()
    expect(mocks.dispatchAuditRecordSafely).not.toHaveBeenCalled()
    expect(mocks.compensateWorkspaceQuotaConsumption).not.toHaveBeenCalled()
  })
})

describe("provisioningService.provisionWorkspace — quota", () => {
  test("asks for room for exactly the owner seat and refuses when there is none", async () => {
    mocks.hasRoomForTeamMembers.mockResolvedValue(false)

    await expect(
      provisioningService.provisionWorkspace(createInput()),
    ).rejects.toMatchObject({ code: "teamMembersLimit" })

    expect(mocks.hasRoomForTeamMembers).toHaveBeenCalledWith({
      userId: "owner-1",
      additionalCount: 1,
    })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.generateWorkspaceToken).not.toHaveBeenCalled()
  })
})

describe("provisioningService.provisionWorkspace — after the commit", () => {
  test("records one audit entry for the given actor, without token material", async () => {
    await provisioningService.provisionWorkspace(createInput())

    expect(mocks.dispatchAuditRecordSafely).toHaveBeenCalledTimes(1)
    const [record] = mocks.dispatchAuditRecordSafely.mock.calls[0] ?? []
    expect(record).toMatchObject({
      userId: "system",
      workspaceId: "ws-1",
      action: "create",
    })
    expect(record.detail).toContain("#ws-1")
    expect(record.detail).toContain("owner@clinic.example")
    expect(record.detail).toContain("(new account)")
    expect(record.detail).toContain('"odaveth"')
    expect(record.detail).toContain("scopes: contacts,inbox")
    expect(record.detail).not.toContain(PLAINTEXT_TOKEN)
    expect(record.detail).not.toContain(TOKEN_HASH)
  })

  test("busts the owner's membership and the roster cache tags again", async () => {
    await provisioningService.provisionWorkspace(createInput())

    expect(mocks.invalidateCacheByTags).toHaveBeenCalledWith([
      "member:owner-1",
      "roster:ws-1",
    ])
  })

  test("a cache failure after the commit is logged and still returns the token", async () => {
    mocks.invalidateCacheByTags.mockRejectedValue(new Error("redis down"))

    const result = await provisioningService.provisionWorkspace(createInput())

    expect(result).toMatchObject({ kind: "created", token: PLAINTEXT_TOKEN })
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1)
    expect(mocks.dispatchAuditRecordSafely).toHaveBeenCalledTimes(1)
  })

  test("the plaintext token leaves the service only through its return value", async () => {
    await provisioningService.provisionWorkspace(createInput())

    expect(everythingObserved()).not.toContain(PLAINTEXT_TOKEN)
  })
})
