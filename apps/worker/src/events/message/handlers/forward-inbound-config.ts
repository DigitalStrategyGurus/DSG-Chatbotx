/**
 * DSG forkpatch 7: configuration for forwarding inbound channel messages to
 * Unibox. Fail closed: anything missing or invalid disables forwarding.
 */
import { env } from "../../../env"
import { logger } from "../../../lib/logger"

export const MIN_INBOUND_FORWARD_SECRET_LENGTH = 32
const DEFAULT_CHANNELS = ["whatsapp"]
// The API channel already calls back to its integrator on replies, and its
// inbound messages come from that integrator: forwarding them would loop.
const NEVER_FORWARDED_CHANNELS = new Set(["api"])

export type InboundForwardConfig =
  | {
      enabled: true
      url: string
      secret: string
      channels: ReadonlySet<string>
    }
  | { enabled: false; reason: string }

export const resolveInboundForwardConfig = (raw: {
  url?: string
  secret?: string
  channels?: string
}): InboundForwardConfig => {
  const url = raw.url?.trim()
  if (!url) {
    return { enabled: false, reason: "CHATBOTX_INBOUND_FORWARD_URL not set" }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { enabled: false, reason: "CHATBOTX_INBOUND_FORWARD_URL invalid" }
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      enabled: false,
      reason: "CHATBOTX_INBOUND_FORWARD_URL must be http(s)",
    }
  }

  const secret = raw.secret ?? ""
  if (secret.length < MIN_INBOUND_FORWARD_SECRET_LENGTH) {
    return {
      enabled: false,
      reason: `CHATBOTX_INBOUND_FORWARD_SECRET missing or shorter than ${MIN_INBOUND_FORWARD_SECRET_LENGTH} characters`,
    }
  }

  const requested = raw.channels?.trim()
    ? raw.channels.split(",")
    : DEFAULT_CHANNELS
  const channels = new Set(
    requested
      .map((channel) => channel.trim().toLowerCase())
      .filter(
        (channel) =>
          channel.length > 0 && !NEVER_FORWARDED_CHANNELS.has(channel),
      ),
  )
  if (channels.size === 0) {
    return {
      enabled: false,
      reason: "CHATBOTX_INBOUND_FORWARD_CHANNELS has no forwardable channel",
    }
  }

  return { enabled: true, url, secret, channels }
}

let cached: InboundForwardConfig | undefined

/** Reads the worker env once and logs the outcome once (never the secret). */
export const getInboundForwardConfig = (): InboundForwardConfig => {
  if (!cached) {
    cached = resolveInboundForwardConfig({
      url: env.CHATBOTX_INBOUND_FORWARD_URL,
      secret: env.CHATBOTX_INBOUND_FORWARD_SECRET,
      channels: env.CHATBOTX_INBOUND_FORWARD_CHANNELS,
    })
    if (cached.enabled) {
      logger.info(
        {
          host: new URL(cached.url).host,
          channels: [...cached.channels],
        },
        "[inbound-forward] enabled",
      )
    } else {
      logger.info(
        { reason: cached.reason },
        "[inbound-forward] disabled (fail closed)",
      )
    }
  }
  return cached
}

/** Test hook: forget the memoized config. */
export const resetInboundForwardConfigForTests = (): void => {
  cached = undefined
}
