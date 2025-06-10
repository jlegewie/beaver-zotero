import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { ProfileWithPlan } from '../../react/types/profile';
import { getZoteroUserIdentifier } from '../utils/zoteroIdentifier';

interface AuthorizationRequest {
    zotero_local_id: string;
    zotero_user_id: string | undefined;
    require_onboarding: boolean;
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
    async getProfileWithPlan(): Promise<ProfileWithPlan> {
        return this.get<ProfileWithPlan>('/account/profile');
    }

    /**
     * Sets the user's authorization status to authorized and records consent timestamp
     * @param requireOnboarding Whether the user needs to complete onboarding
     * @returns Promise with the response message
     */
    async authorizeAccess(requireOnboarding: boolean = true): Promise<{ message: string }> {
        const { userID, localUserKey } = getZoteroUserIdentifier();
        return this.post<{ message: string }>('/account/authorize', {
            zotero_local_id: localUserKey,
            zotero_user_id: userID,
            require_onboarding: requireOnboarding
        } as AuthorizationRequest);
    }

    /**
     * Sets the user's onboarding status to completed
     * @returns Promise with the response message
     */
    async completeOnboarding(): Promise<{ message: string }> {
        return this.post<{ message: string }>('/account/complete-onboarding', {});
    }
}

// Export accountService
export const accountService = new AccountService(API_BASE_URL); 