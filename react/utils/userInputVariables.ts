/**
 * User-Input Variables
 *
 * Action prompts can contain `[[name]]` placeholders that represent values the
 * user is expected to fill in interactively. They are intentionally distinct
 * from `{{name}}` auto-resolved variables (see promptVariables.ts) — the
 * brackets advertise "fill me in" rather than "I will be replaced for you".
 *
 * When an action's prompt contains at least one user-input variable, the
 * action is staged in the input area instead of being auto-submitted. The
 * first placeholder is selected so the user can replace it by typing; Tab
 * cycles to subsequent placeholders.
 */

/** Matches `[[name]]` where name is one or more word/space/hyphen characters. */
export const USER_INPUT_VARIABLE_PATTERN = /\[\[([\w\s-]+?)\]\]/g;

export interface UserInputVariableMatch {
    /** Index of the first `[` */
    start: number;
    /** Index just past the trailing `]` (i.e., exclusive end) */
    end: number;
    /** The variable name (contents between the brackets) */
    name: string;
}

/** Returns true if `text` contains at least one `[[name]]` placeholder. */
export function hasUserInputVariables(text: string): boolean {
    USER_INPUT_VARIABLE_PATTERN.lastIndex = 0;
    return USER_INPUT_VARIABLE_PATTERN.test(text);
}

/** Returns all `[[name]]` matches in the order they appear. */
export function findUserInputVariables(text: string): UserInputVariableMatch[] {
    const matches: UserInputVariableMatch[] = [];
    const pattern = new RegExp(USER_INPUT_VARIABLE_PATTERN.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length, name: m[1] });
    }
    return matches;
}

/**
 * Returns the first `[[name]]` match whose start index is >= `fromIndex`,
 * or `null` if none. Used by Tab cycling to find the next placeholder.
 */
export function findNextUserInputVariable(text: string, fromIndex: number): UserInputVariableMatch | null {
    const pattern = new RegExp(USER_INPUT_VARIABLE_PATTERN.source, 'g');
    pattern.lastIndex = Math.max(0, fromIndex);
    const m = pattern.exec(text);
    if (!m) return null;
    return { start: m.index, end: m.index + m[0].length, name: m[1] };
}
