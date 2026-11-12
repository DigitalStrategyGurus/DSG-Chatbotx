import { createHash, timingSafeEqual } from "node:crypto"
import { env } from "@/env"

/** Shorter than this and the endpoint stays disabled (503). */
export const PROVISIONING_SECRET_MIN_LENGTH = 32

export type ProvisioningAuthResult = "ok" | "unauthorized" | "unconfigured"

const extractBearer = (headers: Headers): string | null => {
  const authorization = headers.get("Authorization")
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null
}

/**
 * Fail-closed bearer check for the provisioning route.
 *
 * `unconfigured`: `CHATBOTX_PROVISIONING_SECRET` is unset, empty or too short,
 * so nobody can authenticate — not even with a matching header. The caller
 * answers 503, never 401, so an operator sees "disabled" instead of "wrong
 * secret".
 *
 * The compare hashes both sides first so `timingSafeEqual` always runs on
 * equal-length buffers: a length mismatch must not short-circuit, or the
 * response time would leak the secret's length.
 */
export function authorizeProvisioningRequest(
  headers: Headers,
): ProvisioningAuthResult {
  const secret = env.CHATBOTX_PROVISIONING_SECRET?.trim()
  if (!secret || secret.length < PROVISIONING_SECRET_MIN_LENGTH) {
    return "unconfigured"
  }

  const presented = extractBearer(headers)
  if (!presented) {
    return "unauthorized"
  }

  const expectedDigest = createHash("sha256").update(secret).digest()
  const presentedDigest = createHash("sha256").update(presented).digest()
  return timingSafeEqual(expectedDigest, presentedDigest)
    ? "ok"
    : "unauthorized"
}
