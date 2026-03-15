import React, { useEffect } from "react";
import Button from "../ui/Button";
import {SettingsGroup, SettingsRow, SectionLabel, DocLink} from "./components/SettingsElements";
import { Spinner } from '../icons/icons';
import { activePreferencePageTabAtom } from "../../atoms/ui";
import { creditBreakdownAtom, creditPlanAtom, hasCreditPlanAtom, isCreditPlanPastDueAtom, profileBalanceAtom } from "../../atoms/profile";
import { useAtomValue, useSetAtom } from "jotai";
import { useBilling } from "../../hooks/useBilling";
import { PlanInfo } from "../../../src/services/accountService";


const CreditPackCard: React.FC<{ pack: PlanInfo, buyCredits: () => Promise<void>, isBillingLoading: boolean }> = (props) => {
    const { pack, buyCredits, isBillingLoading } = props;
    const packPrice = new Intl.NumberFormat(undefined, { style: 'currency', currency: pack.currency, minimumFractionDigits: 0 }).format(pack.unit_amount / 100);
    return (
        <div
            className="display-flex flex-row items-center rounded-md p-1"
            style={{
                border: '1px dashed var(--border-quarternary)',
            }}
        >
            <div className="display-flex flex-col" style={{ minWidth: 0 }}>
                <span className="text-sm font-color-secondary">
                    Not ready to subscribe?
                </span>
                <span className="text-base font-color-primary font-medium">
                    Credit Pack &mdash; {pack.monthly_credits} credits for {packPrice}
                </span>
            </div>
            <div className="flex-1" />
            <Button
                variant="outline"
                onClick={() => buyCredits()}
                disabled={isBillingLoading}
            >
                Buy Pack
            </Button>
        </div>
    );
};


const BillingSection: React.FC = () => {
    const setActiveTab = useSetAtom(activePreferencePageTabAtom);

    // --- Atoms: Plan and credits ---
    const creditPlan = useAtomValue(creditPlanAtom);
    const creditBreakdown = useAtomValue(creditBreakdownAtom);
    const profileBalance = useAtomValue(profileBalanceAtom);
    const isPastDue = useAtomValue(isCreditPlanPastDueAtom);
    const hasPlan = useAtomValue(hasCreditPlanAtom);
    const { subscribe, buyCredits, manageSubscription, isLoading: isBillingLoading, plans, plansLoading, plansError, fetchPlans } = useBilling();

    // --- Fetch plans when billing tab is active and user has no plan ---
    useEffect(() => {
        if (!hasPlan) {
            fetchPlans();
        }
    }, [hasPlan, fetchPlans]);

    return (
        <>
            <div className="font-color-secondary text-base mb-2 ml-1">
                Credits power Beaver's AI. Most messages cost 1 credit. Some actions such as external search or batch extraction cost extra. <DocLink path="credits">Learn more &rarr;</DocLink>
            </div>

            {/* --- Section 1: Plan Card --- */}
            <div className="display-flex flex-col rounded-lg overflow-hidden border-popup bg-senary p-5">
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
                            Payment failed &mdash; update your payment method to keep your subscription.
                        </span>
                        <div className="flex-1" />
                        <Button variant="outline" onClick={manageSubscription} disabled={isBillingLoading}>
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
                                <Button variant="ghost-secondary" onClick={fetchPlans}>Retry</Button>
                            </div>
                        )}

                        {!plansLoading && !plansError && plans.length > 0 && (() => {
                            const subscriptionPlans = plans.filter(p => p.interval);
                            const creditPacks = plans.filter(p => !p.interval);
                            return (
                                <div className="display-flex flex-col gap-3">
                                    {/* Subscription plan cards (primary) */}
                                    <div className="display-flex flex-row gap-3">
                                        {subscriptionPlans.map((plan) => {
                                            const price = new Intl.NumberFormat(undefined, { style: 'currency', currency: plan.currency, minimumFractionDigits: 0 }).format(plan.unit_amount / 100);
                                            return (
                                                <div
                                                    key={plan.sku}
                                                    className="display-flex flex-1 flex-col rounded-md border-popup bg-senary p-4"
                                                >
                                                    <div className="display-flex flex-row items-center gap-2" style={{ marginBottom: '4px' }}>
                                                        <span className="text-base font-color-primary font-bold">{plan.name}</span>
                                                    </div>
                                                    <div className="text-xl font-color-primary font-bold">
                                                        {price}<span className="text-sm font-normal font-color-secondary">/{plan.interval || 'mo'}</span>
                                                    </div>
                                                    <div className="text-sm font-color-secondary" style={{ marginBottom: '8px' }}>
                                                        {plan.monthly_credits} credits per month
                                                    </div>
                                                    <div className="display-flex flex-col items-start gap-1">
                                                        <Button
                                                            variant={plan.highlight ? 'solid' : 'surface'}
                                                            onClick={() => subscribe(plan.sku)}
                                                            disabled={isBillingLoading}
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
                                            Unused credits roll over for 1 month
                                        </div>
                                    </div>

                                    {/* Credit pack card (secondary) */}
                                    {creditPacks.length > 0 && 
                                        <CreditPackCard
                                            pack={creditPacks[0]}
                                            buyCredits={buyCredits}
                                            isBillingLoading={isBillingLoading}
                                        />
                                    }
                                </div>
                            );
                        })()}
                    </>
                ) : (
                    <div className="display-flex flex-col gap-4">
                        <div className="display-flex flex-row items-center gap-3">
                            <div className="display-flex flex-col">
                                <div className="display-flex flex-row items-center gap-3">
                                    <div className="text-2xl font-color-primary font-bold">
                                        {creditPlan.plan ? creditPlan.plan.charAt(0).toUpperCase() + creditPlan.plan.slice(1) : ''}
                                    </div>
                                    {creditPlan.cancelAtPeriodEnd && (
                                        <span
                                            className="text-xs px-15 py-05 rounded-md"
                                            style={{ color: 'var(--tag-orange-secondary)', border: '1px solid var(--tag-orange-tertiary)', background: 'var(--tag-orange-quinary)' }}
                                        >
                                            Cancellation pending
                                        </span>
                                    )}
                                    {creditPlan.status === 'past_due' && (
                                        <span className="text-xs px-15 py-05 rounded-md" style={{ background: 'var(--tag-orange-tertiary)', color: 'var(--tag-orange-quinary)' }}>
                                            Past due
                                        </span>
                                    )}
                                </div>
                                {creditPlan.periodEnd && !creditPlan.cancelAtPeriodEnd && (
                                    <span className="text-sm font-color-secondary">
                                        Renews {new Date(creditPlan.periodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                        {' '}({Math.max(0, Math.ceil((new Date(creditPlan.periodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))} days)
                                    </span>
                                )}
                                {creditPlan.cancelAtPeriodEnd && creditPlan.periodEnd && (
                                    <span className="text-sm font-color-secondary">
                                        Your plan ends {new Date(creditPlan.periodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                        {' '}({Math.max(0, Math.ceil((new Date(creditPlan.periodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))} days remaining)
                                    </span>
                                )}
                            </div>
                            <div className="flex-1" />
                            <Button variant="outline" onClick={manageSubscription} disabled={isBillingLoading}>
                                {creditPlan.cancelAtPeriodEnd ? 'Resubscribe' : 'Manage'}
                            </Button>
                        </div>

                        {/* Progress bar — single combined pool */}
                        {(() => {
                            const pool = (creditPlan.monthlyCredits || 0) + (creditBreakdown.rolledOverCredits || 0);
                            const used = Math.min(profileBalance.monthlyCreditsUsed, pool);
                            const total = pool || 1;
                            const remaining = total - used;
                            const usedPct = Math.round((used / total) * 100);
                            const barColor = usedPct > 90 ? 'var(--tag-red-primary)' : usedPct > 70 ? 'var(--tag-yellow-primary)' : 'var(--color-accent, var(--fill-primary))';
                            return (
                                <div style={{ marginTop: '12px' }}>
                                    <div className="display-flex flex-row items-center gap-3" style={{ marginBottom: '4px' }}>
                                        <span className="text-sm font-color-primary font-medium">Plan Credits</span>
                                        <div className="flex-1" />
                                        <span className="text-sm font-color-primary font-medium">
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
                                        <div className="text-sm font-color-secondary" style={{ marginTop: '4px' }}>
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
                        })()}

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
                        <div className="display-flex flex-row items-center gap-3">
                            {/* <Button variant="outline" onClick={buyCredits} disabled={isBillingLoading}>
                                Buy Credits
                            </Button> */}
                            <span className="font-color-primary text-sm font-bold">
                                {(creditBreakdown.purchasedCredits || 0).toLocaleString()}
                            </span>
                        </div>
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
            </SettingsGroup>

            {/* --- Section 4: Cross-links --- */}
            <div className="display-flex flex-col gap-1" style={{ marginTop: '16px', paddingLeft: '2px' }}>
                <span
                    className="text-sm font-color-secondary text-link cursor-pointer"
                    onClick={() => Zotero.launchURL(`${process.env.WEBAPP_BASE_URL}/login`)}
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
