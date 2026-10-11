/**
 * Plugin-realm owner of item-import resolution (`addon.itemImport`).
 *
 * Resolution creates hidden browsers and makes long network calls, and the
 * agent-data-provider handlers that ask for it can run in a window's webpack
 * bundle. Owning the work here means a window closing mid-resolution cannot
 * strand hidden browsers or orphan timers: window code only calls
 * `Zotero.Beaver.itemImport.resolve(...)`. Writes go through
 * `addon.libraryOperations` like every other library write.
 */

import type { ImportItemSpec, ResolvedItem } from '@beaver/agent-core/types/itemImport';
import { resolveImportItems, type ResolveOptions } from './resolve';
import { probeAllZoteroApis, type ZoteroApiName, type ZoteroApiStatus } from './zoteroApis';

export class ItemImportService {
    private disposed = false;

    /** Resolve specs to item JSON without writing (same order as the input). */
    async resolve(specs: ImportItemSpec[], options: ResolveOptions): Promise<ResolvedItem[]> {
        if (this.disposed) throw Object.assign(new Error('Beaver is shutting down'), { code: 'shutting_down' });
        return resolveImportItems(specs, options);
    }

    /** Probe states of the internal Zotero APIs item import relies on. */
    capabilities(): Record<ZoteroApiName, ZoteroApiStatus> {
        return probeAllZoteroApis();
    }

    dispose(): void {
        this.disposed = true;
    }
}
