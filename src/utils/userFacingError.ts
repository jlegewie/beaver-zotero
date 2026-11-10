/**
 * An error whose `message` is model-facing but which also carries wording fit
 * for the UI. Code that renders a failure to the user prefers `userMessage`;
 * code that hands the failure back to the model keeps using `message`.
 */
export interface UserFacingError extends Error {
    userMessage?: string;
}

/**
 * The message to show a user for a thrown error: the thrower's user-facing
 * wording when it supplied one, otherwise the raw message.
 */
export function getUserFacingErrorMessage(error: unknown, fallback: string): string {
    const err = error as UserFacingError | null | undefined;
    return err?.userMessage || err?.message || fallback;
}
