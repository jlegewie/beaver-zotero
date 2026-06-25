/**
 * Provider-wake subscription.
 *
 * While the user is logged in and the data-provider pref is enabled, this
 * hook keeps a lightweight Supabase Realtime subscription open on the private
 * topic `provider-wake:<beaver_uid>`. When the backend broadcasts a wake
 * (an agent run on another Beaver client needs Zotero data), the plugin opens
 * a provider-mode WebSocket that serves data requests and idle-closes.
 *
 * This subscription is the ONLY thing kept persistently open for provider
 * mode — there is no standing agent WebSocket.
 *
 * The topic is private (RLS on realtime.messages): the channel must be
 * created with `private: true` and realtime auth must carry the user's JWT.
 */

import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../../src/services/supabaseClient';
import { providerConnection } from '../../src/services/providerConnection';
import { logger } from '../../src/utils/logger';
import { isAuthenticatedAtom, sessionAtom } from '../atoms/auth';
import { dataProviderEnabledAtom } from '../atoms/ui';

export function useProviderWake() {
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const session = useAtomValue(sessionAtom);
    const enabled = useAtomValue(dataProviderEnabledAtom);
    const channelRef = useRef<RealtimeChannel | null>(null);

    const userId = session?.user?.id ?? null;

    useEffect(() => {
        if (!isAuthenticated || !enabled || !userId) {
            return;
        }

        let cancelled = false;

        const subscribe = async () => {
            try {
                // Private channels authorize against realtime.messages RLS with
                // the user's JWT — make sure realtime has a fresh token.
                const { data: sessionData } = await supabase.auth.getSession();
                if (cancelled) return;
                if (sessionData.session?.access_token) {
                    supabase.realtime.setAuth(sessionData.session.access_token);
                }

                const channel = supabase
                    .channel(`provider-wake:${userId}`, { config: { private: true } })
                    .on('broadcast', { event: 'wake' }, (message) => {
                        const payload = (message as any)?.payload ?? {};
                        logger(`useProviderWake: Wake received (wake_id=${payload.wake_id})`, 1);
                        providerConnection.connect({
                            wakeId: payload.wake_id,
                            wakeInstanceId: payload.instance_id,
                        }).catch((err) => {
                            logger(`useProviderWake: Provider connect after wake failed: ${err}`, 1);
                        });
                    })
                    .subscribe((status, err) => {
                        logger(
                            `useProviderWake: Subscription status ${status}${err ? ` (${err.message})` : ''}`,
                            err ? 3 : 1,
                        );
                    });
                channelRef.current = channel;
                logger(`useProviderWake: Subscribed to provider-wake channel`, 1);
            } catch (error) {
                logger(`useProviderWake: Failed to subscribe: ${error}`, 3);
            }
        };

        subscribe();

        return () => {
            cancelled = true;
            const channel = channelRef.current;
            channelRef.current = null;
            if (channel) {
                supabase.realtime.removeChannel(channel).catch((err: unknown) => {
                    logger(`useProviderWake: Failed to remove channel: ${err}`, 1);
                });
            }
            // Drop any open provider connection when the gate turns off
            // (logout or pref disabled). A server idle-close would arrive
            // eventually; this just makes the teardown immediate.
            providerConnection.close(1000, 'Provider wake subscription stopped');
        };
    }, [isAuthenticated, enabled, userId]);
}
