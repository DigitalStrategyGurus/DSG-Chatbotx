/**
 * DSG forkpatch 7: inbound channel messages forwarded to Unibox.
 */
import type { MessageReceivedPayload } from "@chatbotx.io/event-bus"
import { verifyApiSignature } from "@chatbotx.io/integration-api/lib/signature"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  addBulk: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock("@chatbotx.io/worker-config", () => ({
  WebhookJobAction: {
    evaluateWebhooks: "evaluateWebhooks",
    forwardInbound: "forwardInbound",
  },
  webhookQueue: { addBulk: mocks.addBulk },
}))
vi.mock("@chatbotx.io/business", () => ({
  contactInboxService: { findManyByIds: vi.fn() },
  messageService: { findByIdWithUrls: vi.fn() },
}))
vi.mock("../src/env", () => ({ env: {} }))
vi.mock("../src/lib/logger", () => ({ logger: mocks.logger }))

const { resolveInboundForwardConfig } = await import(
  "../src/events/message/handlers/forward-inbound-config"
)
const { enqueueInboundForwards, inboundForwardJobId } = await import(
  "../src/events/message/handlers/forward-inbound"
)
const { forwardInboundMessage } = await import(
  "../src/webhook/services/forward-inbound"
)

const SECRET = "s".repeat(32)
const URL_ = "https://unibox.example.test/hooks/chatbotx-inbound"
const enabledConfig = resolveInboundForwardConfig({ url: URL_, secret: SECRET })

const payload = (
  overrides: Partial<MessageReceivedPayload> = {},
): MessageReceivedPayload => ({
  workspaceId: "ws_1",
  contactId: "ct_1",
  contactInboxId: "ci_1",
  channel: "whatsapp",
  inboxId: "inb_1",
  occurredAt: new Date("2026-11-14T10:15:01.000Z"),
  origin: "inbound",
  messageId: "msg_1",
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.addBulk.mockResolvedValue([])
})

describe("resolveInboundForwardConfig (fail closed)", () => {
  test("disabled without URL", () => {
    expect(resolveInboundForwardConfig({ secret: SECRET }).enabled).toBe(false)
  })

  test("disabled with a secret shorter than 32 characters", () => {
    expect(
      resolveInboundForwardConfig({ url: URL_, secret: "s".repeat(31) })
        .enabled,
    ).toBe(false)
  })

  test("disabled with a malformed or non-http URL", () => {
    expect(
      resolveInboundForwardConfig({ url: "not a url", secret: SECRET }).enabled,
    ).toBe(false)
    expect(
      resolveInboundForwardConfig({ url: "ftp://x.test", secret: SECRET })
        .enabled,
    ).toBe(false)
  })

  test("defaults to whatsapp and never includes api", () => {
    expect(enabledConfig).toMatchObject({ enabled: true })
    expect(enabledConfig.enabled && [...enabledConfig.channels]).toEqual([
      "whatsapp",
    ])

    const withApi = resolveInboundForwardConfig({
      url: URL_,
      secret: SECRET,
      channels: " WhatsApp, api ,instagram",
    })
    expect(withApi.enabled && [...withApi.channels]).toEqual([
      "whatsapp",
      "instagram",
    ])
  })

  test("only api configured disables forwarding", () => {
    expect(
      resolveInboundForwardConfig({
        url: URL_,
        secret: SECRET,
        channels: "api",
      }).enabled,
    ).toBe(false)
  })
})

describe("enqueueInboundForwards (listener)", () => {
  test("enqueues an inbound whatsapp message with a stable job id", async () => {
    await enqueueInboundForwards([payload()], enabledConfig)

    expect(mocks.addBulk).toHaveBeenCalledTimes(1)
    const [jobs] = mocks.addBulk.mock.calls[0]
    expect(jobs).toHaveLength(1)
    expect(jobs[0].opts.jobId).toBe("chatbotx-inbound-msg_1")
    expect(jobs[0].opts.jobId).toBe(inboundForwardJobId("msg_1"))
    expect(jobs[0].opts.attempts).toBe(5)
    expect(jobs[0].data).toEqual({
      type: "forwardInbound",
      data: {
        workspaceId: "ws_1",
        channel: "whatsapp",
        inboxId: "inb_1",
        messageId: "msg_1",
        messageCreatedAt: "2026-11-14T10:15:01.000Z",
      },
    })
  })

  test("accepts occurredAt as an ISO string (event bus JSON round trip)", async () => {
    await enqueueInboundForwards(
      [
        payload({
          occurredAt: "2026-11-14T10:15:01.000Z" as unknown as Date,
        }),
      ],
      enabledConfig,
    )
    expect(mocks.addBulk.mock.calls[0][0][0].data.data.messageCreatedAt).toBe(
      "2026-11-14T10:15:01.000Z",
    )
  })

  test("does not forward the api channel", async () => {
    await enqueueInboundForwards([payload({ channel: "api" })], enabledConfig)
    expect(mocks.addBulk).not.toHaveBeenCalled()
  })

  test("skips echoes, status events and payloads without messageId", async () => {
    await enqueueInboundForwards(
      [
        payload({ origin: undefined }),
        payload({ messageId: undefined }),
        payload({ channel: "messenger" }),
      ],
      enabledConfig,
    )
    expect(mocks.addBulk).not.toHaveBeenCalled()
  })

  test("does nothing when disabled (fail closed)", async () => {
    await enqueueInboundForwards([payload()], resolveInboundForwardConfig({}))
    expect(mocks.addBulk).not.toHaveBeenCalled()
  })

  test("an enqueue failure is logged, never thrown", async () => {
    mocks.addBulk.mockRejectedValueOnce(new Error("redis down"))
    await expect(
      enqueueInboundForwards([payload()], enabledConfig),
    ).resolves.toBeUndefined()
    expect(mocks.logger.error).toHaveBeenCalledTimes(1)
  })
})

describe("forwardInboundMessage (job)", () => {
  const jobData = {
    workspaceId: "ws_1",
    channel: "whatsapp",
    inboxId: "inb_1",
    messageId: "msg_1",
    messageCreatedAt: "2026-11-14T10:15:01.000Z",
  }

  const storedMessage = {
    id: "msg_1",
    type: "message",
    messageType: "incoming",
    contentType: "text",
    text: "Hola, quiero pedir cita",
    sourceId: "wamid.1",
    conversationId: "cv_1",
    contactInboxId: "ci_1",
    attachments: [],
    contentAttributes: {},
    createdAt: new Date("2026-11-14T10:15:01.000Z"),
  }

  const makeDeps = (
    response: Response | Error = new Response(null, { status: 202 }),
    message: Record<string, unknown> = storedMessage,
  ) => {
    const fetchImpl = vi.fn(() =>
      response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response),
    )
    return {
      fetchImpl,
      deps: {
        loadMessage: vi.fn().mockResolvedValue(message),
        loadContactInboxes: vi
          .fn()
          .mockResolvedValue([
            { id: "ci_1", contactId: "ct_1", sourceId: "34600000000" },
          ]),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => new Date("2026-11-14T10:15:02.000Z"),
      },
    }
  }

  test("posts a signed envelope with a stable delivery id", async () => {
    const { deps, fetchImpl } = makeDeps()

    await expect(
      forwardInboundMessage(jobData, enabledConfig, deps as any),
    ).resolves.toBe("sent")

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit & { headers: Record<string, string>; body: string },
    ]
    expect(url).toBe(URL_)
    expect(init.headers["X-ChatbotX-Delivery"]).toBe("msg_1")
    const signature = init.headers["X-ChatbotX-Signature"].replace(
      "sha256=",
      "",
    )
    await expect(
      verifyApiSignature(
        SECRET,
        init.headers["X-ChatbotX-Timestamp"],
        init.body,
        signature,
      ),
    ).resolves.toBe(true)

    expect(JSON.parse(init.body)).toEqual({
      event: "message_created",
      timestamp: "2026-11-14T10:15:02.000Z",
      workspaceId: "ws_1",
      channel: "whatsapp",
      inboxId: "inb_1",
      contact: { id: "ct_1", sourceId: "34600000000" },
      conversation: { id: "cv_1" },
      message: {
        id: "msg_1",
        sourceId: "wamid.1",
        text: "Hola, quiero pedir cita",
        messageType: "incoming",
        contentType: "text",
        attachments: [],
        contentAttributes: {},
        createdAt: "2026-11-14T10:15:01.000Z",
      },
    })
  })

  test("never logs message text or phone numbers", async () => {
    const { deps } = makeDeps()
    await forwardInboundMessage(jobData, enabledConfig, deps as any)
    const logged = JSON.stringify([
      ...mocks.logger.info.mock.calls,
      ...mocks.logger.warn.mock.calls,
    ])
    expect(logged).not.toContain("Hola")
    expect(logged).not.toContain("34600000000")
  })

  test("skips a post comment", async () => {
    const { deps, fetchImpl } = makeDeps(undefined, {
      ...storedMessage,
      type: "comment",
    })
    await expect(
      forwardInboundMessage(jobData, enabledConfig, deps as any),
    ).resolves.toBe("skipped")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test("skips when forwarding was switched off after enqueue", async () => {
    const { deps, fetchImpl } = makeDeps()
    await expect(
      forwardInboundMessage(
        jobData,
        resolveInboundForwardConfig({}),
        deps as any,
      ),
    ).resolves.toBe("skipped")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test("a 5xx or network error throws so BullMQ retries", async () => {
    const server = makeDeps(new Response(null, { status: 503 }))
    await expect(
      forwardInboundMessage(jobData, enabledConfig, server.deps as any),
    ).rejects.toThrow("HTTP 503")

    const network = makeDeps(new Error("ECONNREFUSED"))
    await expect(
      forwardInboundMessage(jobData, enabledConfig, network.deps as any),
    ).rejects.toThrow("ECONNREFUSED")
  })

  test("a 4xx is unrecoverable (no retry)", async () => {
    const { deps } = makeDeps(new Response(null, { status: 404 }))
    await expect(
      forwardInboundMessage(jobData, enabledConfig, deps as any),
    ).rejects.toMatchObject({ name: "UnrecoverableError" })
  })
})
