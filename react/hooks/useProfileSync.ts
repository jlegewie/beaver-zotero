// @ts-ignore: Not sure why this is needed
import { useEffect, useRef } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { RealtimeChannel } from "@supabase/supabase-js";
import { fileUploader } from '../../src/services/FileUploader';
import { profileWithPlanAtom } from '../atoms/profile';
import { isAuthenticatedAtom, userAtom } from '../atoms/auth';
import { accountService } from '../../src/services/accountService';
import { supabase } from '../../src/services/supabaseClient';
import { ProfileModel, SafeProfileModel } from '../types/profile';
import { logger } from '../../src/utils/logger';

// Helper function to strip sensitive fields (optional, but cleans up the callback)
const toSafeProfileModel = (profile: ProfileModel): SafeProfileModel => {
    const {
        stripe_customer_id,
        stripe_subscription_id,
        ...safeData
    } = profile;
    return safeData;
};

/**
 * Hook to synchronize the user's profile and plan data (ProfileWithPlan)
 * with the backend and subscribe to realtime updates for the profile portion.
 * Refetching the full ProfileWithPlan if the current_plan_id changes;
 * otherwise, merges the profile update.
 */
export const useProfileSync = () => {
    const setProfileWithPlan = useSetAtom(profileWithPlanAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const user = useAtomValue(userAtom);
    const channelRef = useRef<RealtimeChannel | null>(null);

    useEffect(() => {
        const syncProfileData = async (userId: string) => {
            logger(`useProfileSync: User ${userId} authenticated. Fetching profile and plan.`);
            try {
                // 1. Fetch initial ProfileWithPlan
                const fetchedProfileWithPlan = await accountService.getProfileWithPlan();
                setProfileWithPlan(fetchedProfileWithPlan);
                logger(`useProfileSync: Successfully fetched profile and plan for ${userId}.`);

                // --- Realtime Setup ---
                if (channelRef.current) {
                    logger(`useProfileSync: Removing existing channel subscription for ${userId}.`);
                    await channelRef.current.unsubscribe();
                    supabase.realtime.removeChannel(channelRef.current);
                    channelRef.current = null;
                }

                // 3. Get current session for the auth token (needed for realtime RLS)
                const { data: sessionData } = await supabase.auth.getSession();
                if (!sessionData.session?.access_token) {
                    logger(`useProfileSync: No access token found, cannot set auth for realtime. Aborting subscription setup.`, 2);
                    return;
                }
                supabase.realtime.setAuth(sessionData.session.access_token);
                logger(`useProfileSync: Realtime auth token set for ${userId}.`);

                // 4. Create and subscribe to the channel for PROFILE updates
                const newChannel = supabase
                    .channel(`public:profiles:${userId}`)
                    .on<ProfileModel>(
                        'postgres_changes',
                        {
                            event: 'UPDATE',
                            schema: 'public',
                            table: 'profiles',
                            filter: `user_id=eq.${userId}`,
                        },
                        // Realtime Update Handler
                        (payload) => {
                            const updatedProfileData = toSafeProfileModel(payload.new);
                            ztoolkit.log(`useProfileSync: Realtime profile UPDATE received for ${userId}: ${JSON.stringify(updatedProfileData)}`);
                            logger(`useProfileSync: Realtime profile UPDATE received for ${userId}: ${JSON.stringify(updatedProfileData)}`);

                            // Use functional update to safely access the previous state (prev)
                            let shouldRefetch = false;
                            setProfileWithPlan(prev => {
                                if (!prev) {
                                    // This case might happen if an update arrives before initial fetch completes
                                    // or after an error cleared the state. Safest is to wait for potential refetch.
                                    logger(`useProfileSync: Received update but previous state is null. Scheduling potential refetch.`, 1);
                                    shouldRefetch = true; // Mark for refetch as we can't merge
                                    return null; // Keep state null for now
                                }

                                // Check if the plan ID changed
                                if (updatedProfileData.current_plan_id !== prev.current_plan_id) {
                                    logger(`useProfileSync: current_plan_id changed (${prev.current_plan_id} -> ${updatedProfileData.current_plan_id}). Scheduling full refetch.`);
                                    shouldRefetch = true;
                                    // Return previous state temporarily; the refetch below will update it properly.
                                    return prev;
                                } else {
                                    // Merge if plan ID is the same
                                    logger(`useProfileSync: Merging profile update as current_plan_id did not change.`);
                                    // Create a new object merging previous state with new profile data.
                                    return {
                                        ...prev,
                                        ...updatedProfileData
                                    };
                                }
                            });

                            // Trigger refetch AFTER state update logic if needed
                            if (shouldRefetch) {
                                (async () => {
                                    try {
                                        logger(`useProfileSync: Refetching ProfileWithPlan for ${userId} due to plan_id change or null previous state.`);
                                        const refreshedProfileWithPlan = await accountService.getProfileWithPlan();
                                        // Set the state with the complete, fresh data
                                        setProfileWithPlan(refreshedProfileWithPlan);
                                        logger(`useProfileSync: Successfully refreshed ProfileWithPlan for ${userId}.`);
                                        // If the plan allows file uploads, start the file uploader
                                        if (refreshedProfileWithPlan.plan.upload_files) {
                                            fileUploader.start();
                                        }
                                    } catch (error: any) {
                                        logger(`useProfileSync: Error refetching ProfileWithPlan after update check for ${userId}: ${error?.message}`, 3);
                                    }
                                })();
                            }
                        }
                    )
                    .subscribe((status, err) => {
                        if (err) {
                            logger(`useProfileSync: Realtime subscription error for ${userId}: ${JSON.stringify(err)}`, 3);
                            console.error(`useProfileSync: realtime subscription error:`, err);
                        } else {
                            logger(`useProfileSync: Realtime subscription status for ${userId}: ${status}`);
                        }
                    });

                channelRef.current = newChannel;

            } catch (error: any) {
                logger(`useProfileSync: Error during initial fetch for ${userId}: ${error?.message}`, 3);
                setProfileWithPlan(null);
                if (channelRef.current) {
                    await channelRef.current.unsubscribe();
                    supabase.realtime.removeChannel(channelRef.current);
                    channelRef.current = null;
                }
            }
        };

        // --- Effect Logic ---
        if (isAuthenticated && user) {
            syncProfileData(user.id);
        } else {
            logger(`useProfileSync: User not authenticated or user data unavailable. Clearing profile.`);
            setProfileWithPlan(null);
            if (channelRef.current) {
                const userIdForUnsub = channelRef.current.topic.split(':').pop();
                logger(`useProfileSync: Unsubscribing from channel due to logout/auth change for user ${userIdForUnsub}.`);
                channelRef.current.unsubscribe();
                supabase.realtime.removeChannel(channelRef.current);
                channelRef.current = null;
            }
        }

        // --- Cleanup Function ---
        return () => {
            if (channelRef.current) {
                const userIdForUnsub = channelRef.current.topic.split(':').pop();
                logger(`useProfileSync: Cleaning up channel subscription for ${userIdForUnsub} on unmount/dependency change.`);
                channelRef.current.unsubscribe();
                supabase.realtime.removeChannel(channelRef.current);
                channelRef.current = null;
            } else {
                logger(`useProfileSync: Cleanup called, no active channel to remove.`);
            }
        };
    }, [isAuthenticated, user, setProfileWithPlan]);
};