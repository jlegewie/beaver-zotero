interface VoiceCreditProfile {
    credit_plan_status?: string | null;
    stripe_subscription_status?: string | null;
    credit_period_end?: string | null;
    credit_plan_monthly_credits?: number;
    rolled_over_credits?: number;
    chat_credits_used?: number;
    purchased_chat_credits?: number;
    purchased_credits_expires_at?: string | null;
}
/** Local admission hint; the backend remains authoritative and bills dictation separately. */
export function hasVoiceCredits(
    profile: VoiceCreditProfile | null,
    now = Date.now(),
): boolean {
    if (!profile) return false;
    const raw = profile.stripe_subscription_status;
    const status = raw || profile.credit_plan_status;
    const direct = status === "active" || status === "trialing";
    const period = profile.credit_period_end;
    const subscription =
        (direct || status === "past_due") &&
        (!period || (!!raw && direct) || Date.parse(period) > now);
    const remaining = subscription
        ? Math.max(
              0,
              (profile.credit_plan_monthly_credits ?? 0) +
                  (profile.rolled_over_credits ?? 0) -
                  (profile.chat_credits_used ?? 0),
          )
        : 0;
    const purchased =
        !profile.purchased_credits_expires_at ||
        Date.parse(profile.purchased_credits_expires_at) >= now
            ? (profile.purchased_chat_credits ?? 0)
            : 0;
    return remaining + purchased > 0;
}
