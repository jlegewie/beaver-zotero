import { ApiService } from './apiService';
import API_BASE_URL from '../utils/getAPIBaseURL';
import { ProfileWithPlanName } from '../../react/types/profile';

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
    async getProfile(): Promise<ProfileWithPlanName> {
        // The backend endpoint is /account/profile, but the ApiService
        // likely assumes the base URL includes the base path.
        // Adjust the path if necessary based on ApiService implementation.
        return this.get<ProfileWithPlanName>('/account/profile');
    }
}

// Export accountService
export const accountService = new AccountService(API_BASE_URL); 