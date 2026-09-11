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

import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { getCredentialGeneration } from "@beaver/agent-core/transport/credentials";
import { providerConnection } from "@beaver/agent-core/transport/providerConnection";
import { logger } from "@beaver/agent-core/platform/logger";
import { isAuthenticatedAtom, sessionAtom } from "../atoms/auth";
import { isProfileLoadedAtom } from "../atoms/profile";
import { dataProviderEnabledAtom } from "../atoms/ui";

export function useProviderWake() {
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const isProfileLoaded = useAtomValue(isProfileLoadedAtom);
    const session = useAtomValue(sessionAtom);
    const enabled = useAtomValue(dataProviderEnabledAtom);

    const userId = session?.user?.id ?? null;

    useEffect(() => {
        if (!isAuthenticated || !isProfileLoaded || !enabled || !userId) {
            return;
        }

        let cancelled = false;
        const generation = getCredentialGeneration();

        const unsubscribe = Zotero.Beaver.account!.realtime.subscribe(
            "provider-wake",
            userId,
            (message) => {
                if (cancelled || generation !== getCredentialGeneration())
                    return;
                const payload = message.payload ?? {};
                logger(
                    `useProviderWake: Wake received (wake_id=${payload.wake_id})`,
                    1,
                );
                providerConnection
                    .connect({
                        wakeId: payload.wake_id,
                        wakeInstanceId: payload.instance_id,
                    })
                    .catch((err) => {
                        logger(
                            `useProviderWake: Provider connect after wake failed: ${err}`,
                            1,
                        );
                    });
            },
        );
        return () => {
            cancelled = true;
            unsubscribe();
            // Drop any open provider connection when the gate turns off
            // (logout or pref disabled). A server idle-close would arrive
            // eventually; this just makes the teardown immediate.
            providerConnection.close(
                1000,
                "Provider wake subscription stopped",
            );
        };
    }, [isAuthenticated, isProfileLoaded, enabled, userId]);
}
