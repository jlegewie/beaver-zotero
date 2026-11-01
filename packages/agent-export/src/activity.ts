/**
 * Tool-call labels as exports show them. A label reads "Action: what it acted
 * on" (`Extracting: core findings (1 result)`); writers set the action apart
 * so a run of calls can be scanned by what was done.
 */

/** Longest prefix read as the action; a longer one is part of a sentence. */
const MAX_ACTION_LENGTH = 40;

/** The label's action (with its colon) and the rest; a label with no action is all detail. */
export function activityLabelParts(label: string): { action: string; detail: string } {
    const index = label.indexOf(': ');
    if (index > 0 && index <= MAX_ACTION_LENGTH) {
        return { action: label.slice(0, index + 1), detail: label.slice(index + 2) };
    }
    return { action: '', detail: label };
}
