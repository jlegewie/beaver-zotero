import { LibraryOperations } from '../../src/services/libraryOperations';
import { LibraryMutations } from '../../src/services/libraryMutations';
import { NotePreviews } from '../../src/services/notePreviews';

/** Install real instance coordination in tests that replace the Zotero singleton. */
export function installMutationInstance() {
    const zotero = (globalThis as any).Zotero;
    zotero.Items ??= {};
    zotero.Items.getIDFromLibraryAndKey ??= () => undefined;
    zotero.Beaver ??= {};
    zotero.Beaver.data ??= { env: "production" };
    zotero.Beaver.libraryOperations = new LibraryOperations();
    zotero.Beaver.mutations = new LibraryMutations();
    zotero.Beaver.notePreviews = new NotePreviews();
    zotero.Beaver.libraryScopeInitialized = true;
    zotero.Beaver.searchableLibraryIds = [1, 2];
}
