import { expect, it } from "vitest";
import { hasVoiceCredits } from "../../../react/voice/credits";
const now = Date.parse("2026-09-08T12:00:00Z");
it.each(["active", "trialing"])(
    "honors raw %s access during renewal lag",
    (status) => {
        expect(
            hasVoiceCredits(
                {
                    stripe_subscription_status: status,
                    credit_period_end: "2026-09-01",
                    credit_plan_monthly_credits: 10,
                },
                now,
            ),
        ).toBe(true);
    },
);
it.each(["canceled", "unpaid", "paused", "incomplete", "none"])(
    "does not use inactive %s subscription pools",
    (status) => {
        expect(
            hasVoiceCredits(
                {
                    stripe_subscription_status: status,
                    credit_plan_monthly_credits: 100,
                },
                now,
            ),
        ).toBe(false);
    },
);
it("rejects expired legacy and purchased pools but accepts unexpired purchased credits", () => {
    expect(
        hasVoiceCredits(
            {
                credit_plan_status: "active",
                credit_period_end: "2026-09-01",
                credit_plan_monthly_credits: 100,
            },
            now,
        ),
    ).toBe(false);
    expect(
        hasVoiceCredits(
            {
                purchased_chat_credits: 2,
                purchased_credits_expires_at: "2026-09-01",
            },
            now,
        ),
    ).toBe(false);
    expect(
        hasVoiceCredits(
            {
                purchased_chat_credits: 2,
                purchased_credits_expires_at: "2026-10-01",
            },
            now,
        ),
    ).toBe(true);
});
