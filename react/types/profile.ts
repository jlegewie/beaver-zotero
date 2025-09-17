import { ZoteroLibrary } from "./zotero";

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
    supported_file_types: string[];

    // Limits
    max_file_size_mb: number;
    max_page_count: number;
    max_storage_gb: number;
    max_user_attachments: number;
}

export interface PlanFeatures {
    databaseSync: boolean;
    uploadFiles: boolean;
    processingTier: ProcessingTier;
    maxUserAttachments: number;
    uploadFileSizeLimit: number;
    maxPageCount: number;
}

export interface ProfileBalance {
    pagesRemaining: number;
    chatMessagesRemaining: number;
}

/**
 * Subscription status enum (based on SubscriptionStatus)
 */
export enum SubscriptionStatus {
    FREE = "free",
    ACTIVE = "active",
    PAST_DUE = "past_due"
}

export enum ProcessingTier {
    NONE = "none",
    BASIC = "basic",
    STANDARD = "standard",
    ADVANCED = "advanced"
}

/**
 * Profile interface representing user profile data (based on SafeProfileModel)
 */
export interface SafeProfileModel {
    user_id: string;             // UUID

    // Library status
    library_status: ProcessingTier;
    
    // Subscription
    current_plan_id: string;     // UUID
    subscription_status: SubscriptionStatus;
    subscription_cancel_at_period_end: boolean;
    current_period_start?: Date;
    current_period_end?: Date;
    
    // Authorization and onboarding status
    zotero_user_id: string | null;
    zotero_local_ids: string[] | null;
    has_authorized_access: boolean;
    consented_at: Date;
    has_completed_onboarding: boolean;
    use_zotero_sync: boolean;
    consent_to_share: boolean;
    libraries?: ZoteroLibrary[];
    
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

export interface SafeProfileWithPlan extends SafeProfileModel {
    plan: SafePlanModel;
}
