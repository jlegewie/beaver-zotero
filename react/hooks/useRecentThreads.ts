import { getCredentialGeneration } from "@beaver/agent-core/transport/credentials";
import { useEffect } from "react";
import { useSetAtom, useAtomValue } from "jotai";
import { recentThreadsAtom } from "../atoms/threads";
import { threadModelToThreadData } from "../utils/threadMatches";
import { supabase } from "@beaver/agent-core/transport/supabaseClient";
import { isAuthenticatedAtom, userAtom } from "../atoms/auth";

const MAX_THREADS = 6;

/**
 * Hook that subscribes to thread changes in Supabase and keeps
 * the most recent threads in the recentThreadsAtom
 */
export const useRecentThreads = (): void => {
    const setRecentThreads = useSetAtom(recentThreadsAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const userId = useAtomValue(userAtom)?.id;

    useEffect(() => {
        // Skip if user is not authenticated
        if (!isAuthenticated || !userId) return;

        const generation = getCredentialGeneration();
        let disposed = false;
        const isCurrent = () =>
            !disposed && generation === getCredentialGeneration();

        // Initial fetch of recent threads. This select must list every column
        // `threadModelToThreadData` reads: rows in recentThreadsAtom flow into
        // thread-open paths, identity-less rows would read as unattributed
        // (never mismatched), and a missing `starred` would read as unpinned —
        // disagreeing with the realtime payloads below, which carry whole rows.
        const fetchRecentThreads = async () => {
            const { data, error } = await supabase
                .from("threads")
                .select(
                    "id, name, created_at, updated_at, zotero_user_id, zotero_local_id, starred, agent_name",
                )
                .eq("user_id", userId)
                .order("updated_at", { ascending: false })
                .limit(MAX_THREADS);

            if (!isCurrent()) return;
            if (error) {
                console.error("Error fetching recent threads:", error);
                return;
            }

            setRecentThreads(data.map(threadModelToThreadData));
        };

        // Execute initial fetch
        fetchRecentThreads();

        // Set up realtime subscription
        const unsubscribe = Zotero.Beaver.account!.realtime.subscribe(
            "threads",
            userId,
            (payload) => {
                if (!isCurrent()) return;
                // Handle thread insertion or update
                if (["INSERT", "UPDATE"].includes(payload.eventType)) {
                    const updatedThread = threadModelToThreadData(
                        payload.new as any,
                    );

                    setRecentThreads((current) => {
                        // Remove the thread if it already exists in the list
                        const filteredThreads = current.filter(
                            (t) => t.id !== updatedThread.id,
                        );
                        // Add the updated thread at the beginning
                        filteredThreads.unshift(updatedThread);
                        // Sort by updated_at (newest first) and limit to MAX_THREADS
                        return filteredThreads
                            .sort(
                                (a, b) =>
                                    new Date(b.updatedAt).getTime() -
                                    new Date(a.updatedAt).getTime(),
                            )
                            .slice(0, MAX_THREADS);
                    });
                }

                // Handle thread deletion
                if (payload.eventType === "DELETE") {
                    const deletedThreadId = payload.old.id;
                    setRecentThreads((current) =>
                        current.filter((t) => t.id !== deletedThreadId),
                    );
                }
            },
        );

        // Clean up subscription on unmount
        return () => {
            disposed = true;
            unsubscribe();
        };
    }, [isAuthenticated, userId, setRecentThreads]);
};
