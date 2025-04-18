// @ts-ignore: Not sure why this is needed
import { useEffect, useRef } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { RealtimeChannel } from "@supabase/supabase-js";
import { profileWithPlanAtom } from '../atoms/profile';
import { isAuthenticatedAtom, userAtom } from '../atoms/auth';
import { accountService } from '../../src/services/accountService';
import { supabase } from '../../src/services/supabaseClient';
import { ProfileModel, SafeProfileModel } from '../types/profile';

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
            Zotero.debug(`useProfileSync: User ${userId} authenticated. Fetching profile and plan.`);
            try {
                // 1. Fetch initial ProfileWithPlan
                const fetchedProfileWithPlan = await accountService.getProfileWithPlan();
                setProfileWithPlan(fetchedProfileWithPlan);
                Zotero.debug(`useProfileSync: Successfully fetched profile and plan for ${userId}.`);

                // --- Realtime Setup ---
                if (channelRef.current) {
                    Zotero.debug(`useProfileSync: Removing existing channel subscription for ${userId}.`);
                    await channelRef.current.unsubscribe();
                    supabase.realtime.removeChannel(channelRef.current);
                    channelRef.current = null;
                }

                // 3. Get current session for the auth token (needed for realtime RLS)
                const { data: sessionData } = await supabase.auth.getSession();
                if (!sessionData.session?.access_token) {
                    Zotero.debug(`useProfileSync: No access token found, cannot set auth for realtime. Aborting subscription setup.`, 2);
                    return;
                }
                supabase.realtime.setAuth(sessionData.session.access_token);
                Zotero.debug(`useProfileSync: Realtime auth token set for ${userId}.`);

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
                            
                            Zotero.debug(`useProfileSync: Realtime profile UPDATE received for ${userId}: ${JSON.stringify(updatedProfileData)}`);

                            // Use functional update to safely access the previous state (prev)
                            let shouldRefetch = false;
                            setProfileWithPlan(prev => {
                                if (!prev) {
                                    // This case might happen if an update arrives before initial fetch completes
                                    // or after an error cleared the state. Safest is to wait for potential refetch.
                                    Zotero.debug(`useProfileSync: Received update but previous state is null. Scheduling potential refetch.`, 1);
                                    shouldRefetch = true; // Mark for refetch as we can't merge
                                    return null; // Keep state null for now
                                }

                                // Check if the plan ID changed
                                if (updatedProfileData.current_plan_id !== prev.current_plan_id) {
                                    Zotero.debug(`useProfileSync: current_plan_id changed (${prev.current_plan_id} -> ${updatedProfileData.current_plan_id}). Scheduling full refetch.`);
                                    shouldRefetch = true;
                                    // Return previous state temporarily; the refetch below will update it properly.
                                    return prev;
                                } else {
                                    // Merge if plan ID is the same
                                    Zotero.debug(`useProfileSync: Merging profile update as current_plan_id did not change.`);
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
                                        Zotero.debug(`useProfileSync: Refetching ProfileWithPlan for ${userId} due to plan_id change or null previous state.`);
                                        const refreshedProfileWithPlan = await accountService.getProfileWithPlan();
                                        // Set the state with the complete, fresh data
                                        setProfileWithPlan(refreshedProfileWithPlan);
                                        Zotero.debug(`useProfileSync: Successfully refreshed ProfileWithPlan for ${userId}.`);
                                    } catch (error: any) {
                                        Zotero.debug(`useProfileSync: Error refetching ProfileWithPlan after update check for ${userId}: ${error?.message}`, 3);
                                    }
                                })();
                            }
                        }
                    )
                    .subscribe((status, err) => {
                        if (err) {
                            Zotero.debug(`useProfileSync: Realtime subscription error for ${userId}: ${JSON.stringify(err)}`, 3);
                            console.error(`useProfileSync: realtime subscription error:`, err);
                        } else {
                            Zotero.debug(`useProfileSync: Realtime subscription status for ${userId}: ${status}`);
                        }
                    });

                channelRef.current = newChannel;

            } catch (error: any) {
                Zotero.debug(`useProfileSync: Error during initial fetch for ${userId}: ${error?.message}`, 3);
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
            Zotero.debug(`useProfileSync: User not authenticated or user data unavailable. Clearing profile.`);
            setProfileWithPlan(null);
            if (channelRef.current) {
                const userIdForUnsub = channelRef.current.topic.split(':').pop();
                Zotero.debug(`useProfileSync: Unsubscribing from channel due to logout/auth change for user ${userIdForUnsub}.`);
                channelRef.current.unsubscribe();
                supabase.realtime.removeChannel(channelRef.current);
                channelRef.current = null;
            }
        }

        // --- Cleanup Function ---
        return () => {
            if (channelRef.current) {
                const userIdForUnsub = channelRef.current.topic.split(':').pop();
                Zotero.debug(`useProfileSync: Cleaning up channel subscription for ${userIdForUnsub} on unmount/dependency change.`);
                channelRef.current.unsubscribe();
                supabase.realtime.removeChannel(channelRef.current);
                channelRef.current = null;
            } else {
                Zotero.debug(`useProfileSync: Cleanup called, no active channel to remove.`);
            }
        };
    }, [isAuthenticated, user, setProfileWithPlan]);
};