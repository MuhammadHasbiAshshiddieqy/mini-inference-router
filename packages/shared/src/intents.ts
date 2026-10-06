import { z } from "zod";

// The 27 Bitext intents (docs/02 §2). Order matches the dataset's alphabetical listing.
export const INTENTS = [
  "cancel_order",
  "change_order",
  "change_shipping_address",
  "check_cancellation_fee",
  "check_invoice",
  "check_payment_methods",
  "check_refund_policy",
  "complaint",
  "contact_customer_service",
  "contact_human_agent",
  "create_account",
  "delete_account",
  "delivery_options",
  "delivery_period",
  "edit_account",
  "get_invoice",
  "get_refund",
  "newsletter_subscription",
  "payment_issue",
  "place_order",
  "recover_password",
  "registration_problems",
  "review",
  "set_up_shipping_address",
  "switch_account",
  "track_order",
  "track_refund",
] as const;

export const OUT_OF_SCOPE = "out_of_scope" as const;

// What the assistant may output: the 27 intents plus `out_of_scope` (used only for refusal).
export const SUPPORT_LABELS = [...INTENTS, OUT_OF_SCOPE] as const;

export const IntentSchema = z.enum(INTENTS);
export const SupportLabelSchema = z.enum(SUPPORT_LABELS);

export type Intent = z.infer<typeof IntentSchema>;
export type SupportLabel = z.infer<typeof SupportLabelSchema>;

export function isSupportLabel(value: string): value is SupportLabel {
  return SupportLabelSchema.safeParse(value).success;
}
