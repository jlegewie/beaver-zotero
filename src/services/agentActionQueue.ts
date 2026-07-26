/**
 * Serialization queue for mutating agent actions.
 *
 * Executing two agent actions against the same item concurrently loses one of
 * them: each handler resolves its target from the content it read, then writes
 * the whole item back, so the later save silently overwrites the earlier one.
 * Action handlers deliberately hold no per-item lock; serialization is the
 * caller's responsibility, expressed by the `serialize` flag on the dispatch
 * map entry (see `agentDataDispatch.ts`).
 *
 * The WebSocket transport serializes through a queue owned by `AgentService`,
 * scoped to one connection so a reconnect can abandon work queued for the
 * previous one. The local HTTP transport has no connection to scope to, so it
 * chains here instead: same one-at-a-time guarantee, independent lifetime.
 *
 * Keeping the HTTP surface serialized matters beyond correctness — those
 * endpoints exist to exercise production handlers over a thin wrapper, so they
 * are only a faithful stand-in for the WebSocket path if they share its
 * concurrency behavior.
 */

let queue: Promise<unknown> = Promise.resolve();

/**
 * Run `task` after every previously enqueued task has settled, and resolve
 * with its result.
 *
 * A rejected task does not break the chain: the queue continues with the next
 * task, while the rejection still propagates to this call's caller.
 */
export function enqueueMutatingAction<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    // Swallow rejections on the chain itself so one failed action cannot
    // reject every action queued behind it.
    queue = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}
