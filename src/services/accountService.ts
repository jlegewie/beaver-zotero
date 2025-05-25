import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { ProfileWithPlan } from '../../react/types/profile';

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
     * @returns Promise with the response message
     */
    async authorizeAccess(): Promise<{ message: string }> {
        return this.post<{ message: string }>('/account/authorize', {});
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