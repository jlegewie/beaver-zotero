/**
 * Result of a Zotero-side undo that did not throw.
 *
 * `reverted` — the mutation ran, or the applied object is verifiably gone
 * already. The change is off the library and the action may be marked undone.
 * `unverifiable` — the undo could not be confirmed: the target library is not
 * on this device, the reference is too weak to tell a real miss from one caused
 * by a device-local `library_id` (see `isLibraryReferencePortable`), or the
 * record needed to reverse the change is absent. The change may still exist,
 * so the action keeps its result data and a second attempt stays possible.
 *
 * `partial` — the undo did everything it can and knowingly left something
 * behind, because reversing that part is not possible from what was recorded.
 * Unlike `unverifiable` there is nothing a second attempt would add.
 *
 * An undo that demonstrably failed throws instead, so the caller can show what
 * went wrong.
 *
 * What separates the last two values is what the caller is about to do:
 *
 * - A retry's bulk revert (`undoAppliedActionsInReverse`) is about to destroy
 *   the action record, so anything short of `reverted` leaves the action
 *   `applied` and is counted among the changes it puts to the user first.
 * - Every caller that destroys nothing — the card's own Undo button
 *   (`undoClaimedActions`), its `create_item` batch, and the dev undo endpoint
 *   — surfaces `unverifiable` like a thrown failure, so the action goes to
 *   `error` and the card offers Retry, which points back at undo. `partial`
 *   marks the card undone instead, since retrying would only repeat the same
 *   incomplete revert.
 */
export type UndoActionOutcome = 'reverted' | 'unverifiable' | 'partial';

/**
 * What to tell the user when an undo comes back `unverifiable`. Deliberately
 * says nothing about *why*: the library may be missing here, or present but
 * only reachable through an id this device numbers differently, or the record
 * of how to reverse the change may be incomplete — and the reasons are not
 * distinguishable at the point the message is shown.
 */
export const UNVERIFIABLE_UNDO_MESSAGE =
    'Beaver could not confirm this change was undone.';
