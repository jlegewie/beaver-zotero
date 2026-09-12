/**
 * User-facing counterpart of `excludedLibraryMessage`, for exclusion failures
 * surfaced directly in the UI (e.g. an undo the user clicked). Same condition,
 * addressed to the user rather than the model.
 */
export function excludedLibraryUserMessage(libraryId: number): string {
    const library = Zotero.Libraries?.get?.(libraryId);
    const name = library ? `"${library.name}"` : 'this library';
    return (
        `The library ${name} is excluded from Beaver, so Beaver cannot modify ` +
        `its items. You can re-enable access by removing it from the excluded ` +
        `libraries list in Beaver Preferences.`
    );
}

