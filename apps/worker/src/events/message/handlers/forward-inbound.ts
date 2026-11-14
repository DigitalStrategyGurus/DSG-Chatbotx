/**
 * DSG forkpatch 7: `message:received` listener that hands genuine inbound
 * messages to the `webhook` queue for forwarding to Unibox.
 *
 * It only filters and enqueues. The HTTP call lives in the queue job because
 * the message event bus runs every listener of a batch together and without
 * selective retry: a slow listener would hold the whole batch (and on timeout
 * replay every listener), and a failed one is never retried. A BullMQ job gets
 * bounded retries and leaves the other listeners alone.
 *
 * Never throws: forwarding must not affect message processing.
 */
import type { MessageReceivedPayload } from "@chatbotx.io/event-bus"
import { WebhookJobAction, webhookQueue } from "@chatbotx.io/worker-config"
import { logger } from "../../../lib/logger"
import {
  getInboundForwardConfig,
  type InboundForwardConfig,
} from "./forward-inbound-config"

const DAY_SECONDS = 24 * 60 * 60

export const INBOUND_FORWARD_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 10_000 },
  // The jobId dedups a re-emitted event while the finished job is kept.
  removeOnComplete: { age: DAY_SECONDS },
  removeOnFail: { age: 7 * DAY_SECONDS },
} as const

export const inboundForwardJobId = (messageId: string): string =>
  `chatbotx-inbound-${messageId}`

/**
 * True for a contact-authored message on a forwarded channel. Outgoing echoes
 * and delivery-status events carry no `origin: "inbound"`; the status event
 * also has no `messageId`.
 */
export const shouldForwardInbound = (
  payload: MessageReceivedPayload,
  config: InboundForwardConfig,
): boolean =>
  config.enabled &&
  payload.origin === "inbound" &&
  Boolean(payload.messageId) &&
  config.channels.has(payload.channel)

export async function enqueueInboundForwards(
  payloads: MessageReceivedPayload[],
  config: InboundForwardConfig = getInboundForwardConfig(),
): Promise<void> {
  if (!config.enabled) {
    return
  }

  const jobs = payloads
    .filter((payload) => shouldForwardInbound(payload, config))
    .map((payload) => {
      const messageId = payload.messageId as string
      return {
        name: WebhookJobAction.forwardInbound,
        data: {
          type: WebhookJobAction.forwardInbound,
          data: {
            workspaceId: payload.workspaceId,
            channel: payload.channel,
            inboxId: payload.inboxId,
            messageId,
            messageCreatedAt: new Date(payload.occurredAt).toISOString(),
          },
        },
        opts: {
          ...INBOUND_FORWARD_JOB_OPTIONS,
          jobId: inboundForwardJobId(messageId),
        },
      }
    })

  if (jobs.length === 0) {
    return
  }

  try {
    await webhookQueue.addBulk(jobs)
  } catch (err) {
    logger.error(
      { err, count: jobs.length },
      "[inbound-forward] failed to enqueue forward jobs",
    )
  }
}
