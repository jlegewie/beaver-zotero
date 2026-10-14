/**
 * File-system failures, by what the platform error names, as sentences a user
 * can act on. Anything else keeps its own message unless it is a raw
 * platform code.
 */
const FILE_ERROR_MESSAGES: Array<[RegExp, string]> = [
    [/ACCESS_DENIED|READ_ONLY|NotAllowedError|permission denied/i, 'Beaver cannot save to that location. Choose a folder you can write to and try again.'],
    [/IS_LOCKED|NoModificationAllowedError|in use/i, 'The file is open in another application. Close it there and try again.'],
    [/NO_DEVICE_SPACE|disk full|QuotaExceededError/i, 'There is not enough disk space to save the file.'],
    [/FILE_NOT_FOUND|TARGET_DOES_NOT_EXIST|NotFoundError|UNRECOGNIZED_PATH/i, 'That folder no longer exists. Choose another location and try again.'],
    [/NAME_TOO_LONG/i, 'The file name is too long. Choose a shorter name and try again.'],
];

/** A user-facing sentence for an export failure. */
export function exportErrorMessage(error: unknown): string {
    const raw = `${(error as any)?.name ?? ''} ${(error as any)?.message ?? error ?? ''}`;
    for (const [pattern, message] of FILE_ERROR_MESSAGES) {
        if (pattern.test(raw)) return message;
    }
    const message = (error as any)?.message;
    if (typeof message === 'string' && message.trim() && !/NS_ERROR_/.test(message)) return message;
    return 'The file could not be saved.';
}
