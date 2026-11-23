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
    const groups = new Map<Group, number>();
    for (const [kind, n] of Object.entries(awaiting)) {
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
