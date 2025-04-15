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
 * Profile interface representing user profile data (based on ProfileModel)
 */
export interface Profile {
    user_id: string;             // UUID
    current_plan_id: string;     // UUID
    subscription_status: SubscriptionStatus;
    current_period_start?: Date;
    current_period_end?: Date;
    stripe_customer_id?: string;
    stripe_subscription_id?: string;
    basic_page_balance: number;
    advanced_page_balance: number;
    purchased_advanced_page_balance: number;
    app_key_chats_count: number;
    user_key_chats_count: number;
}

export interface ProfileWithPlanName extends Profile {
    plan_name: string;
    display_name: string;
}
