/**
 * DSG forkpatch 7: the `forwardInbound` webhook-queue job. Loads the message,
 * builds the same `message_created` envelope the API-channel callback uses
 * (plus workspaceId/channel/inboxId), signs it with the API-channel scheme and
 * POSTs it to Unibox.
 *
 * Logs carry ids and status codes only: never message text, phone numbers or
 * the secret.
 */
import { contactInboxService, messageService } from "@chatbotx.io/business"
import { signApiPayload } from "@chatbotx.io/integration-api/lib/signature"
import type { WebhookJobForwardInbound } from "@chatbotx.io/worker-config"
import { UnrecoverableError } from "bullmq"
import {
  getInboundForwardConfig,
  type InboundForwardConfig,
} from "../../events/message/handlers/forward-inbound-config"
import { logger } from "../../lib/logger"

const FORWARD_TIMEOUT_MS = 10_000

type ForwardData = WebhookJobForwardInbound["data"]

export type InboundForwardDeps = {
  loadMessage: typeof messageService.findByIdWithUrls
  loadContactInboxes: typeof contactInboxService.findManyByIds
  fetchImpl: typeof fetch
  now: () => Date
}

const defaultDeps: InboundForwardDeps = {
  loadMessage: (input) => messageService.findByIdWithUrls(input),
  loadContactInboxes: (input) => contactInboxService.findManyByIds(input),
  fetchImpl: (input, init) => fetch(input, init),
  now: () => new Date(),
}

/** Retrying cannot fix a 4xx, except a timeout or rate limit. */
const isRetryableStatus = (status: number): boolean =>
  status >= 500 || status === 408 || status === 429

export async function forwardInboundMessage(
  data: ForwardData,
  config: InboundForwardConfig = getInboundForwardConfig(),
  deps: InboundForwardDeps = defaultDeps,
): Promise<"sent" | "skipped"> {
  const logContext = {
    workspaceId: data.workspaceId,
    channel: data.channel,
    inboxId: data.inboxId,
    messageId: data.messageId,
  }

  // Re-checked at run time: the env may have changed since the job was queued.
  if (!(config.enabled && config.channels.has(data.channel))) {
    return "skipped"
  }

  let message: Awaited<ReturnType<typeof messageService.findByIdWithUrls>>
  try {
    message = await deps.loadMessage({
      workspaceId: data.workspaceId,
      id: data.messageId,
      createdAt: new Date(data.messageCreatedAt),
    })
  } catch (err) {
    logger.warn(
      { err, ...logContext },
      "[inbound-forward] message not loadable; not forwarded",
    )
    return "skipped"
  }

  // Comments on posts belong to Amplify, not Unibox; only direct messages.
  if (message.type !== "message" || message.messageType !== "incoming") {
    return "skipped"
  }

  const [contactInbox] = await deps.loadContactInboxes({
    workspaceId: data.workspaceId,
    ids: [message.contactInboxId],
  })
  if (!contactInbox) {
    logger.warn(logContext, "[inbound-forward] contact inbox not found")
    return "skipped"
  }

  const envelope = {
    event: "message_created",
    timestamp: deps.now().toISOString(),
    workspaceId: data.workspaceId,
    channel: data.channel,
    inboxId: data.inboxId,
    contact: { id: contactInbox.contactId, sourceId: contactInbox.sourceId },
    conversation: { id: message.conversationId },
    message: {
      id: message.id,
      sourceId: message.sourceId,
      text: message.text,
      messageType: message.messageType,
      contentType: message.contentType,
      attachments: message.attachments,
      contentAttributes: message.contentAttributes,
      createdAt: new Date(message.createdAt).toISOString(),
    },
  }

  const rawBody = JSON.stringify(envelope)
  const timestamp = Math.floor(deps.now().getTime() / 1000).toString()
  const signature = await signApiPayload(config.secret, timestamp, rawBody)

  let response: Response
  try {
    response = await deps.fetchImpl(config.url, {
      method: "POST",
      body: rawBody,
      headers: {
        "Content-Type": "application/json",
        "X-ChatbotX-Signature": `sha256=${signature}`,
        "X-ChatbotX-Timestamp": timestamp,
        // Stable per message so Unibox can drop a redelivery.
        "X-ChatbotX-Delivery": message.id,
      },
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    })
  } catch (err) {
    logger.warn(
      { err, ...logContext },
      "[inbound-forward] request failed; will retry",
    )
    throw err
  }

  if (response.ok) {
    logger.info(
      { ...logContext, status: response.status },
      "[inbound-forward] delivered",
    )
    return "sent"
  }

  logger.warn(
    { ...logContext, status: response.status },
    "[inbound-forward] rejected by receiver",
  )
  if (isRetryableStatus(response.status)) {
    throw new Error(`inbound forward got HTTP ${response.status}`)
  }
  throw new UnrecoverableError(`inbound forward got HTTP ${response.status}`)
}
