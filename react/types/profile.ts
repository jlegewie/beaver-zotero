
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
    monthly_chat_messages: number;
    initial_basic_page_grant: number;
    monthly_basic_page_grant: number;
    initial_advanced_page_grant: number;
    monthly_advanced_page_grant: number;
    // Features
    sync_database: boolean;
    upload_files: boolean;
    basic_document_processing: boolean;
    advanced_document_processing: boolean;
    allows_byok: boolean;
    rag_search: boolean;
    agentic_search: boolean;
    deep_research: boolean;
    // Limits
    max_file_size_mb: number;
    max_page_count: number;
    max_storage_gb: number;
    max_items_sync: number;
    max_chat_attachments_per_message: number;
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

/**
 * Profile interface representing user profile data (based on SafeProfileModel)
 */
export interface SafeProfileModel {
    user_id: string;             // UUID
    current_plan_id: string;     // UUID
    subscription_status: SubscriptionStatus;
    current_period_start?: Date;
    current_period_end?: Date;
    // Balances
    basic_page_balance: number;
    advanced_page_balance: number;
    purchased_advanced_page_balance: number;
    // Chat counters
    app_key_chats_count: number;
    user_key_chats_count: number;
}

export interface ProfileWithPlan extends SafeProfileModel {
    plan: SafePlanModel;
}
