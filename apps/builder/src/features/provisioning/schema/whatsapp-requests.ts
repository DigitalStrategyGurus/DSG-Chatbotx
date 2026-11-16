import { z } from "zod"

/**
 * DSG forkpatch 6: bodies of the internal WhatsApp routes Unibox calls after
 * a clinic finished Embedded Signup in the browser of an afnemer (Odaveth).
 *
 * 6a `POST /internal/provisioning/workspaces/{id}/whatsapp/exchange` turns the
 * popup's `code` (TTL 30 s) into a business token, nothing else. 6b
 * `.../whatsapp/connect` connects the number with that token and may be
 * retried, so it never takes a `code`.
 */

const META_ID_PATTERN = /^[0-9]{1,32}$/
const metaId = z.string().regex(META_ID_PATTERN)

export const exchangeWhatsappCodeRequest = z.object({
  code: z.string().trim().min(1).max(2048),
})

export const connectWhatsappRequest = z.object({
  accessToken: z.string().trim().min(1).max(4096),
  wabaId: metaId,
  phoneNumberId: metaId,
  businessId: metaId,
  /**
   * True when the popup ended with `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`:
   * the number stays on the WhatsApp Business app (Coexistence). Maps to the
   * fork's own `connectExisting` intent.
   */
  coexistence: z.boolean().default(false),
})

export type ConnectWhatsappRequest = z.infer<typeof connectWhatsappRequest>
