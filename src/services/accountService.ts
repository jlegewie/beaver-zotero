import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { SafeProfileWithPlan, ProcessingTier } from '../../react/types/profile';
import { getZoteroUserIdentifier } from '../utils/zoteroIdentifier';
import { ApiError, ZoteroInstanceMismatchError } from '../../react/types/apiErrors';
import { FullModelConfig } from '../../react/atoms/models';
import { ZoteroLibrary } from '../../react/types/zotero';

interface AuthorizationRequest {
    zotero_local_id: string;
    zotero_user_id: string | undefined;
    libraries: ZoteroLibrary[];
    require_onboarding: boolean;
    processing_tier: ProcessingTier;
}

interface ProfileRequest {
    zotero_local_id: string;
    zotero_user_id: string | undefined;
}

interface ProfileResponse {
    profile: SafeProfileWithPlan
    model_configs: FullModelConfig[]
}

interface OnboardingRequest {
    processing_tier: ProcessingTier;
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
        const { userID, localUserKey } = getZoteroUserIdentifier();
        
        try {
            return await this.post<ProfileResponse>('/account/profile', {
                zotero_local_id: localUserKey,
                zotero_user_id: userID
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
            const endpoint = `${this.baseUrl}/account/model-configs?plan_id=${plan_id}`;
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
    async authorizeAccess(requireOnboarding: boolean = true, libraries: ZoteroLibrary[], processingTier: ProcessingTier): Promise<{ message: string }> {
        const { userID, localUserKey } = getZoteroUserIdentifier();
        return this.post<{ message: string }>('/account/authorize', {
            zotero_local_id: localUserKey,
            zotero_user_id: userID,
            require_onboarding: requireOnboarding,
            libraries: libraries,
            processing_tier: processingTier
        } as AuthorizationRequest);
    }

    /**
     * Authorizes a device to access the user's account
     * @returns Promise with the response message
     */
    async authorizeDevice(userID: string, localUserKey: string): Promise<{ message: string }> {
        return this.post<{ message: string }>('/account/authorize-device', {
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
        return this.post<{ message: string }>('/account/complete-onboarding', {
            processing_tier: processingTier
        } as OnboardingRequest);
    }
}

// Export accountService
export const accountService = new AccountService(API_BASE_URL); 