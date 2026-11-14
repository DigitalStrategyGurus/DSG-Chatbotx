import type { TriggerEventType } from "@chatbotx.io/database/partials"
import { Queue } from "bullmq"
import {
  defaultJobOptions,
  fakeQueue,
  getQueueConnection,
  isNoRedisEnv,
} from "../../lib/connection"
import { queueNames } from "../../lib/types"

export const WebhookJobAction = {
  evaluateWebhooks: "evaluateWebhooks",
  // DSG forkpatch 7: forward an inbound channel message to Unibox.
  forwardInbound: "forwardInbound",
} as const

export type WebhookJobEvaluate = {
  type: "evaluateWebhooks"
  data: {
    workspaceId: string
    contactId: string
    eventType: TriggerEventType
    eventData: Record<string, unknown>
    timestamp: Date
  }
}

/**
 * DSG forkpatch 7. Carries only ids: the job loads the message itself so the
 * queue never holds message content.
 */
export type WebhookJobForwardInbound = {
  type: "forwardInbound"
  data: {
    workspaceId: string
    channel: string
    inboxId: string
    messageId: string
    messageCreatedAt: string
  }
}

export type WebhookJobData = WebhookJobEvaluate | WebhookJobForwardInbound

export const webhookQueue = isNoRedisEnv()
  ? fakeQueue
  : new Queue<WebhookJobData>(queueNames.enum.webhook, {
      connection: getQueueConnection(queueNames.enum.webhook),
      defaultJobOptions,
    })
