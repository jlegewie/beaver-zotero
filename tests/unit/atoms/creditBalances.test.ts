import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import { SafeProfileWithPlan } from '@beaver/agent-core/types/profile';

import {
    creditBreakdownAtom,
    profileBalanceAtom,
    profileProjectionAtom,
    remainingBeaverCreditsAtom,
} from '../../../react/atoms/profile';

/**
 * A profile whose raw allowance/rollover/used fields describe a full Plus pool,
 * parameterised by the spendable balances the backend reports for it. The two
 * disagree whenever billing status or purchased-credit expiry says the pool
 * cannot be drawn on, which is exactly what these atoms must not recompute.
 */
function profile(spendable: {
    subscription: number;
    purchased: number;
    limit: number;
}): SafeProfileWithPlan {
    return {
        credit_plan: 'plus',
        credit_plan_monthly_credits: 120,
        rolled_over_credits: 20,
        chat_credits_used: 17,
        purchased_chat_credits: 50,
        purchased_credits_expires_at: '2027-01-01T00:00:00+00:00',
        standard_page_balance: 0,
        purchased_standard_page_balance: 0,
        available_subscription_credits: spendable.subscription,
        available_purchased_credits: spendable.purchased,
        subscription_credit_limit: spendable.limit,
    } as unknown as SafeProfileWithPlan;
}

const ELIGIBLE = { subscription: 123, purchased: 50, limit: 140 };
/** Unpaid / paused / incomplete, or past_due past its paid-through date. */
const INELIGIBLE = { subscription: 0, purchased: 50, limit: 0 };
/** Eligible plan, but the purchased pool has passed its expiry. */
const EXPIRED_PACK = { subscription: 123, purchased: 0, limit: 140 };

describe('credit balance atoms', () => {
    it('reports the spendable balance for an eligible subscription', () => {
        const store = createStore();
        store.set(profileProjectionAtom, profile(ELIGIBLE));

        expect(store.get(remainingBeaverCreditsAtom)).toBe(173);
        expect(store.get(creditBreakdownAtom)).toMatchObject({
            subscriptionRemaining: 123,
            purchasedCredits: 50,
            total: 173,
        });
        expect(store.get(profileBalanceAtom)).toMatchObject({
            subscriptionChatCreditsRemaining: 123,
            purchasedChatCreditsRemaining: 50,
            chatCreditsRemaining: 173,
            subscriptionCreditLimit: 140,
        });
    });

    it('does not offer subscription credits the backend will refuse to spend', () => {
        const store = createStore();
        store.set(profileProjectionAtom, profile(INELIGIBLE));

        // 120 allowance + 20 rollover - 17 used would be 123; none of it is spendable.
        expect(store.get(remainingBeaverCreditsAtom)).toBe(50);
        expect(store.get(creditBreakdownAtom)).toMatchObject({
            subscriptionRemaining: 0,
            purchasedCredits: 50,
            total: 50,
        });
        expect(store.get(profileBalanceAtom)).toMatchObject({
            subscriptionChatCreditsRemaining: 0,
            chatCreditsRemaining: 50,
            subscriptionCreditLimit: 0,
        });
    });

    it('drops an expired purchased pool before the cleanup job zeroes it', () => {
        const store = createStore();
        store.set(profileProjectionAtom, profile(EXPIRED_PACK));

        expect(store.get(remainingBeaverCreditsAtom)).toBe(123);
        expect(store.get(creditBreakdownAtom)).toMatchObject({
            purchasedCredits: 0,
            total: 123,
        });
        expect(store.get(profileBalanceAtom)).toMatchObject({
            purchasedChatCreditsRemaining: 0,
            chatCreditsRemaining: 123,
        });
    });

    it('keeps the raw plan and usage fields for rendering the period meter', () => {
        const store = createStore();
        store.set(profileProjectionAtom, profile(ELIGIBLE));

        expect(store.get(profileBalanceAtom)).toMatchObject({
            monthlyCredits: 120,
            rolledOverCredits: 20,
            monthlyCreditsUsed: 17,
        });
    });

    it('reports nothing without a profile', () => {
        const store = createStore();
        store.set(profileProjectionAtom, null);

        expect(store.get(remainingBeaverCreditsAtom)).toBe(0);
        expect(store.get(creditBreakdownAtom).total).toBe(0);
        expect(store.get(profileBalanceAtom)).toMatchObject({
            chatCreditsRemaining: 0,
            subscriptionCreditLimit: 0,
        });
    });
});
