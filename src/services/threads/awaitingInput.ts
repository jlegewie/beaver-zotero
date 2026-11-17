/**
 * A thread's `awaiting_input`: the open cards of its parked run, counted by
 * card kind, as the backend reports them on thread rows.
 */

export type AwaitingInput = Readonly<Record<string, number>>;

/**
 * The counts of a wire value that are usable: positive whole numbers. Null
 * when none are, so a malformed value reads as not waiting.
 */
export function parseAwaitingInput(value: unknown): AwaitingInput | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const counts: Record<string, number> = {};
    for (const [kind, count] of Object.entries(value)) {
        if (Number.isInteger(count) && (count as number) > 0) counts[kind] = count as number;
    }
    return Object.keys(counts).length > 0 ? counts : null;
}

type Group = "question" | "approval" | "table";

const GROUP_OF_KIND: Record<string, Group> = {
    ask_user_question: "question",
    agent_action_approval: "approval",
    batch_approval: "approval",
    table_card: "table",
};

/**
 * Job calls still working for the thread: a table fill, PDFs. They draw a
 * spinner, not the dot, and need nothing from the user yet.
 */
const WORKING_JOBS: Record<string, string> = {
    table_fill: "Filling a table",
    pdf_retrieval: "Finding PDFs",
};

/** A job call whose result is stored: the chat can continue with it. */
const JOB_READY = "job_ready";

/**
 * How a thread list marks the thread: `dot` when the user has something to
 * answer or read there, `spinner` when only a job is working for it. The dot
 * wins when both apply; an unknown key counts as needing the user.
 */
export function awaitingIndicator(awaiting: AwaitingInput): "dot" | "spinner" {
    return Object.keys(awaiting).every((kind) => kind in WORKING_JOBS) ? "spinner" : "dot";
}

const NOUNS: Record<Group, [string, string]> = {
    question: ["question", "questions"],
    approval: ["approval", "approvals"],
    table: ["table", "tables"],
};

function count(n: number, group: Group): string {
    const [one, many] = NOUNS[group];
    return `${n} ${n === 1 ? one : many}`;
}

/**
 * What the thread waits on, for the tooltip of its list indicator: "Waiting
 * for your approval", "Waiting for your input: 1 question and 2 approvals".
 * A kind this client does not know leaves only the generic phrase.
 */
export function awaitingInputLabel(awaiting: AwaitingInput): string {
    const kinds = Object.keys(awaiting);
    if (kinds.length && kinds.every((kind) => kind in WORKING_JOBS)) {
        const labels = [...new Set(kinds.map((kind) => WORKING_JOBS[kind]))];
        return labels.join(" · ");
    }
    // Waiting on the user wins over a job still working: only those keys are described.
    const needs = Object.entries(awaiting).filter(([kind]) => !(kind in WORKING_JOBS));
    if (needs.length === 1 && needs[0][0] === JOB_READY) {
        return needs[0][1] === 1 ? "Finished · ready to continue" : `${needs[0][1]} jobs finished · ready to continue`;
    }
    const groups = new Map<Group, number>();
    for (const [kind, n] of needs) {
        const group = GROUP_OF_KIND[kind];
        if (!group) return "Waiting for your input";
        groups.set(group, (groups.get(group) ?? 0) + n);
    }
    if (groups.size === 1) {
        const [[group, n]] = [...groups];
        switch (group) {
            case "question":
                return n === 1 ? "Waiting for your answer to a question" : `Waiting for your answers to ${n} questions`;
            case "approval":
                return n === 1 ? "Waiting for your approval" : `Waiting for ${n} approvals`;
            case "table":
                return n === 1 ? "Waiting for you to confirm a table" : `Waiting for you to confirm ${n} tables`;
        }
    }
    const parts = (["question", "approval", "table"] as const)
        .filter((group) => groups.has(group))
        .map((group) => count(groups.get(group)!, group));
    if (parts.length < 2) return "Waiting for your input";
    return `Waiting for your input: ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
