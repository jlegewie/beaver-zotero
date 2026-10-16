import { useSurfaceWindow } from '../../runtime/SurfaceWindowContext';
import React, { useCallback, useEffect, useState } from "react";
import Button from "@beaver/agent-ui/primitives/Button";
import {SettingsGroup, SettingsRow, SectionLabel, DocLink} from "./components/SettingsElements";
import { Spinner } from '../icons/icons';
import { activePreferencePageTabAtom } from "../../atoms/ui";
import { userAtom } from "../../atoms/auth";
import { creditBreakdownAtom, creditPlanAtom, hasCreditPlanAtom, isCreditPlanPastDueAtom, profileBalanceAtom } from "../../atoms/profile";
import { useAtomValue, useSetAtom } from "jotai";
import { useBilling } from "../../hooks/useBilling";
import { accountService, ScheduledChange, PlanInfo } from "@beaver/agent-core/transport/clients/accountService";
import { CreditBreakdown, ProfileBalance } from "@beaver/agent-core/types/profile";
import { getPref, setPref } from "../../../src/utils/prefs";
import {
    parseCreditLimitEntry,
    readCreditThreshold,
} from "../../utils/creditThreshold";
import {
    BillingInterval,
    findIntervalCounterpart,
    formatMonthsFree,
    formatPrice,
    formatTimeRemaining,
    getMonthsFree,
    getPlanChangeOptions,
    getPlanTier,
    isAnnualPlanId,
} from "../../utils/billingPlans";


const getPackPrice = (pack: PlanInfo) => formatPrice(pack.unit_amount, pack.currency);

const OfferCard: React.FC<{
    label: string,
    title: React.ReactNode,
    actionLabel: string,
    onAction: () => void,
    disabled: boolean,
}> = (props) => {
    const { label, title, actionLabel, onAction, disabled } = props;
    return (
        <div
            className="display-flex flex-row items-center"
        >
            <div className="display-flex flex-col" style={{ minWidth: 0 }}>
                <span className="text-base font-color-secondary">
                    {label}
                </span>
                <span className="text-base font-color-primary font-medium">
                    {title}
                </span>
            </div>
            <div className="flex-1" />
            <Button
                variant="outline"
                onClick={onAction}
                disabled={disabled}
                style={{ padding: '4px 6px' }}
            >
                {actionLabel}
            </Button>
        </div>
    );
};

const MonthsFreeBadge: React.FC<{ months: number }> = ({ months }) => (
    <span
        className="text-xs px-15 py-05 rounded-md"
        style={{ color: 'var(--tag-green-primary)', border: '1px solid var(--tag-green-tertiary)', background: 'var(--tag-green-quinary)' }}
    >
        {formatMonthsFree(months)}
    </span>
);

const BillingIntervalToggle: React.FC<{
    value: BillingInterval,
    onChange: (interval: BillingInterval) => void,
    monthsFree: number,
}> = ({ value, onChange, monthsFree }) => (
    <div className="display-flex flex-row items-center gap-3">
        <div
            role="group"
            aria-label="Billing interval"
            className="display-flex flex-row items-center gap-1 rounded-md"
            style={{ border: '1px solid var(--beaver-border-default)', background: 'var(--fill-quinary)', padding: '2px' }}
        >
            {(['month', 'year'] as const).map((interval) => (
                <Button
                    key={interval}
                    variant={value === interval ? 'surface' : 'ghost-secondary'}
                    aria-pressed={value === interval}
                    onClick={() => onChange(interval)}
                    style={{ padding: '2px 8px' }}
                >
                    {interval === 'month' ? 'Monthly' : 'Yearly'}
                </Button>
            ))}
        </div>
        {monthsFree > 0 && (
            <span className="text-sm font-color-secondary">
                Get {formatMonthsFree(monthsFree)} with yearly billing
            </span>
        )}
    </div>
);

const ProgressBar: React.FC<{ creditBreakdown: CreditBreakdown, profileBalance: ProfileBalance }> = (props) => {
    const { creditBreakdown, profileBalance } = props;
    // The limit already accounts for billing status, so a plan whose credits are
    // not currently usable reports zero here rather than a pool that cannot be
    // spent. The caller hides the bar in that case.
    const pool = profileBalance.subscriptionCreditLimit;
    const used = Math.min(profileBalance.monthlyCreditsUsed, pool);
    const total = pool || 1;
    const remaining = total - used;
    const usedPct = Math.round((used / total) * 100);
    const barColor = usedPct > 90 ? 'var(--tag-red-primary)' : usedPct > 70 ? 'var(--tag-yellow-primary)' : 'var(--color-accent, var(--fill-primary))';
    return (
        <div style={{ marginTop: '12px' }}>
            <div className="display-flex flex-row items-center gap-3" style={{ marginBottom: '4px' }}>
                <span className="text-base font-color-primary font-medium">Plan Credits</span>
                <div className="flex-1" />
                <span className="text-base font-color-primary font-medium">
                    {usedPct}% used
                </span>
            </div>
            <div className="display-flex flex-row items-center">
                <div
                    style={{
                        flex: 1,
                        height: '7px',
                        borderRadius: '4px',
                        background: 'var(--fill-quarternary)',
                        overflow: 'hidden',
                    }}
                >
                    <div
                        style={{
                            width: `${Math.min(100, usedPct)}%`,
                            height: '100%',
                            borderRadius: '4px',
                            background: barColor,
                            transition: 'width 0.3s ease',
                        }}
                    />
                </div>
            </div>
            <div className="display-flex flex-col">
                <div className="text-base font-color-secondary" style={{ marginTop: '4px' }}>
                    {used} / {total} used
                </div>
                {creditBreakdown.rolledOverCredits > 0 && (
                    <div className="text-sm font-color-tertiary">
                        Includes {creditBreakdown.rolledOverCredits} rolled over credits from last period
                    </div>
                )}
            </div>
        </div>
    );
};

const PlanCards: React.FC<{ plans: PlanInfo[], subscribe: (sku: string) => Promise<void>, buyCredits: (sku: string) => Promise<void>, isBillingLoading: boolean }> = (props) => {
    const { plans, subscribe, buyCredits, isBillingLoading } = props;
    const [billingInterval, setBillingInterval] = useState<BillingInterval>('month');
    const annualPlans = plans.filter(p => p.interval === 'year');
    // Yearly plans are only listed by backends that offer them.
    const interval: BillingInterval = annualPlans.length > 0 ? billingInterval : 'month';
    const subscriptionPlans = plans.filter(p => p.interval === interval);
    const creditPacks = plans.filter(p => !p.interval);
    const maxMonthsFree = Math.max(0, ...annualPlans.map(p => getMonthsFree(p, findIntervalCounterpart(plans, p, 'month'))));
    return (
        <div className="display-flex flex-col gap-3">
            {annualPlans.length > 0 && (
                <BillingIntervalToggle value={interval} onChange={setBillingInterval} monthsFree={maxMonthsFree} />
            )}

            {/* Subscription plan cards (primary) */}
            <div className="display-flex flex-row gap-3">
                {subscriptionPlans.map((plan) => {
                    const isAnnual = plan.interval === 'year';
                    // Yearly plans lead with the monthly equivalent so the two
                    // intervals compare directly; the yearly charge is listed below.
                    const price = formatPrice(isAnnual ? plan.unit_amount / 12 : plan.unit_amount, plan.currency);
                    const monthsFree = isAnnual ? getMonthsFree(plan, findIntervalCounterpart(plans, plan, 'month')) : 0;
                    return (
                        <div
                            key={plan.sku}
                            className="display-flex flex-1 flex-col rounded-card border-card bg-senary p-4"
                        >
                            <div className="display-flex flex-row items-center gap-2 flex-wrap" style={{ marginBottom: '4px' }}>
                                <span className="text-base font-color-primary font-bold">{plan.name}</span>
                                {monthsFree > 0 && <MonthsFreeBadge months={monthsFree} />}
                            </div>
                            {plan.label && (
                                <div className="text-sm font-color-secondary" style={{ marginBottom: '8px', marginTop: '-4px' }}>
                                    {plan.label}
                                </div>
                            )}
                            <div className="text-xl font-color-primary font-bold">
                                {price}<span className="text-sm font-normal font-color-secondary">/month</span>
                            </div>
                            <div className="text-sm font-color-secondary">
                                {formatPrice(plan.unit_amount, plan.currency)} billed {isAnnual ? 'yearly' : 'monthly'}
                            </div>
                            <div className="text-sm font-color-secondary" style={{ marginBottom: '8px' }}>
                                {plan.monthly_credits} credits per month
                            </div>
                            <div className="display-flex flex-col items-start gap-1">
                                <Button
                                    variant={plan.highlight ? 'solid' : 'surface'}
                                    onClick={() => subscribe(plan.sku)}
                                    disabled={isBillingLoading}
                                    style={{ padding: '4px 6px' }}
                                >
                                    Subscribe
                                </Button>
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="display-flex flex-row justify-end -mt-1 ml-1">
                <div className="font-color-tertiary text-sm">
                    Carry over up to one monthly allowance
                </div>
            </div>

            {/* Credit pack card (secondary) */}
            {creditPacks.length > 0 && 
                <OfferCard
                    label="Not ready to subscribe?"
                    title={<>Credit Pack: {creditPacks[0].monthly_credits} credits for {getPackPrice(creditPacks[0])}</>}
                    actionLabel="Buy Pack"
                    onAction={() => buyCredits(creditPacks[0].sku)}
                    disabled={isBillingLoading}
                />
            }
        </div>
    );
};

export const formatPlanName = (plan: string | undefined): string => {
    if (!plan) return '';
    const isAnnual = isAnnualPlanId(plan);
    const base = getPlanTier(plan).split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return isAnnual ? `${base} (Annual)` : base;
};

const ScheduledChangeNotice: React.FC<{
    currentPlan: string;
    periodEnd: string | null;
    onManage: () => Promise<void>;
    disabled: boolean;
}> = ({ currentPlan, periodEnd, onManage, disabled }) => {
    const surfaceWindow = useSurfaceWindow();
    const [change, setChange] = useState<ScheduledChange | null>(null);
    const [unavailable, setUnavailable] = useState(false);
    useEffect(() => {
        let active = true;
        let generation = 0;
        const load = async () => {
            const request = ++generation;
            try {
                const result = await accountService.getScheduledChange();
                if (active && request === generation) {
                    setChange(result.scheduled_change);
                    setUnavailable(!result.scheduled_change);
                }
            } catch {
                if (active && request === generation) {
                    setChange(null);
                    setUnavailable(true);
                }
            }
        };
        void load();
        const onFocus = () => { void load(); };
        surfaceWindow.addEventListener('focus', onFocus);
        return () => { active = false; surfaceWindow.removeEventListener('focus', onFocus); };
    }, [surfaceWindow]);
    const date = change?.effective_at ?? periodEnd;
    const price = change && new Intl.NumberFormat(undefined, {
        style: 'currency', currency: change.currency,
    }).format(change.unit_amount / 100);
    return (
        <div className="text-sm font-color-secondary" role="status">
            {change
                ? `Your plan changes to ${change.name} at ${price}/${change.interval}`
                : 'Your subscription has a scheduled change'}
            {date ? ` on ${new Date(date).toLocaleDateString()}` : ' at the end of the current period'}.
            {change && ' Price before taxes and discounts.'}{' '}
            Your {currentPlan} plan continues until then. Undoing this change keeps your current plan and billing interval.{' '}
            {unavailable && 'Scheduled plan details are unavailable here; review them in billing settings. '}
            <Button variant="ghost-secondary" onClick={onManage} disabled={disabled}>
                Review or undo the scheduled change
            </Button>
        </div>
    );
};

const BillingSection: React.FC = () => {
    const setActiveTab = useSetAtom(activePreferencePageTabAtom);
    const user = useAtomValue(userAtom);

    // --- Atoms: Plan and credits ---
    const creditPlan = useAtomValue(creditPlanAtom);
    const creditBreakdown = useAtomValue(creditBreakdownAtom);
    const profileBalance = useAtomValue(profileBalanceAtom);
    const isPastDue = useAtomValue(isCreditPlanPastDueAtom);
    const hasPlan = useAtomValue(hasCreditPlanAtom);
    const { subscribe, buyCredits, manageSubscription, upgradeSubscription, isLoading: isBillingLoading, error: billingError, errorAction: billingErrorAction, plans, plansLoading, plansError, fetchPlans } = useBilling();
    const creditPacks = plans.filter(p => !p.interval);
    // A failed "Buy Credits" click is reported in the Credits section; every
    // other failed action is reported in the plan card.
    const creditsError = hasPlan && billingErrorAction === 'buyCredits' ? billingError : null;
    const planCardError = creditsError ? null : billingError;
    // One control drives both stored values: a number is the limit, an empty
    // field means never ask. `confirmCredits` is what carries "never" — the
    // limit itself keeps its last value so clearing and refilling the field
    // does not lose it.
    const [creditThresholdText, setCreditThresholdText] = useState(() =>
        getPref('confirmCredits') ? String(readCreditThreshold()) : '');

    // The field is edited as free text and only written on commit (blur or
    // Enter): writing per keystroke would store "1" on the way to "10". An
    // empty field is a deliberate "never ask", not an invalid entry. The
    // preference holds an integer, so a number is rounded and capped before it
    // is stored — an out-of-range value would otherwise wrap and be rejected by
    // the server on every run. Anything else snaps back to what is stored.
    const commitCreditThreshold = useCallback(() => {
        const entry = parseCreditLimitEntry(creditThresholdText);
        if (entry.kind === 'never') {
            setPref('confirmCredits', false);
            setCreditThresholdText('');
            return;
        }
        if (entry.kind === 'invalid') {
            setCreditThresholdText(getPref('confirmCredits') ? String(readCreditThreshold()) : '');
            return;
        }
        setPref('creditConfirmThreshold', entry.value);
        setPref('confirmCredits', true);
        setCreditThresholdText(String(entry.value));
    }, [creditThresholdText]);

    const isAnnual = isAnnualPlanId(creditPlan.plan);
    const canChangePlan = hasPlan && !creditPlan.cancelAtPeriodEnd && !creditPlan.pendingDowngrade && !isPastDue;
    const { upgradePlan, yearlyPlan } = canChangePlan
        ? getPlanChangeOptions(plans, creditPlan.plan, creditPlan.monthlyCredits || 0)
        : { upgradePlan: null, yearlyPlan: null };
    const yearlyMonthsFree = yearlyPlan ? getMonthsFree(yearlyPlan, findIntervalCounterpart(plans, yearlyPlan, 'month')) : 0;

    // --- Fetch plans when billing tab is active and user has no plan ---
    useEffect(() => {
        fetchPlans();
    }, [fetchPlans]);

    return (
        <>
            <div className="font-color-secondary text-base mb-2 ml-1">
                Credits power Beaver's AI. Most messages cost 1 credit. Some actions such as external search or batch extraction cost extra. <DocLink path="credits">Learn more &rarr;</DocLink>
            </div>

            {/* --- Section 1: Plan Card --- */}
            <div className="display-flex flex-col rounded-card overflow-hidden border-card bg-senary p-5">
                {isPastDue && (
                    <div
                        className="display-flex flex-row items-center gap-3 mb-3 rounded-md"
                        style={{
                            background: 'var(--tag-red-quinary)',
                            border: '1px solid var(--tag-red-quarternary)',
                            padding: '8px 12px',
                        }}
                    >
                        <span className="font-color-red text-sm font-medium">
                            Payment failed. Update your payment method to keep your subscription.
                        </span>
                        <div className="flex-1" />
                        <Button variant="outline" onClick={manageSubscription} disabled={isBillingLoading} style={{ padding: '4px 6px' }}>
                            Update Payment
                        </Button>
                    </div>
                )}

                <div className="text-xs font-color-secondary font-bold" style={{ letterSpacing: '0.05em' }}>
                    CURRENT PLAN
                </div>

                {!hasPlan ? (
                    <>
                        <div className="text-2xl font-color-primary font-bold">
                            No active plan
                        </div>
                        <div className="text-base font-color-secondary" style={{ marginBottom: '12px' }}>
                            Subscribe to get monthly credits and Plus Tools (external search, batch extraction, and more).
                        </div>

                        {plansLoading && (
                            <div className="display-flex flex-row items-center gap-3" style={{ padding: '12px 0' }}>
                                <Spinner size={16} /> <span className="font-color-secondary text-sm">Loading plans...</span>
                            </div>
                        )}

                        {plansError && (
                            <div className="display-flex flex-row items-center gap-3 flex-wrap ml-1 -mt-3" style={{ padding: '12px 0' }}>
                                <span className="font-color-secondary">{plansError}</span>
                                <Button variant="ghost-secondary" onClick={fetchPlans} style={{ padding: '4px 6px' }}>Retry</Button>
                            </div>
                        )}

                        {!plansLoading && !plansError && plans.length > 0 && 
                            <PlanCards plans={plans} subscribe={subscribe} buyCredits={buyCredits} isBillingLoading={isBillingLoading} />
                        }
                    </>
                ) : (
                    <div className="display-flex flex-col gap-4">
                        <div className="display-flex flex-row items-center gap-3">
                            <div className="display-flex flex-col">
                                <div className="display-flex flex-row items-center gap-3">
                                    <div className="text-2xl font-color-primary font-bold">
                                        {formatPlanName(creditPlan.plan ?? undefined)}
                                    </div>
                                    {creditPlan.cancelAtPeriodEnd ? (
                                        <span
                                            className="text-xs px-15 py-05 rounded-md"
                                            style={{ color: 'var(--tag-orange-secondary)', border: '1px solid var(--tag-orange-tertiary)', background: 'var(--tag-orange-quinary)' }}
                                        >
                                            Cancellation pending
                                        </span>
                                    ) : creditPlan.pendingDowngrade && (
                                        <span
                                            className="text-xs px-15 py-05 rounded-md"
                                            style={{ color: 'var(--tag-orange-secondary)', border: '1px solid var(--tag-orange-tertiary)', background: 'var(--tag-orange-quinary)' }}
                                        >
                                            Plan change scheduled
                                        </span>
                                    )}
                                    {creditPlan.status === 'past_due' && (
                                        <span
                                            className="text-xs px-15 py-05 rounded-md"
                                            style={{ color: 'var(--tag-orange-secondary)', border: '1px solid var(--tag-orange-tertiary)', background: 'var(--tag-orange-quinary)' }}
                                        >
                                            Past due
                                        </span>
                                    )}
                                </div>
                                {creditPlan.periodEnd && !creditPlan.cancelAtPeriodEnd && (
                                    <span className="text-sm font-color-secondary">
                                        Renews {new Date(creditPlan.periodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: isAnnual ? 'numeric' : undefined })}
                                        {' '}({formatTimeRemaining(creditPlan.periodEnd, isAnnual)})
                                    </span>
                                )}
                                {creditPlan.cancelAtPeriodEnd && creditPlan.periodEnd && (
                                    <span className="text-base font-color-secondary">
                                        Your plan ends {new Date(creditPlan.periodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                                        {' '}({formatTimeRemaining(creditPlan.periodEnd, isAnnual, Date.now(), true)})
                                    </span>
                                )}
                            </div>
                            <div className="flex-1" />
                            {upgradePlan && (
                                <Button variant="outline" onClick={() => upgradeSubscription(upgradePlan.sku)} loading={isBillingLoading} style={{ padding: '4px 6px' }}>
                                    Upgrade
                                </Button>
                            )}
                            <Button variant="surface-light" onClick={manageSubscription} disabled={isBillingLoading} style={{ padding: '4px 6px' }}>
                                {creditPlan.cancelAtPeriodEnd ? 'Reactivate' : 'Manage'}
                            </Button>
                        </div>

                        {creditPlan.pendingDowngrade && !creditPlan.cancelAtPeriodEnd && (
                            <ScheduledChangeNotice
                                key={`${user?.id}:${creditPlan.plan}:${creditPlan.periodEnd}`}
                                currentPlan={formatPlanName(creditPlan.plan ?? undefined)}
                                periodEnd={creditPlan.periodEnd}
                                onManage={manageSubscription}
                                disabled={isBillingLoading}
                            />
                        )}

                        {/* Progress bar (subscription + rollover credits). Hidden when
                            the plan's credits are not currently usable — an unpaid or
                            lapsed subscription has nothing to meter, and the payment
                            banner above already explains why. */}
                        {profileBalance.subscriptionCreditLimit > 0 && (
                            <ProgressBar creditBreakdown={creditBreakdown} profileBalance={profileBalance} />
                        )}
                        {isAnnual && creditPlan.monthlyResetAt && (
                            <div className="text-base font-color-secondary">
                                Credits reset every month. Next reset is on {new Date(creditPlan.monthlyResetAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                            </div>
                        )}

                        {yearlyPlan && (
                            <OfferCard
                                label="Billed monthly"
                                title={<>
                                    Switch to yearly: {formatPrice(yearlyPlan.unit_amount, yearlyPlan.currency)}/year
                                    {yearlyMonthsFree > 0 && ` (${formatMonthsFree(yearlyMonthsFree)})`}
                                </>}
                                actionLabel="Switch to Yearly"
                                onAction={() => upgradeSubscription(yearlyPlan.sku)}
                                disabled={isBillingLoading}
                            />
                        )}

                    </div>
                )}

                {planCardError && (
                    <div className="font-color-red text-sm mt-3" role="alert">
                        {planCardError}
                    </div>
                )}
            </div>

            {!hasPlan && (
                <div className="text-sm font-color-secondary ml-1">
                    By subscribing or buying credits, you agree to the{' '}
                    <a
                        onClick={() => Zotero.launchURL(`${process.env.WEBAPP_BASE_URL}/terms`)}
                        href="https://www.beaverapp.ai/terms"
                        className="text-sm text-link cursor-pointer"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Terms of Service
                    </a>
                    {' '}and{' '}
                    <a
                        onClick={() => Zotero.launchURL(`${process.env.WEBAPP_BASE_URL}/privacy`)}
                        href="https://www.beaverapp.ai/privacy"
                        className="text-sm text-link cursor-pointer"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Privacy Policy
                    </a>.
                </div>
            )}

            {/* --- Link to plan details --- */}
            {!hasPlan && (
                <div className="display-flex flex-row ml-1">
                    <div
                        className="text-sm text-link cursor-pointer"
                        onClick={() => Zotero.launchURL(`${process.env.WEBAPP_BASE_URL}/pricing`)}
                    >
                        View plan details &rarr;
                    </div>
                </div>
            )}

            {/* --- Section 2: Credits --- */}
            <SectionLabel>Credits</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title="Extra Credits"
                    description={
                        (creditBreakdown.purchasedCredits || 0) === 0 && !hasPlan ? (
                            <span className="font-color-secondary">No credits remaining</span>
                        ) : (
                            <span className="font-color-secondary">
                                Credits from sign-up bonus and credit packs
                                {creditBreakdown.purchasedExpiresAt && (creditBreakdown.purchasedCredits || 0) > 0 && (
                                    <>
                                        <br />
                                        Expires: {new Date(creditBreakdown.purchasedExpiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                                    </>
                                )}
                            </span>
                        )
                    }
                    control={
                        <span className="font-color-primary text-sm font-bold">
                            {(creditBreakdown.purchasedCredits || 0).toLocaleString()}
                        </span>
                    }
                />
                <SettingsRow
                    title="Total Available"
                    description={
                        <span className="font-color-secondary">Plan credits + Extra Credits</span>
                    }
                    hasBorder
                    control={
                        <span className="font-color-primary text-sm font-bold">
                            {(creditBreakdown.total || 0).toLocaleString()}
                        </span>
                    }
                />
                {hasPlan && (
                    <SettingsRow
                        className="bg-senary"
                        title="Get additional credits"
                        description={
                            <span>
                                {creditPacks.length > 0
                                    ? <>Credit Pack: {creditPacks[0].monthly_credits} credits for {getPackPrice(creditPacks[0])}</>
                                    : plansLoading ? 'Loading...' : ''}
                            </span>
                        }
                        hasBorder
                        control={
                            <Button variant="outline" onClick={() => buyCredits(creditPacks[0]?.sku)} loading={isBillingLoading} disabled={creditPacks.length === 0} style={{ padding: '4px 6px' }}>Buy Credits</Button>
                        }
                    />
                )}
            </SettingsGroup>
            {creditsError && (
                <div className="font-color-red text-sm ml-1" role="alert">
                    {creditsError}
                </div>
            )}

            <SectionLabel>Credit Limit</SectionLabel>
            <SettingsGroup>
                <SettingsRow
                    title="Credit Limit"
                    description={
                        <>
                            Ask before a single request uses more than this many credits in total. Leave empty to never ask. Only relevant when using Beaver credits. <DocLink path="credits">Learn more</DocLink>
                        </>
                    }
                    control={
                        <input
                            // Text, not a number field. A number field
                            // sanitizes anything it cannot parse to the empty
                            // string, and an empty field here is not a failed
                            // entry but a decision — "never ask". A lone `-` or
                            // `.`, both of which such a field accepts as
                            // keystrokes, would therefore read back as a request
                            // to stop asking, so clicking away part-way through
                            // retyping the limit would switch it off. Text keeps
                            // the entry intact, which is what lets
                            // `parseCreditLimitEntry` tell an unusable one from
                            // an empty one and snap it back.
                            type="text"
                            inputMode="numeric"
                            placeholder="Never"
                            aria-label="Credit limit"
                            value={creditThresholdText}
                            onChange={(e) => setCreditThresholdText(e.target.value)}
                            onBlur={commitCreditThreshold}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') e.currentTarget.blur();
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="py-1 px-2 preference-input preference-input-numeric text-sm font-color-primary"
                            style={{ width: '32px', margin: 0 }}
                        />
                    }
                />
            </SettingsGroup>

            {/* --- Section 4: Cross-links --- */}
            <div className="display-flex flex-col gap-1" style={{ marginTop: '16px', paddingLeft: '2px' }}>
                <span
                    className="text-sm font-color-secondary text-link cursor-pointer"
                    onClick={() => Zotero.launchURL(`${process.env.WEBAPP_BASE_URL}/login${user?.email ? `?email=${encodeURIComponent(user.email)}` : ''}`)}
                >
                    Manage account on web &rarr;
                </span>
                <span
                    className="text-sm text-link cursor-pointer"
                    onClick={() => setActiveTab('models')}
                >
                    Use your own API key instead? Configure in API Keys &rarr;
                </span>
            </div>
        </>
    );
};

export default BillingSection;
