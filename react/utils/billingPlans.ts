/**
 * Billing plan selection shared by the billing preferences.
 *
 * Subscription SKUs name their interval ('plus_monthly', 'plus_annual'), while
 * profile plan ids name it only for yearly plans ('plus', 'plus_annual'). Both
 * reduce to the same tier ('plus') so the two intervals can be paired.
 */

import type { PlanInfo } from '@beaver/agent-core/transport/clients/accountService';

export type BillingInterval = 'month' | 'year';

export const formatPrice = (amount: number, currency: string): string => {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 0 }).format(amount / 100);
};

/** Plan tier shared by both billing intervals: 'plus_monthly', 'plus_annual' and 'plus' → 'plus'. */
export const getPlanTier = (planId: string): string => planId.replace(/_(monthly|annual)$/, '');

export const isAnnualPlanId = (planId: string | null | undefined): boolean => Boolean(planId?.endsWith('_annual'));

/** The same tier billed at the given interval, if it is offered. */
export const findIntervalCounterpart = (plans: PlanInfo[], plan: PlanInfo, interval: BillingInterval): PlanInfo | undefined =>
    plans.find(p => p.interval === interval && getPlanTier(p.sku) === getPlanTier(plan.sku));

/** Whole months a yearly plan saves over twelve monthly payments of the same tier. */
export const getMonthsFree = (annual: PlanInfo, monthly: PlanInfo | undefined): number => {
    if (!monthly || monthly.currency !== annual.currency || monthly.unit_amount <= 0) return 0;
    return Math.max(0, Math.floor(12 - annual.unit_amount / monthly.unit_amount + 1e-9));
};

export const formatMonthsFree = (months: number): string => `${months} month${months !== 1 ? 's' : ''} free`;

/**
 * Plan changes offered to a subscriber whose plan can currently change.
 *
 * An upgrade keeps the billing interval. Moving from yearly to monthly billing
 * takes effect at the end of the paid year, so it is left to the billing portal
 * rather than offered here. Monthly subscribers may also move their current
 * tier to yearly billing.
 */
export function getPlanChangeOptions(
    plans: PlanInfo[],
    currentPlan: string | null,
    currentMonthlyCredits: number,
): { upgradePlan: PlanInfo | null, yearlyPlan: PlanInfo | null } {
    const isAnnual = isAnnualPlanId(currentPlan);
    const upgradePlan = plans
        .filter(p => p.interval === (isAnnual ? 'year' : 'month') && p.monthly_credits > currentMonthlyCredits)
        .sort((a, b) => a.monthly_credits - b.monthly_credits)[0] ?? null;
    const yearlyPlan = !isAnnual && currentPlan
        ? plans.find(p => p.interval === 'year' && getPlanTier(p.sku) === getPlanTier(currentPlan)) ?? null
        : null;
    return { upgradePlan, yearlyPlan };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local calendar days from `now` to `periodEnd`, clamped to zero once it has passed. */
const calendarDaysUntil = (periodEnd: Date, now: Date): number => {
    const end = Date.UTC(periodEnd.getFullYear(), periodEnd.getMonth(), periodEnd.getDate());
    const start = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.max(0, Math.round((end - start) / DAY_MS));
};

/**
 * Countdown to a period end, counted in local calendar days so it agrees with
 * the locally formatted end date: "today", "tomorrow", "5 days", or, for a
 * yearly plan more than 60 days out, "4 months". `remainingSuffix` appends
 * " remaining" to the day and month counts ("5 days remaining").
 */
export const formatTimeRemaining = (
    periodEnd: string | Date,
    isAnnual: boolean,
    now: Date | number = Date.now(),
    remainingSuffix = false,
): string => {
    const days = calendarDaysUntil(new Date(periodEnd), new Date(now));
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    const suffix = remainingSuffix ? ' remaining' : '';
    if (isAnnual && days > 60) {
        const months = Math.round(days / 30);
        return `${months} month${months !== 1 ? 's' : ''}${suffix}`;
    }
    return `${days} days${suffix}`;
};
