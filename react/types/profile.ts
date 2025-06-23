
/**
 * Plan model interface based on backend SafePlanModel
 */
interface SafePlanModel {
    id: string; // UUID
    name: string;
    display_name: string;
    price_monthly: number;
    active: boolean;
    // Grants
    monthly_chat_credits: number;
    initial_page_grant: number;
    monthly_page_grant: number;
    // Features
    sync_database: boolean;
    upload_files: boolean;
    processing_tier: ProcessingTier;
    mcp_server: boolean;

    // Limits
    max_file_size_mb: number;
    max_page_count: number;
    max_storage_gb: number;
    max_user_attachments: number;
}

export interface PlanFeatures {
    databaseSync: boolean;
    uploadFiles: boolean;
    processing: ProcessingTier;
    maxUserAttachments: number;
}

export interface ProfileBalance {
    basicPagesRemaining: number;
    advancedPagesRemaining: number;
    chatMessagesRemaining: number;
}

/**
 * Subscription status enum (based on SubscriptionStatus)
 */
export enum SubscriptionStatus {
    ACTIVE = "active",           // Paid subscription that's current
    CANCELED = "canceled",       // User canceled but period not ended
    PAST_DUE = "past_due",       // Payment failed but grace period
    EXPIRED = "expired",         // Subscription period ended
    NONE = "none"                // No subscription
}

export enum ProcessingTier {
    BASIC = "basic",
    STANDARD = "standard",
    ADVANCED = "advanced"
}

/**
 * Profile interface representing user profile data (based on SafeProfileModel)
 */
export interface ProfileModel {
    user_id: string;             // UUID

    // Library status
    library_status: ProcessingTier;
    
    // Subscription
    current_plan_id: string;     // UUID
    subscription_status: SubscriptionStatus;
    current_period_start?: Date;
    current_period_end?: Date;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    
    // Authorization and onboarding status
    zotero_user_id: string | null;
    zotero_local_id: string | null;
    has_authorized_access: boolean;
    consented_at: Date;
    has_completed_onboarding: boolean;
    libraries?: Record<string, any>[];
    
    // Balances
    basic_page_balance: number;
    standard_page_balance: number;
    advanced_page_balance: number;
    purchased_basic_page_balance: number;
    purchased_standard_page_balance: number;
    purchased_advanced_page_balance: number;

    // Chat credits
    chat_credits_used: number;

    // Usage-based billing settings
    usage_based_billing_enabled: boolean;
    usage_based_billing_limit: number;
    usage_based_billing_cost: number;
}

export type SafeProfileModel = Omit<ProfileModel, 'stripe_customer_id' | 'stripe_subscription_id'>;

export interface ProfileWithPlan extends SafeProfileModel {
    plan: SafePlanModel;
}
