import { useState, useCallback } from 'react';
import { accountService, PlanInfo } from '@beaver/agent-core/transport/clients/accountService';
import { isApiError, isServerError } from '@beaver/agent-core/types/apiErrors';
import { logger } from '@beaver/agent-core/platform/logger';

const WEBAPP_BASE_URL = (process.env.WEBAPP_BASE_URL || '').replace(/\/$/, '');

export type BillingAction = 'subscribe' | 'buyCredits' | 'manageSubscription' | 'upgradeSubscription';

const ACTION_ERROR_MESSAGES: Record<BillingAction, string> = {
    subscribe: "Couldn't open checkout. Please try again.",
    buyCredits: "Couldn't open checkout. Please try again.",
    manageSubscription: "Couldn't open the billing portal. Please try again.",
    upgradeSubscription: "Couldn't open the upgrade page. Please try again or use Manage.",
};

export function useBilling() {
    const [isLoading, setIsLoading] = useState(false);
    // A short user-facing message plus the action that produced it, so the UI
    // can show the failure next to the control the user clicked.
    const [errorState, setErrorState] = useState<{ action: BillingAction, message: string } | null>(null);
    const setError = useCallback((action: BillingAction | null) => {
        setErrorState(action ? { action, message: ACTION_ERROR_MESSAGES[action] } : null);
    }, []);

    const [plans, setPlans] = useState<PlanInfo[]>([]);
    const [plansLoading, setPlansLoading] = useState(false);
    const [plansError, setPlansError] = useState<string | null>(null);

    const fetchPlans = useCallback(async () => {
        setPlansLoading(true);
        setPlansError(null);
        try {
            const { plans: fetchedPlans } = await accountService.getPlans();
            setPlans(fetchedPlans);
        } catch (e: any) {
            logger(`useBilling: fetchPlans error - ${e?.message}`, 1);
            const message = isApiError(e) || isServerError(e)
                ? 'Unable to load plan details'
                : (e?.message || 'Unable to load plan details');
            setPlansError(message);
        } finally {
            setPlansLoading(false);
        }
    }, []);

    const subscribe = useCallback(async (sku = 'plus_monthly') => {
        setIsLoading(true);
        setError(null);
        try {
            const { checkout_url } = await accountService.createCheckoutSession(
                sku,
                `${WEBAPP_BASE_URL}/checkout/success`,
                `${WEBAPP_BASE_URL}/checkout/cancel`
            );
            Zotero.launchURL(checkout_url);
        } catch (e: any) {
            logger(`useBilling: subscribe error - ${e?.message}`, 1);
            setError('subscribe');
        } finally {
            setIsLoading(false);
        }
    }, []);

    const buyCredits = useCallback(async (sku = 'pack_50') => {
        setIsLoading(true);
        setError(null);
        try {
            const { checkout_url } = await accountService.createCheckoutSession(
                sku,
                `${WEBAPP_BASE_URL}/checkout/success`,
                `${WEBAPP_BASE_URL}/checkout/cancel`
            );
            Zotero.launchURL(checkout_url);
        } catch (e: any) {
            logger(`useBilling: buyCredits error - ${e?.message}`, 1);
            setError('buyCredits');
        } finally {
            setIsLoading(false);
        }
    }, []);

    const manageSubscription = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const { portal_url } = await accountService.createPortalSession(
                `${WEBAPP_BASE_URL}/checkout/return`
            );
            Zotero.launchURL(portal_url);
        } catch (e: any) {
            logger(`useBilling: manageSubscription error - ${e?.message}`, 1);
            setError('manageSubscription');
        } finally {
            setIsLoading(false);
        }
    }, []);

    const upgradeSubscription = useCallback(async (targetSku: string) => {
        setIsLoading(true);
        setError(null);
        try {
            const { portal_url } = await accountService.createUpgradeSession(
                targetSku,
                `${WEBAPP_BASE_URL}/checkout/return`
            );
            Zotero.launchURL(portal_url);
        } catch (e: any) {
            logger(`useBilling: upgradeSubscription error - ${e?.message}`, 1);
            setError('upgradeSubscription');
        } finally {
            setIsLoading(false);
        }
    }, []);

    return { subscribe, buyCredits, manageSubscription, upgradeSubscription, isLoading, error: errorState?.message ?? null, errorAction: errorState?.action ?? null, plans, plansLoading, plansError, fetchPlans };
}
