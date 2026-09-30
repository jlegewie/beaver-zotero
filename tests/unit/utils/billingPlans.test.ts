import { describe, expect, it } from 'vitest';
import type { PlanInfo } from '@beaver/agent-core/transport/clients/accountService';
import {
    findIntervalCounterpart,
    getMonthsFree,
    getPlanChangeOptions,
    getPlanTier,
    isAnnualPlanId,
} from '../../../react/utils/billingPlans';

const plan = (sku: string, monthly_credits: number, unit_amount: number, interval: string | null): PlanInfo => ({
    sku,
    name: sku,
    monthly_credits,
    unit_amount,
    currency: 'usd',
    interval,
    highlight: true,
    label: null,
});

const plusMonthly = plan('plus_monthly', 120, 1000, 'month');
const plusMaxMonthly = plan('plus_max_monthly', 300, 2000, 'month');
const plusAnnual = plan('plus_annual', 120, 10000, 'year');
const plusMaxAnnual = plan('plus_max_annual', 300, 20000, 'year');
const pack = plan('pack_50', 50, 800, null);

const allPlans = [plusMonthly, plusMaxMonthly, plusAnnual, plusMaxAnnual, pack];
const monthlyOnlyPlans = [plusMonthly, plusMaxMonthly, pack];

describe('billing plan ids', () => {
    it('reduces SKUs and profile plan ids to the shared tier', () => {
        expect(getPlanTier('plus_monthly')).toBe('plus');
        expect(getPlanTier('plus_annual')).toBe('plus');
        expect(getPlanTier('plus')).toBe('plus');
        expect(getPlanTier('plus_max')).toBe('plus_max');
        expect(getPlanTier('plus_max_annual')).toBe('plus_max');
    });

    it('recognizes yearly profile plan ids', () => {
        expect(isAnnualPlanId('plus_annual')).toBe(true);
        expect(isAnnualPlanId('plus_max_annual')).toBe(true);
        expect(isAnnualPlanId('plus_max')).toBe(false);
        expect(isAnnualPlanId(null)).toBe(false);
    });
});

describe('getMonthsFree', () => {
    it('counts the months a yearly plan saves over the monthly plan', () => {
        expect(getMonthsFree(plusAnnual, findIntervalCounterpart(allPlans, plusAnnual, 'month'))).toBe(2);
        expect(getMonthsFree(plusMaxAnnual, findIntervalCounterpart(allPlans, plusMaxAnnual, 'month'))).toBe(2);
    });

    it('rounds partial savings down', () => {
        expect(getMonthsFree(plan('plus_annual', 120, 10500, 'year'), plusMonthly)).toBe(1);
    });

    it('returns zero without a comparable monthly plan', () => {
        expect(getMonthsFree(plusAnnual, undefined)).toBe(0);
        expect(getMonthsFree(plusAnnual, { ...plusMonthly, currency: 'eur' })).toBe(0);
        expect(getMonthsFree(plan('plus_annual', 120, 13000, 'year'), plusMonthly)).toBe(0);
    });
});

describe('getPlanChangeOptions', () => {
    it('offers a monthly subscriber the next monthly tier and the yearly plan of the same tier', () => {
        expect(getPlanChangeOptions(allPlans, 'plus', 120)).toEqual({
            upgradePlan: plusMaxMonthly,
            yearlyPlan: plusAnnual,
        });
    });

    it('offers only yearly billing to a monthly subscriber on the top tier', () => {
        expect(getPlanChangeOptions(allPlans, 'plus_max', 300)).toEqual({
            upgradePlan: null,
            yearlyPlan: plusMaxAnnual,
        });
    });

    it('keeps yearly subscribers on yearly billing when upgrading', () => {
        expect(getPlanChangeOptions(allPlans, 'plus_annual', 120)).toEqual({
            upgradePlan: plusMaxAnnual,
            yearlyPlan: null,
        });
        expect(getPlanChangeOptions(allPlans, 'plus_max_annual', 300)).toEqual({
            upgradePlan: null,
            yearlyPlan: null,
        });
    });

    it('does not offer a yearly subscriber a monthly upgrade when yearly plans are not listed', () => {
        expect(getPlanChangeOptions(monthlyOnlyPlans, 'plus_annual', 120)).toEqual({
            upgradePlan: null,
            yearlyPlan: null,
        });
    });

    it('keeps the monthly upgrade when yearly plans are not listed', () => {
        expect(getPlanChangeOptions(monthlyOnlyPlans, 'plus', 120)).toEqual({
            upgradePlan: plusMaxMonthly,
            yearlyPlan: null,
        });
    });

    it('never offers a credit pack as a plan change', () => {
        expect(getPlanChangeOptions([pack], 'plus', 0)).toEqual({ upgradePlan: null, yearlyPlan: null });
    });
});
