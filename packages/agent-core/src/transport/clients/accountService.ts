import { ApiService, type RequestOptions } from '../apiService';
import { ExcludedLibrary, SafeProfileWithPlan } from '../../types/profile';
import { ModelConfig } from '../../types/models';
import { resolveClientIdentity } from '../clientIdentity';
import { logger } from '../../platform/logger';

interface FreeAuthorizationRequest {
    zotero_local_id: string;
    zotero_user_id: string | undefined;
    consent_to_share: boolean;
    email_notifications: boolean;
}

interface ProfileRequest {
    zotero_local_id: string;
    zotero_user_id: string | undefined;
    frontend_version: string;
    register_first_device: boolean;
}

interface ProfileResponse {
    profile: SafeProfileWithPlan
    model_configs: ModelConfig[]
    device_requires_authorization: boolean;
    required_data_version: number;
    minimum_frontend_version: string;
}

interface ExcludedLibrariesRequest {
    excluded_libraries: ExcludedLibrary[];
}


interface PreferenceRequest {
    preference: "consent_to_share" | "use_zotero_sync" | "email_notifications";
    value: boolean;
}

export interface PlanInfo {
    sku: string;
    name: string;
    monthly_credits: number;
    unit_amount: number;   // price in cents
    currency: string;
    interval: string | null;
    highlight: boolean;
    label: string | null;
}

interface PlansResponse {
    plans: PlanInfo[];
}

export interface ScheduledChange {
    sku: string;
    name: string;
    unit_amount: number;
    currency: string;
    interval: 'month' | 'year';
    effective_at: string;
}

interface ScheduledChangeResponse {
    scheduled_change: ScheduledChange | null;
}

interface CheckoutSessionRequest {
    sku: string;
    success_url: string;
    cancel_url: string;
}

interface CheckoutSessionResponse {
    checkout_url: string;
}

interface PortalSessionRequest {
    return_url: string;
}

interface PortalSessionResponse {
    portal_url: string;
}

interface UpgradeSessionRequest {
    target_sku: string;
    return_url: string;
}

interface UpgradeSessionResponse {
    portal_url: string;
}

interface ErrorReportRequest {
    message: string;
    jotai_atoms?: Record<string, any>;
    preferences?: Record<string, any>;
    local_db_state?: Record<string, any>;
}

export interface MigrationResponse {
    success: boolean;
    threads_migrated: number;
    runs_created: number;
    errors: string[];
    from_version: number;
    to_version: number;
    required_version: number;
}

/**
 * Account-specific API service that extends the base API service
 */
export class AccountService extends ApiService {
    /**
     * Creates a new AccountService instance
     * @param backendUrl The base URL of the backend API
     */
    constructor(backendUrl?: string) {
        super(backendUrl);
    }

    /**
     * Gets the base URL of this service
     * @returns The base URL
     */
    getBaseUrl(): string {
        return this.baseUrl;
    }

    /**
     * Fetches the user's profile
     * @returns Promise with the profile data
     */
    async getProfileWithPlan(options?: RequestOptions): Promise<ProfileResponse> {
        const { frontendVersion, zoteroInstance } = resolveClientIdentity();
        const { local_user_key: localUserKey = '', user_id: userID } = zoteroInstance ?? {};
        logger(`accountService.getProfileWithPlan: zotero_local_id=${localUserKey}, zotero_user_id=${userID}, version=${frontendVersion}`);

        try {
            const result = await this.post<ProfileResponse>('/api/v1/account/profile', {
                zotero_local_id: localUserKey,
                zotero_user_id: userID,
                frontend_version: frontendVersion,
                // Opt in to backend auto-registering this device. Backend guarded on
                // `has_authorized_free_access && zotero_local_ids == []`.
                register_first_device: true,
            } as ProfileRequest, options);
            logger(`accountService.getProfileWithPlan: success, has_authorized_access=${result.profile?.has_authorized_access}, has_authorized_free_access=${result.profile?.has_authorized_free_access}`);
            return result;
        } catch (error) {
            logger(`accountService.getProfileWithPlan: error=${error instanceof Error ? error.message : error}`, 2);
            throw error;
        }
    }

    /**
     * Records the user's consent and sets has_authorized_free_access.
     * Used by the onboarding page for accounts that have not yet consented
     * (accounts created on the website consent there).
     * 
     * @param consentToShare Whether user consents to share data
     * @param emailNotifications Whether user wants email notifications
     * @returns Promise with the response message
     */
    async authorizeFreeAccess(
        consentToShare: boolean = false,
        emailNotifications: boolean = false
    ): Promise<{ message: string }> {
        const { local_user_key: localUserKey = '', user_id: userID } = resolveClientIdentity().zoteroInstance ?? {};
        return this.post<{ message: string }>('/api/v1/account/authorize-free', {
            zotero_local_id: localUserKey,
            zotero_user_id: userID,
            consent_to_share: consentToShare,
            email_notifications: emailNotifications
        } as FreeAuthorizationRequest);
    }

    /**
     * Updates the user's preference
     * @param preference The preference to update
     * @param value The value to set for the preference
     * @returns Promise with the response message
     */
    async updatePreference(preference: PreferenceRequest["preference"], value: PreferenceRequest["value"]): Promise<{ message: string }> {
        return this.post<{ message: string }>('/api/v1/account/update-preference', {
            preference,
            value
        } as PreferenceRequest);
    }

    /**
     * Updates the user's excluded libraries.
     * @param excludedLibraries Libraries Beaver should not index, search, read, or write
     * @returns Promise with the response message
     */
    async updateExcludedLibraries(excludedLibraries: ExcludedLibrary[]): Promise<{ message: string }> {
        return this.post<{ message: string }>('/api/v1/account/update-excluded-libraries', {
            excluded_libraries: excludedLibraries,
        } as ExcludedLibrariesRequest);
    }

    /**
     * Reports an error with optional context information
     * @param message The error message to report
     * @param jotaiAtoms Optional Jotai atoms state for debugging
     * @param preferences Optional preferences for debugging
     * @param localDbState Optional local database state for debugging
     * @returns Promise with the response message
     */
    async reportError(
        message: string,
        jotaiAtoms?: Record<string, any>,
        preferences?: Record<string, any>,
        localDbState?: Record<string, any>
    ): Promise<{ message: string }> {
        return this.post<{ message: string }>('/api/v1/account/report-error', {
            message,
            jotai_atoms: jotaiAtoms,
            preferences,
            local_db_state: localDbState
        } as ErrorReportRequest);
    }

    /**
     * Triggers data migration for the user's account
     * @returns Promise with migration results
     */
    async migrateData(): Promise<MigrationResponse> {
        return this.post<MigrationResponse>('/api/v1/account/migrate-data', {});
    }

    /**
     * Fetches available plans with live Stripe pricing: monthly and yearly
     * subscriptions (`interval` 'month' / 'year') and credit packs (`interval` null).
     */
    async getPlans(): Promise<PlansResponse> {
        return this.get<PlansResponse>('/api/v1/billing/plans?include_annual=true');
    }

    async getScheduledChange(): Promise<ScheduledChangeResponse> {
        return this.get<ScheduledChangeResponse>('/api/v1/billing/scheduled-change');
    }

    /**
     * Creates a Stripe Checkout session for subscribing or purchasing credits
     */
    async createCheckoutSession(sku: string, successUrl: string, cancelUrl: string): Promise<CheckoutSessionResponse> {
        return this.post<CheckoutSessionResponse>('/api/v1/billing/create-checkout-session', {
            sku,
            success_url: successUrl,
            cancel_url: cancelUrl
        } as CheckoutSessionRequest);
    }

    /**
     * Creates a Stripe Customer Portal session for managing subscriptions
     */
    async createPortalSession(returnUrl: string): Promise<PortalSessionResponse> {
        return this.post<PortalSessionResponse>('/api/v1/billing/create-portal-session', {
            return_url: returnUrl
        } as PortalSessionRequest);
    }

    /**
     * Creates a Stripe Customer Portal deep link for upgrading an existing subscription.
     */
    async createUpgradeSession(targetSku: string, returnUrl: string): Promise<UpgradeSessionResponse> {
        return this.post<UpgradeSessionResponse>('/api/v1/billing/create-upgrade-session', {
            target_sku: targetSku,
            return_url: returnUrl
        } as UpgradeSessionRequest);
    }

    /**
     * Acknowledges the downgrade from Pro to Free
     * Sets has_authorized_free_access and clears pending_downgrade_ack.
     * @returns Promise with the response message
     */
    async acknowledgeDowngrade(): Promise<{ message: string }> {
        const { local_user_key: localUserKey = '', user_id: userID } = resolveClientIdentity().zoteroInstance ?? {};
        return this.post<{ message: string }>('/api/v1/account/acknowledge-downgrade', {
            zotero_local_id: localUserKey,
            zotero_user_id: userID,
        });
    }

    /**
     * Idempotently stamps `first_run_completed_at` on the user's profile.
     * Called when a Free user clicks a first-run suggestion card or "Skip"
     * on the FirstRunPage. Backend treats already-stamped as a no-op.
     *
     * @param completionKind 'skip' or a CardKind value
     */
    async completeFirstRun(completionKind?: string): Promise<{ message: string }> {
        return this.post<{ message: string }>('/api/v1/account/first-run/complete', {
            completion_kind: completionKind ?? null,
        });
    }
}

// Export accountService
export const accountService = new AccountService();
