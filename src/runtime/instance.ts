import { ReaderWidthDispatcher } from './readerWidth';
/** Window handles are registered only for the lifetime of their renderer. */
export interface WindowRuntime {
    readonly id: string;
    readonly hostWindow: Window;
    readonly contextWindow: Window;
    readonly events: EventTarget;
    status: 'attaching' | 'ready' | 'closing';
}

export class BeaverInstance {
    private windows = new Map<Window, WindowRuntime>();
    private nextId = 0;
    private readonly idPrefix = `main-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    private disposed = false;
    private widthListeners = new Map<WindowRuntime, () => void>();
    readonly readerWidth = new ReaderWidthDispatcher();
    private subscriptions = new Map<WindowRuntime, Set<() => void>>();
    private notifications = new Map<string, Set<(detail: any) => void>>();
    private endpointOwners = new Map<string, Map<WindowRuntime, { handler: any; release: () => void }>>();

    attachWindow(win: Window): WindowRuntime {
        if (this.disposed) throw new Error('Beaver instance disposed');
        const existing = this.windows.get(win);
        if (existing) return existing;
        const runtime: WindowRuntime = {
            id: `${this.idPrefix}-${++this.nextId}`, hostWindow: win, contextWindow: win,
            events: new win.EventTarget(), status: 'attaching',
        };
        this.windows.set(win, runtime);
        win.__beaverRuntime = runtime;
        win.__beaverEventBus = runtime.events;
        return runtime;
    }

    getWindow(win: Window): WindowRuntime | undefined { return this.windows.get(win); }
    resolveWindow(id?: string): WindowRuntime | undefined {
        const runtime = id !== undefined
            ? [...this.windows.values()].find(value => value.id === id)
            : this.windows.get(Zotero.getMainWindow());
        return runtime?.status === 'ready' && !runtime.hostWindow.closed ? runtime : undefined;
    }
    getSnapshot(): Array<{ id: string; status: WindowRuntime['status'] }> {
        return Array.from(this.windows.values(), ({ id, status }) => ({ id, status }));
    }
    markClosing(win: Window): boolean {
        const runtime = this.windows.get(win);
        if (!runtime || runtime.status === 'closing') return false;
        runtime.status = 'closing';
        this.widthListeners.get(runtime)?.();
        this.widthListeners.delete(runtime);
        for (const unsubscribe of this.subscriptions.get(runtime) ?? []) unsubscribe();
        this.subscriptions.delete(runtime);
        return true;
    }
    detachWindow(win: Window): void {
        const runtime = this.windows.get(win);
        if (!runtime) return;
        this.markClosing(win);
        this.windows.delete(win);
        delete win.__beaverRuntime;
        delete win.__beaverJotaiStore;
        win.__beaverEventBus = null;
    }

    subscribeWindow(runtime: WindowRuntime, name: string, callback: (detail: any) => void): () => void {
        if (runtime.status === 'closing' || this.windows.get(runtime.hostWindow) !== runtime) return () => {};
        let subscriptions = this.subscriptions.get(runtime);
        if (!subscriptions) this.subscriptions.set(runtime, subscriptions = new Set());
        const remove = this.subscribe(name, detail => {
            if (runtime.status !== 'closing') callback(detail);
        });
        const unsubscribe = () => { remove(); subscriptions.delete(unsubscribe); };
        subscriptions.add(unsubscribe);
        return unsubscribe;
    }

    subscribe(name: string, callback: (detail: any) => void): () => void {
        if (this.disposed) return () => {};
        let listeners = this.notifications.get(name);
        if (!listeners) this.notifications.set(name, listeners = new Set());
        listeners.add(callback);
        return () => {
            listeners.delete(callback);
            if (!listeners.size) this.notifications.delete(name);
        };
    }

    /** Keep a global endpoint backed by a live, authenticated renderer. */
    registerWindowEndpoint(runtime: WindowRuntime, path: string, handler: any): () => void {
        if (this.disposed || runtime.status === 'closing' || this.windows.get(runtime.hostWindow) !== runtime) return () => {};
        this.endpointOwners.get(path)?.get(runtime)?.release();
        let owners = this.endpointOwners.get(path);
        if (!owners) this.endpointOwners.set(path, owners = new Map());
        let subscriptions = this.subscriptions.get(runtime);
        if (!subscriptions) this.subscriptions.set(runtime, subscriptions = new Set());
        const release = () => {
            if (owners.get(runtime)?.release !== release) return;
            owners.delete(runtime);
            subscriptions.delete(release);
            if (!owners.size) this.endpointOwners.delete(path);
            const endpoints = Zotero.Server?.Endpoints;
            if (endpoints?.[path] === handler) {
                const successor = [...owners.values()].pop();
                if (successor) endpoints[path] = successor.handler;
                else delete endpoints[path];
            }
        };
        owners.set(runtime, { handler, release });
        subscriptions.add(release);
        Zotero.Server.Endpoints[path] = handler;
        return release;
    }
    publish(name: string, detail: unknown): void {
        // Retained state and subscribers never receive a caller-owned mutable object.
        if (this.disposed || Zotero.__beaverShuttingDown) return;
        const serialized = JSON.stringify(detail);
        for (const callback of [...(this.notifications.get(name) ?? [])]) {
            try { callback(serialized === undefined ? undefined : JSON.parse(serialized)); } catch (error) { Zotero.logError(error as Error); }
        }
    }

    subscribeReaderWidth(runtime: WindowRuntime, callback: () => void): () => void {
        if (runtime.status === 'closing' || this.disposed) return () => {};
        this.widthListeners.get(runtime)?.();
        const unsubscribe = this.readerWidth.subscribe(() => {
            if (runtime.status !== 'closing') callback();
        });
        this.widthListeners.set(runtime, unsubscribe);
        return () => {
            unsubscribe();
            if (this.widthListeners.get(runtime) === unsubscribe) this.widthListeners.delete(runtime);
        };
    }

    disposeInstance(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const win of this.windows.keys()) this.detachWindow(win);
        this.notifications.clear();
        this.widthListeners.clear();
        this.readerWidth.dispose();
    }
}
