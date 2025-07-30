import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { SafeProfileWithPlan, ProcessingTier } from '../../react/types/profile';
import { getZoteroUserIdentifier } from '../utils/zoteroUtils';
import { ApiError, ZoteroInstanceMismatchError } from '../../react/types/apiErrors';
import { FullModelConfig } from '../../react/atoms/models';
import { ZoteroLibrary } from '../../react/types/zotero';

interface AuthorizationRequest {
    zotero_local_id: string;
    zotero_user_id: string | undefined;
    libraries: ZoteroLibrary[];
    require_onboarding: boolean;
    processing_tier: ProcessingTier;
    use_zotero_sync: boolean;
    consent_to_share: boolean;
}

interface ProfileRequest {
    zotero_local_id: string;
    zotero_user_id: string | undefined;
    frontend_version: string;
}

interface ProfileResponse {
    profile: SafeProfileWithPlan
    model_configs: FullModelConfig[]
    device_requires_authorization: boolean;
}

interface OnboardingRequest {
    processing_tier: ProcessingTier;
}


interface PreferenceRequest {
    preference: "consent_to_share" | "use_zotero_sync";
    value: boolean;
}

interface ErrorReportRequest {
    message: string;
    jotai_atoms?: Record<string, any>;
    preferences?: Record<string, any>;
    local_db_state?: Record<string, any>;
}

/**
 * Account-specific API service that extends the base API service
 */
export class AccountService extends ApiService {
    /**
     * Creates a new AccountService instance
     * @param backendUrl The base URL of the backend API
     */
    constructor(backendUrl: string) {
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
     * Fetches the user's profile including the plan name
     * @returns Promise with the profile data
     */
    async getProfileWithPlan(): Promise<ProfileResponse> {
        const version = Zotero.Beaver.pluginVersion || '';
        const { userID, localUserKey } = getZoteroUserIdentifier();
        
        try {
            return await this.post<ProfileResponse>('/api/v1/account/profile', {
                zotero_local_id: localUserKey,
                zotero_user_id: userID,
                frontend_version: version
            } as ProfileRequest);
        } catch (error) {
            // Handle profile-specific 403 errors as Zotero instance mismatch
            if (error instanceof ApiError && error.status === 403) {
                throw new ZoteroInstanceMismatchError();
            }
            // Re-throw other errors as-is
            throw error;
        }
    }

    /**
     * Fetches the list of models supported by the backend
     * @returns Promise resolving to an array of supported models
     */
    async getModelList(plan_id: string): Promise<FullModelConfig[]> {
        try {
            const endpoint = `${this.baseUrl}/api/v1/account/model-configs?plan_id=${plan_id}`;
            const headers = await this.getAuthHeaders();
            
            const response = await Zotero.HTTP.request('GET', endpoint, {
                headers,
                responseType: 'json'
            });
            
            return response.response as FullModelConfig[];
        } catch (error) {
            Zotero.debug(`ChatService: getModelList error - ${error}`, 1);
            // Return empty array on error
            return [];
        }
    }

    /**
     * Sets the user's authorization status to authorized and records consent timestamp
     * @param requireOnboarding Whether the user needs to complete onboarding
     * @returns Promise with the response message
     */
    async authorizeAccess(
        requireOnboarding: boolean = true,
        libraries: ZoteroLibrary[],
        processingTier: ProcessingTier,
        syncWithZotero: boolean = false,
        consentToShare: boolean = false
    ): Promise<{ message: string }> {
        const { userID, localUserKey } = getZoteroUserIdentifier();
        return this.post<{ message: string }>('/api/v1/account/authorize', {
            zotero_local_id: localUserKey,
            zotero_user_id: userID,
            require_onboarding: requireOnboarding,
            libraries: libraries,
            processing_tier: processingTier,
            use_zotero_sync: syncWithZotero,
            consent_to_share: consentToShare
        } as AuthorizationRequest);
    }

    /**
     * Authorizes a device to access the user's account
     * @returns Promise with the response message
     */
    async authorizeDevice(userID: string, localUserKey: string): Promise<{ message: string }> {
        return this.post<{ message: string }>('/api/v1/account/authorize-device', {
            
            zotero_local_id: localUserKey,
            zotero_user_id: userID
        } as AuthorizationRequest);
    }

    /**
     * Sets the user's onboarding status to completed
     * @param processingTier The processing tier to set for the user
     * @returns Promise with the response message
     */
    async completeOnboarding(processingTier: ProcessingTier): Promise<{ message: string }> {
        return this.post<{ message: string }>('/api/v1/account/complete-onboarding', {
            processing_tier: processingTier
        } as OnboardingRequest);
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
}

// Export accountService
export const accountService = new AccountService(API_BASE_URL); 