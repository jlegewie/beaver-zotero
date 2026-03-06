import { useState, useCallback } from 'react';
import { accountService, PlanInfo } from '../../src/services/accountService';
import { logger } from '../../src/utils/logger';

const WEBAPP_BASE_URL = (process.env.WEBAPP_BASE_URL || '').replace(/\/$/, '');

export function useBilling() {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
            setPlansError(e?.message || 'Failed to load plans');
        } finally {
            setPlansLoading(false);
        }
    }, []);

    const subscribe = useCallback(async (sku = 'basic_monthly') => {
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
            setError(e?.message || 'Failed to start checkout');
        } finally {
            setIsLoading(false);
        }
    }, []);

    const buyCredits = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const { checkout_url } = await accountService.createCheckoutSession(
                'pack_50',
                `${WEBAPP_BASE_URL}/checkout/success`,
                `${WEBAPP_BASE_URL}/checkout/cancel`
            );
            Zotero.launchURL(checkout_url);
        } catch (e: any) {
            logger(`useBilling: buyCredits error - ${e?.message}`, 1);
            setError(e?.message || 'Failed to start checkout');
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
            setError(e?.message || 'Failed to open billing portal');
        } finally {
            setIsLoading(false);
        }
    }, []);

    return { subscribe, buyCredits, manageSubscription, isLoading, error, plans, plansLoading, plansError, fetchPlans };
}
