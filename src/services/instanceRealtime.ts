import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

type Kind = "threads" | "provider-wake";
export interface ThreadChange {
    eventType: string;
    new: Record<string, unknown>;
    old: Record<string, unknown>;
}
export interface ProviderWake {
    payload?: { wake_id?: string; instance_id?: string };
}
interface Events {
    threads: ThreadChange;
    "provider-wake": ProviderWake;
}
interface Entry {
    topic: string;
    generation: number;
    listeners: Set<(event: any) => void>;
    channel?: RealtimeChannel;
    retry?: ReturnType<typeof setTimeout>;
}

/** Owns each user-scoped channel; renderer cleanup releases only its listener. */
export class InstanceRealtime {
    private entries = new Map<string, Entry>();
    private retiring = new Map<string, Promise<unknown>>();

    constructor(
        private client: SupabaseClient,
        private auth: SupabaseClient["auth"],
        private identity: () => { userId?: string; generation: number },
    ) {}

    subscribe<K extends Kind>(
        kind: K,
        userId: string,
        listener: (event: Events[K]) => void,
    ): () => void {
        const identity = this.identity();
        if (identity.userId !== userId) return () => {};
        const topic =
            kind === "threads"
                ? `recent-threads-${userId}`
                : `provider-wake:${userId}`;
        const ownedListener = (event: Events[K]) => listener(event);
        let entry = this.entries.get(topic);
        if (!entry) {
            entry = {
                topic,
                generation: identity.generation,
                listeners: new Set(),
            };
            this.entries.set(topic, entry);
            // Install the first listener before starting an asynchronous subscription.
            entry.listeners.add(ownedListener);
            void this.start(entry, kind, userId);
        } else entry.listeners.add(ownedListener);
        const owned = entry;
        return () => {
            owned.listeners.delete(ownedListener);
            if (!owned.listeners.size && this.entries.get(topic) === owned)
                this.release(owned);
        };
    }

    private current(entry: Entry): boolean {
        return (
            this.entries.get(entry.topic) === entry &&
            entry.generation === this.identity().generation
        );
    }

    private async start(
        entry: Entry,
        kind: Kind,
        userId: string,
    ): Promise<void> {
        try {
            // The SDK deduplicates topics until removeChannel has finished.
            await this.retiring.get(entry.topic);
            if (!this.current(entry)) return;
            if (kind === "provider-wake") {
                const { data, error } = await this.auth.getSession();
                if (!this.current(entry)) return;
                if (error) throw error;
                if (!data.session)
                    throw new Error("Realtime credentials unavailable");
                await this.client.realtime.setAuth(data.session.access_token);
                if (!this.current(entry)) return;
            }
            const channel = this.client.channel(entry.topic, {
                config: { private: kind === "provider-wake" },
            });
            entry.channel = channel;
            const dispatch = (event: unknown) => {
                if (!this.current(entry)) return;
                for (const listener of [...entry.listeners]) {
                    if (!this.current(entry)) break;
                    if (!entry.listeners.has(listener)) continue;
                    try {
                        listener(JSON.parse(JSON.stringify(event)));
                    } catch (error) {
                        Zotero.logError(error as Error);
                    }
                }
            };
            if (kind === "threads")
                channel.on(
                    "postgres_changes",
                    {
                        event: "*",
                        schema: "public",
                        table: "threads",
                        filter: `user_id=eq.${userId}`,
                    },
                    dispatch,
                );
            else channel.on("broadcast", { event: "wake" }, dispatch);
            channel.subscribe();
        } catch (error) {
            if (this.current(entry)) {
                Zotero.logError(error as Error);
                entry.retry = setTimeout(() => {
                    entry.retry = undefined;
                    if (this.current(entry))
                        void this.start(entry, kind, userId);
                }, 5000);
            }
        }
    }

    private release(entry: Entry): void {
        this.entries.delete(entry.topic);
        if (entry.retry) clearTimeout(entry.retry);
        entry.listeners.clear();
        if (!entry.channel) return;
        const pending = this.client
            .removeChannel(entry.channel)
            .catch((error) => Zotero.logError(error))
            .finally(() => {
                if (this.retiring.get(entry.topic) === pending)
                    this.retiring.delete(entry.topic);
            });
        this.retiring.set(entry.topic, pending);
    }

    clear(): void {
        for (const entry of this.entries.values()) this.release(entry);
    }
}
