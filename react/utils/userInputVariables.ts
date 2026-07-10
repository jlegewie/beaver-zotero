/**
 * User-Input Variables
 *
 * Action prompts can contain `[[name]]` placeholders. They are intentionally
 * distinct from `{{name}}` auto-resolved variables (see promptVariables.ts) —
 * the brackets advertise "fill me in" rather than "I will be replaced for you".
 *
 * Placeholders are currently sent to the assistant as written; the Actions
 * preferences surface a notice on prompts that still contain them. A dedicated
 * fill-in mechanism will replace this in a future update.
 */

/** Matches `[[name]]` where name is one or more word/space/hyphen characters. */
export const USER_INPUT_VARIABLE_PATTERN = /\[\[([\w\s-]+?)\]\]/g;

/** Returns true if `text` contains at least one `[[name]]` placeholder. */
export function hasUserInputVariables(text: string): boolean {
    USER_INPUT_VARIABLE_PATTERN.lastIndex = 0;
    return USER_INPUT_VARIABLE_PATTERN.test(text);
}
