import { ProviderConnection } from '@beaver/agent-core/transport/providerConnection';
import { createZoteroDataProvider } from './zoteroDataProvider';
import type { InstanceAccount } from './instanceAccount';
import type { InstancePreferences } from './instancePreferences';
import { getPref } from '../utils/prefs';
import { registerEndpoints } from './localEndpoints/http';
import { registerMcpServer } from './localEndpoints/mcp';
import { captureInstanceOperation } from './localEndpoints/operation';

/** Own local ingress and the relay socket independently of renderer lifetimes. */
export class InstanceLocalEndpoints {
    readonly provider = new ProviderConnection(undefined, createZoteroDataProvider({
        source: 'provider', operationContext: captureInstanceOperation,
    }));
    private releases: Array<() => void> = [];
    private http?: () => void;
    private mcp?: () => void;
    private wake?: () => void;
    private wakeKey = '';
    private mcpKey = '';
    private generation = -1;
    private scope: number[] = [];
    private disposed = false;

    start(account: InstanceAccount, preferences: InstancePreferences): void {
        if (this.releases.length || this.disposed) return;
        const reconcile = () => {
            const snapshot = account.getSnapshot();
            const scope = Zotero.Beaver.searchableLibraryIds ?? [];
            if (this.generation !== snapshot.generation || this.scope.some(id => !scope.includes(id))) {
                this.provider.close(1000, 'Account or library access changed');
            }
            this.generation = snapshot.generation;
            this.scope = [...scope];
            const httpEnabled = !!snapshot.session && (process.env.NODE_ENV === 'development' || process.env.BUILD_ENV === 'staging');
            if (httpEnabled && !this.http) this.http = registerEndpoints();
            if (!httpEnabled) { this.http?.(); this.http = undefined; }
            const mcpKey = getPref('mcpServerEnabled') ? String(!!getPref('mcpCreateNoteToolEnabled')) : '';
            if (mcpKey !== this.mcpKey) {
                this.mcp?.(); this.mcp = undefined; this.mcpKey = mcpKey;
                if (mcpKey) this.mcp = registerMcpServer(mcpKey === 'true');
            }
            const wakeKey = snapshot.session && snapshot.data && snapshot.scopeReady && getPref('dataProviderEnabled')
                ? `${snapshot.generation}:${snapshot.session.user.id}` : '';
            if (wakeKey !== this.wakeKey) {
                this.wake?.(); this.wake = undefined;
                this.provider.close(1000, 'Provider eligibility changed');
                this.wakeKey = wakeKey;
                if (wakeKey) {
                    const generation = snapshot.generation;
                    this.wake = account.realtime.subscribe('provider-wake', snapshot.session!.user.id, message => {
                        if (this.disposed || this.wakeKey !== wakeKey || account.getGeneration() !== generation) return;
                        this.provider.connect({ wakeId: message.payload?.wake_id, wakeInstanceId: message.payload?.instance_id })
                            .catch(error => Zotero.logError(error));
                    });
                }
            }
        };
        this.releases.push(preferences.subscribe(reconcile), account.subscribe(reconcile));
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const release of this.releases.splice(0)) release();
        this.wake?.(); this.http?.(); this.mcp?.();
        this.provider.close(1000, 'Plugin shutdown');
    }
}
