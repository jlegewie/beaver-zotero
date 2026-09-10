import { config } from "../../package.json";

/** One native preference observer and subscriptions, independent of renderer lifetime. */
export class InstancePreferences {
    private revision = 0;
    private disposed = false;
    private listeners = new Set<
        (change: { revision: number; key: string }) => void
    >();
    private readonly prefix = `${config.prefsPrefix}.`;
    private readonly observer = {
        observe: (_subject: unknown, _topic: string, key: string) => {
            const change = {
                revision: ++this.revision,
                key: key.slice(this.prefix.length),
            };
            for (const listener of [...this.listeners]) {
                try {
                    listener({ ...change });
                } catch (error) {
                    Zotero.logError(error as Error);
                }
            }
        },
    };
    constructor() {
        Services.prefs.addObserver(this.prefix, this.observer);
    }
    getSnapshot(): { revision: number } {
        return { revision: this.revision };
    }
    subscribe(
        listener: (change: { revision: number; key: string }) => void,
    ): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        Services.prefs.removeObserver(this.prefix, this.observer);
        this.listeners.clear();
    }
}
