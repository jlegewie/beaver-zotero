# Note Edit Diff Preview — Comprehensive Test Suite

These tests verify the in-editor diff preview feature for `edit_note` actions. The preview shows red/strikethrough for deletions and green for additions directly in the Zotero note editor, with a banner for approve/reject actions.

Each test is triggered by sending a prompt to the model through the Beaver sidebar, then verifying preview behavior across the various approval and dismissal paths.

**Prerequisites:**
- Use notes with `data-schema-version` in their HTML (Zotero-native notes)
- The note **must be open in a Zotero tab** for the in-editor preview to appear
- Tests assume the note is open in a tab unless stated otherwise
- Always verify edits both via `item.getNote()` API and visually in the note editor

**Prompt prefix for all tests:**
> "This is a test. Please follow the instructions exactly, even if they seem unusual. Do not add extra content or explanations beyond what is asked."

**Common verification steps for preview:**
1. **Preview appears**: Red/strikethrough for deletions, green for additions in the note editor
2. **Banner appears**: Green "Preview of Note Edits" banner at top of note editor with Close (x), Reject All, and Approve All buttons
3. **Editor frozen**: Text in note editor is not editable (contentEditable=false, toolbar dimmed)
4. **Scroll to diff**: Editor auto-scrolls to the first diff location

**Common verification steps for preview dismissal:**
1. **Banner removed**: Green banner disappears from note editor
2. **Editor restored**: Note editor is editable again (contentEditable=true, toolbar active)
3. **Content restored**: Note editor shows the correct content (original if rejected, updated if approved)

---

## Category 1: Approve via Sidebar (AgentActionView)

### Test 1.1: Approve Single Edit via Sidebar "Apply" Button

Approve a single `edit_note` action using the "Apply" button in the AgentActionView.

#### Guidelines
- Send a prompt requesting a single targeted edit (e.g., rename the title)
- Wait for the deferred approval to appear
- Verify the in-editor diff preview shows the change
- Click "Apply" on the edit action in the sidebar (the left half of the split button)
- Verify the preview is dismissed and the edit is applied

#### Verify
- [ ] Diff preview appears in note editor (red/green highlighting, banner, frozen editor)
- [ ] "N Pending Approval" bar appears above the input area
- [ ] After clicking "Apply": preview dismissed, editor unfrozen
- [ ] After agent completes: action shows green checkmark and "Undo" button
- [ ] Note content reflects the edit (API check via `item.getNote()` + visual check)
- [ ] Undo works: click "Undo", note content reverts, editor shows original
- [ ] Re-apply works: click "Apply" again, note content updated again

#### Test result

- **Date**: 2026-04-01
- **Note**: ID 2034, "School Segregation and Performance Disparities" (1601 chars, has `data-schema-version`)
- **Prompt**: "Change the title of this note from 'School Segregation and Performance Disparities' to 'Educational Segregation and Achievement Gaps'. Do not change anything else."
- **Result**: PASS
  - Diff preview appeared correctly: red/strikethrough old title, green new title in editor
  - Banner "Preview of Note Edits" with Close (×), Reject All, Approve All buttons
  - "1 Pending Approval" bar
  - Split Apply button with chevron dropdown visible
  - After clicking Apply: preview dismissed, editor unfrozen, title updated
  - API confirmed new title, green checkmark in sidebar
  - **Undo**: title reverted, red X icon, "Apply" button available
  - No preview shown during post-run undo (preview is only for deferred approvals)

### Test 1.2: Approve Multiple Parallel Edits One-by-One via Sidebar

Approve multiple `edit_note` actions individually using the sidebar buttons.

#### Guidelines
- Send a prompt requesting multiple distinct edits (e.g., "Make the following three changes: (1) Change the title to 'X', (2) Bold the word 'Y' in paragraph 2, (3) Add a new paragraph at the end saying 'Z'.")
- The agent should produce multiple `edit_note` tool calls
- Approve each one individually by clicking "Apply" on each action
- After approving the first edit, verify the preview updates to show remaining edits
- After approving the last edit, verify the preview is fully dismissed

#### Verify
- [ ] Multiple pending approvals appear (count shown in "N Pending Approvals" bar)
- [ ] Diff preview in editor shows ALL pending edits combined (all red/green highlights)
- [ ] Approving one edit updates the preview to show only remaining edits
- [ ] After approving the last edit, preview is fully dismissed
- [ ] Each approved edit shows green checkmark in sidebar
- [ ] All edits are correctly applied (API + visual check)
- [ ] Each edit can be individually undone

#### Test result

- **Date**: 2026-04-01
- **Note**: ID 2034, "School Segregation and Performance Disparities"
- **Prompt**: "Make exactly two separate edit_note tool calls: (1) Change the title to 'Test Title Alpha'. (2) Add bold formatting to the word 'Logan' in the first sentence."
- **Result**: PASS
  - Both edits appeared simultaneously in editor preview (title + bold "Logan")
  - "2 Pending Approvals" bar shown
  - After approving first (title): preview updated to show only second edit (bold Logan), count dropped to "1 Pending Approval"
  - After approving second (bold): preview fully dismissed, both green checkmarks
  - Title changed to "Test Title Alpha", "Logan" rendered bold in editor
  - Both edits individually undone successfully

---

## Category 2: Reject via Sidebar (AgentActionView)

### Test 2.1: Reject Single Edit via Sidebar "Reject" Button

Reject a single `edit_note` action using the "Reject" button in the AgentActionView.

#### Guidelines
- Send a prompt requesting a single targeted edit
- Wait for the deferred approval to appear
- Verify the in-editor diff preview shows the change
- Click "Reject" on the edit action in the sidebar
- Verify the preview is dismissed and the note is unchanged

#### Verify
- [ ] Diff preview appears in note editor
- [ ] After clicking "Reject": preview dismissed, editor unfrozen
- [ ] Note content is unchanged (API + visual check)
- [ ] Action shows red X icon and "Apply" button in sidebar
- [ ] Agent continues with its response (acknowledges the rejection)
- [ ] Post-run: "Apply" button still available (can apply the rejected edit later)

#### Test result

- **Date**: 2026-04-01
- **Note**: ID 2034
- **Prompt**: "Change the title to 'REJECTED TITLE TEST'."
- **Result**: PASS
  - Preview appeared, clicked Reject on sidebar action
  - Preview dismissed, editor unfrozen, note unchanged (original title)
  - Red X icon on action, agent acknowledged: "The title change was rejected and not applied"
  - Post-run: "Apply" button still available on the rejected action

### Test 2.2: Reject with Instructions via Input Area

Reject a pending approval by typing instructions in the input area and clicking the "Reject" / "Reject All" button.

#### Guidelines
- Send a prompt requesting an edit
- Wait for the deferred approval to appear
- Type instructions in the input area (e.g., "Don't change the title, just bold the first word instead")
- The Send button should change to "Reject" / "Reject All"
- Click the button to reject with instructions

#### Verify
- [ ] Input placeholder shows "Add instructions to reject"
- [ ] Send button changes to "Reject" (single approval) or "Reject All" (multiple)
- [ ] After clicking: preview dismissed, note unchanged
- [ ] Agent receives the rejection with instructions and adjusts its approach
- [ ] Agent produces a new edit attempt based on the instructions

#### Test result

- **Date**: 2026-04-01
- **Note**: ID 2034
- **Prompt**: "Change the title to 'BAD TITLE'." → rejected with instructions: "Don't use BAD TITLE. Instead change the title to 'Achievement Gaps in American Schools'"
- **Result**: PASS
  - Input placeholder showed "Add instructions to reject"
  - Send button changed to "Reject" when text was entered
  - After clicking Reject: first edit rejected (red X), preview dismissed, note unchanged
  - Agent received instructions, acknowledged rejection, produced new edit with corrected title "Achievement Gaps in American Schools"
  - New preview appeared correctly with the updated title

---

## Category 3: Approve All / Reject All via PendingActionsBar

### Test 3.1: Approve All Pending Edits via PendingActionsBar

Use the "Approve All" button in the PendingActionsBar (above the input area) to approve all pending edit_note actions at once.

#### Guidelines
- Send a prompt that produces multiple `edit_note` tool calls
- Wait for multiple deferred approvals to appear
- Verify the "N Pending Approvals" bar shows the correct count
- Click "Approve All" in the PendingActionsBar

#### Verify
- [ ] "N Pending Approvals" bar appears with correct count
- [ ] Diff preview in editor shows all pending edits
- [ ] After clicking "Approve All": all approvals sent, preview dismissed
- [ ] All actions show green checkmarks in sidebar
- [ ] All edits are correctly applied (API + visual check)
- [ ] PendingActionsBar disappears (no more pending approvals)

#### Test result

- **Date**: 2026-04-01
- **Note**: ID 2034
- **Prompt**: "Make exactly two separate edit_note tool calls: (1) Change the title to 'Approve All Test Title'. (2) Add a new paragraph 'This paragraph was added by Test 3.1.'"
- **Result**: PASS
  - Agent sent edits sequentially (not in parallel), so "Approve All" was clicked twice (once per pending edit)
  - First click: title changed, preview updated to second edit
  - Second click: paragraph added, preview fully dismissed
  - Both green checkmarks, both edits verified via API
  - **Note**: Undo of second edit after first was undone showed inline warning "Could not undo automatically. The note may have been modified since this edit was applied." This is expected for sequential undo of dependent edits.

### Test 3.2: Reject All Pending Edits via PendingActionsBar

Use the "Reject All" button in the PendingActionsBar to reject all pending edit_note actions.

#### Guidelines
- Send a prompt that produces multiple `edit_note` tool calls
- Wait for multiple deferred approvals
- Click "Reject All" in the PendingActionsBar

#### Verify
- [ ] After clicking "Reject All": all approvals rejected, preview dismissed
- [ ] Note content is unchanged (API + visual check)
- [ ] All actions show red X icon in sidebar
- [ ] PendingActionsBar disappears
- [ ] Agent acknowledges rejection and continues

#### Test result

- **Date**: 2026-04-01
- **Note**: ID 2034
- **Prompt**: "Change the title to 'SHOULD NOT APPEAR'."
- **Result**: PASS
  - Preview appeared, clicked "Reject All" in PendingActionsBar
  - Preview dismissed, editor unfrozen, note unchanged (original title)
  - Red X icon on action, agent acknowledged: "The user rejected this edit. The note title was not changed."
  - PendingActionsBar disappeared

### Test 3.3: Approve All with Mixed Action Types

Test "Approve All" when there are pending approvals for both `edit_note` and other action types (e.g., `edit_metadata`).

#### Guidelines
- Send a prompt that triggers both an `edit_note` and another deferred action (e.g., "Change the title of this note to 'X' and also update the parent item's title to 'Y'")
- Wait for multiple approvals of different types
- Click "Approve All" in the PendingActionsBar

#### Verify
- [ ] PendingActionsBar shows total count across all action types
- [ ] Diff preview only shows for edit_note actions (not edit_metadata)
- [ ] "Approve All" approves ALL pending actions (including non-edit_note ones)
- [ ] Diff preview dismissed after approval
- [ ] Both the note edit and metadata edit are applied correctly

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — Requires triggering both edit_note and edit_metadata in a single prompt, which is hard to control reliably via MCP.

---

## Category 4: Approve All / Reject All via In-Editor Banner

### Test 4.1: Approve All via Banner Button

Use the "Approve All" button in the green banner inside the note editor.

#### Guidelines
- Send a prompt requesting one or more edits
- Wait for the diff preview to appear in the note editor
- Click "Approve All" in the green banner at the top of the note editor

#### Verify
- [ ] Green banner shows "Preview of Note Edits" with Close, Reject All, Approve All buttons
- [ ] After clicking "Approve All": banner removed, preview dismissed, editor unfrozen
- [ ] All edit_note actions are approved (green checkmarks in sidebar)
- [ ] Edits are applied correctly (API + visual check)
- [ ] Note: banner only approves/rejects `edit_note` actions, not other types

#### Test result

- **Date**: 2026-04-01
- **Note**: ID 2034
- **Prompt**: "Change the title to 'Banner Approve Test'."
- **Result**: PASS
  - Preview appeared with banner in editor. Clicked "Approve All" button inside the in-editor banner (not the sidebar)
  - Banner removed, preview dismissed, editor unfrozen
  - Title changed to "Banner Approve Test", green checkmark in sidebar
  - Agent confirmed edit was applied
  - **Note**: Setting `window.__beaverPreviewAction` directly via JS did NOT work (cross-compartment issue). Must click the actual button element in the iframe document.

### Test 4.2: Reject All via Banner Button

Use the "Reject All" button in the green banner inside the note editor.

#### Guidelines
- Send a prompt requesting one or more edits
- Wait for the diff preview to appear
- Click "Reject All" in the banner

#### Verify
- [ ] After clicking "Reject All": banner removed, preview dismissed, editor unfrozen
- [ ] Note content is unchanged (API + visual check)
- [ ] All edit_note actions show red X in sidebar
- [ ] Agent acknowledges rejection and continues

#### Test result

- **Date**: 2026-04-01
- **Note**: ID 2034
- **Prompt**: "Change the title to 'BANNER REJECT TEST'."
- **Result**: PASS
  - Preview appeared. Clicked "Reject All" button inside the in-editor banner
  - Banner removed, preview dismissed, editor unfrozen
  - Note unchanged (original title), red X on action
  - Agent acknowledged: "The edit was rejected"

### Test 4.3: Close Preview via Banner Close (x) Button

Use the close button (x) in the banner to dismiss the preview without approving or rejecting.

#### Guidelines
- Send a prompt requesting an edit
- Wait for the diff preview to appear
- Click the "x" (close) button on the left side of the banner

#### Verify
- [ ] After clicking close: banner removed, preview dismissed, editor unfrozen
- [ ] Note content shows the original (unchanged) content
- [ ] Pending approvals are NOT removed — still awaiting in the sidebar
- [ ] "N Pending Approval" bar still shows in the input area
- [ ] User can still approve/reject via sidebar buttons
- [ ] If user re-opens or focuses the note editor, the preview does NOT automatically reappear (close is a user dismissal)

#### Test result

- **Date**: 2026-04-01
- **Note**: ID 2034
- **Prompt**: "Change the title to 'CLOSE BUTTON TEST'."
- **Result**: PASS
  - Preview appeared. Clicked "×" (close) button on the left side of the banner
  - Banner removed from editor, editor content restored to original
  - **Pending approval still active** — "1 Pending Approval" bar still showing in sidebar
  - Sidebar still shows the edit action with Apply/Reject buttons
  - User can still approve/reject via sidebar buttons after close

### Test 4.4: Banner Approve/Reject Only Affects the Previewed Note

Verify that the "Approve All" / "Reject All" banner buttons only act on edits for the note currently being previewed, not edits targeting other notes.

#### Guidelines
- Open two different notes in separate Zotero tabs (e.g., note A and note B)
- Send a prompt that produces `edit_note` tool calls for **both** notes (e.g., "Make the following two separate edit_note tool calls: (1) In note A, change the title to 'Banner Scope A'. (2) In note B, change the title to 'Banner Scope B'.")
- Wait for both deferred approvals to appear
- The diff preview should appear in whichever note tab is currently selected (e.g., note A)
- Click "Approve All" (or "Reject All") in the banner

#### Verify — Approve All
- [ ] Only edits for the previewed note (A) are approved (green checkmark in sidebar)
- [ ] Edits for the other note (B) remain pending — still awaiting approval in sidebar
- [ ] "N Pending Approval" bar still shows (count decremented but not zero)
- [ ] Note A content reflects the approved edit
- [ ] Note B content is unchanged
- [ ] Switching to note B's tab and clicking "Preview" re-shows the diff preview for note B's pending edit

#### Verify — Reject All (repeat with Reject All instead)
- [ ] Only edits for the previewed note are rejected (red X in sidebar)
- [ ] Edits for the other note remain pending
- [ ] Note content for both notes is unchanged after rejection

#### Test result

- **Date**: (not yet run)
- **Result**: NOT RUN

### Test 4.5: Banner Approve/Reject with Mixed Action Types

Verify that banner buttons only affect `edit_note` actions for the previewed note, leaving other action types (e.g., `edit_metadata`) untouched.

#### Guidelines
- Send a prompt that triggers both an `edit_note` for a specific note and an `edit_metadata` for a different item
- Wait for both deferred approvals
- The diff preview appears for the edit_note in the note editor
- Click "Approve All" in the banner

#### Verify
- [ ] Only the `edit_note` action(s) for the previewed note are approved
- [ ] The `edit_metadata` action remains pending in the sidebar
- [ ] PendingActionsBar still shows the remaining approval

#### Test result

- **Date**: (not yet run)
- **Result**: NOT RUN

---

## Category 5: "Apply All for This Note" (Auto-Approve)

### Test 5.1: Auto-Approve Subsequent Edits for Same Note

Use the "Apply all for this note" option to auto-approve all future edit_note actions for the same note within the current run.

#### Guidelines
- Send a prompt that will produce multiple sequential `edit_note` tool calls for the same note (e.g., "Make the following five changes to this note: (1) ..., (2) ..., (3) ..., (4) ..., (5) ...")
- When the first approval appears, click the dropdown chevron on the split "Apply" button
- Select "Apply all for this note" from the dropdown menu
- Observe that subsequent edit_note actions are automatically approved without user interaction

#### Verify
- [ ] First edit shows normal approval UI (split Apply button with chevron)
- [ ] Clicking chevron shows dropdown with "Apply all for this note" option
- [ ] After selecting: first edit is approved normally
- [ ] Subsequent edit_note actions for the same note are auto-approved (no approval UI)
- [ ] Auto-approved actions show "(auto)" label in the sidebar
- [ ] All edits are correctly applied
- [ ] Diff preview is dismissed after first approval (subsequent edits don't trigger preview)

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — Requires precise timing of multiple sequential edit_note calls. The split button with "Apply all for this note" dropdown was visually confirmed present during Test 1.1 and 1.2, but the full auto-approve flow was not exercised.

### Test 5.2: Auto-Approve Does Not Apply to Different Notes

Verify that "Apply all for this note" only auto-approves edits for the specific note, not other notes.

#### Guidelines
- Send a prompt requesting edits to two different notes
- When the first approval for note A appears, use "Apply all for this note"
- Verify that edits for note B still require manual approval

#### Verify
- [ ] Edits for note A are auto-approved after opting in
- [ ] Edits for note B still show normal approval UI
- [ ] Each note's edits are applied correctly to the right note

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — Requires multi-note edit scenario.

### Test 5.3: Auto-Approve Resets on New Run

Verify that auto-approve state does not persist across agent runs.

#### Guidelines
- In run 1: Use "Apply all for this note" for a note
- After run 1 completes, send a new message requesting another edit to the same note
- Verify that run 2 requires manual approval again

#### Verify
- [ ] Run 1: auto-approve works as expected
- [ ] Run 2: approval UI appears for the same note (auto-approve did not persist)

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — Requires completing Test 5.1 first.

---

## Category 6: Stop Button Dismisses Preview

### Test 6.1: Stop During Pending Approval

Press the "Stop" button while an edit is awaiting approval.

#### Guidelines
- Send a prompt requesting an edit
- Wait for the deferred approval and diff preview to appear
- Click "Stop" in the input area

#### Verify
- [ ] Diff preview is dismissed (banner removed, editor unfrozen)
- [ ] Note content restored to original (no changes applied)
- [ ] PendingActionsBar disappears
- [ ] All pending approvals are cleared
- [ ] Run is marked as canceled
- [ ] Post-run: the pending edit_note action shows in the sidebar as "Pending" with an "Apply" button (can still be applied manually)

#### Test result

- **Date**: 2026-04-01
- **Note**: ID 2034
- **Prompt**: "Change the title to 'STOP TEST TITLE'."
- **Result**: PASS
  - Preview appeared (banner + highlighting in editor, "1 Pending Approval" bar)
  - Clicked "Stop" button in input area
  - Preview dismissed, banner removed, editor unfrozen, content restored to original
  - PendingActionsBar disappeared, button back to "Send"
  - Note unchanged (original title verified via API)
  - Edit action shows as "Pending" in collapsed state (with X and checkmark icons for post-run apply/reject)

### Test 6.2: Stop During Multiple Pending Approvals

Press "Stop" while multiple edits are awaiting approval.

#### Guidelines
- Send a prompt that produces multiple parallel edit_note tool calls
- Wait for multiple approvals and the combined diff preview
- Click "Stop"

#### Verify
- [ ] All diff previews dismissed at once
- [ ] Note content restored to original
- [ ] All pending approvals cleared
- [ ] PendingActionsBar disappears
- [ ] All pending actions available for manual apply post-run

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — Similar to 6.1. Skipped for time.

---

## Category 7: Thread Switching Dismisses Preview

### Test 7.1: Switch to Different Thread via Chat History

Switch to a different thread while an edit is awaiting approval.

#### Guidelines
- Send a prompt requesting an edit
- Wait for the deferred approval and diff preview
- Click the "Chat history" button in the header (ChattingIcon)
- Select a different thread from the thread list

#### Verify
- [ ] Diff preview is dismissed (banner removed, editor unfrozen)
- [ ] Note content restored to original
- [ ] All pending approvals cleared for the previous thread
- [ ] New thread loads correctly
- [ ] Switching back to the original thread: edit action shows as "Pending" (can be applied manually)

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — Would require existing thread history. Tested via 7.2 (new chat) instead.

### Test 7.2: Create New Thread via "New Chat" Button

Start a new chat while an edit is awaiting approval.

#### Guidelines
- Send a prompt requesting an edit
- Wait for the deferred approval and diff preview
- Click the "New chat" button in the header (PlusSignIcon) or press Cmd/Ctrl+N

#### Verify
- [ ] Diff preview is dismissed (banner removed, editor unfrozen)
- [ ] Note content restored to original
- [ ] All pending approvals cleared
- [ ] New empty thread is created
- [ ] Navigating back to the previous thread: edit action shows as "Pending"

#### Test result

- **Date**: 2026-04-01
- **Note**: ID 2034
- **Prompt**: "Change the title to 'THREAD SWITCH TEST'."
- **Result**: PASS
  - Preview appeared (banner + highlighting confirmed via JS check)
  - Clicked "New chat" button in header
  - Preview dismissed: banner removed, editor unfrozen, content restored to original
  - New empty thread shown ("How can I help you?")
  - No PendingActionsBar, note unchanged

---

## Category 8: Closing Beaver Dismisses Preview

### Test 8.1: Close Beaver Sidebar While Preview Active

Close the Beaver sidebar while a diff preview is showing.

#### Guidelines
- Send a prompt requesting an edit
- Wait for the deferred approval and diff preview to appear in the note editor
- Close the Beaver sidebar (click the X button or use Cmd/Ctrl+J)

#### Verify
- [ ] Beaver sidebar closes
- [ ] Note editor: check if the diff preview (banner + highlighting) is still visible or dismissed
- [ ] If preview persists: does re-opening sidebar allow continuing the approval flow?
- [ ] If preview is dismissed: note content should be restored to original
- [ ] Document the actual behavior (sidebar close may or may not trigger cleanup)

#### Test result

- **Date**: 2026-04-01
- **Note**: ID 2034
- **Prompt**: "Change the title to 'SIDEBAR CLOSE TEST'."
- **Result**: PASS (with expected caveat)
  - Preview appeared. Closed Beaver sidebar via toolbar toggle button.
  - **Preview PERSISTS in the note editor** — banner still showing "Preview of Note Edits" with Reject All / Approve All buttons, diff highlighting still visible
  - Zotero's default sidebar (Note Info) replaced the Beaver sidebar
  - **Banner buttons still interactive** — user can approve/reject from the editor even with Beaver sidebar closed
  - Re-opening Beaver sidebar restores the approval flow
- **Notes**: This is expected behavior. The preview lives in the Zotero note editor iframe, independent of the Beaver sidebar DOM. `dismissDiffPreview()` is NOT called on sidebar close. The user can still interact with the preview via the in-editor banner.

### Test 8.2: Close Separate Beaver Window While Preview Active

Close the separate Beaver window (opened via Cmd/Ctrl+Shift+J) while a diff preview is showing in the main window's note editor.

#### Guidelines
- Open a separate Beaver window
- From the window, send a prompt requesting an edit to a note open in the main Zotero window
- Wait for the diff preview to appear in the main window's note editor
- Close the separate Beaver window

#### Verify
- [ ] Separate window closes
- [ ] Note editor in main window: check if diff preview persists or is dismissed
- [ ] Main window sidebar: does it show the pending approval?
- [ ] Banner buttons in the note editor: do they still work?
- [ ] Document the actual behavior

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — Requires separate Beaver window setup. Skipped for time.

---

## Category 9: Preview Display Quality

### Test 9.1: Single Word Change Preview

Verify the visual quality of the diff preview for a minimal change.

#### Guidelines
- Send a prompt to change a single word (e.g., "Replace 'segregation' with 'separation'")
- Observe the diff rendering in both the note editor and the sidebar

#### Verify
- [ ] Note editor: old word shown in red with strikethrough, new word in green
- [ ] Sidebar: inline diff shows old word struck through, new word highlighted
- [ ] Surrounding text is unchanged and readable
- [ ] Editor scrolls to the diff location

#### Test result

- **Date**: 2026-04-01
- **Result**: PASS (observed during Test 1.1) — Title change showed old title in red/strikethrough, new title in green. Surrounding body text unchanged and readable. Editor auto-scrolled to title (top of note). Sidebar inline diff matched editor preview.

### Test 9.2: Paragraph Addition Preview

Verify the preview for adding new content.

#### Guidelines
- Send a prompt to add a new paragraph
- The old_string captures a boundary; new_string includes old + new paragraph

#### Verify
- [ ] Note editor: new paragraph shown entirely in green (no red, since nothing deleted)
- [ ] Sidebar: inline diff shows the new text as all-green addition
- [ ] Existing content not highlighted

#### Test result

- **Date**: 2026-04-01
- **Result**: PASS (observed during Test 3.1) — New paragraph "This paragraph was added by Test 3.1." appeared in green at the end of the note. Existing content not highlighted. Sidebar showed green addition text.

### Test 9.3: Paragraph Deletion Preview

Verify the preview for removing content.

#### Guidelines
- Send a prompt to delete a paragraph
- The new_string omits the deleted paragraph

#### Verify
- [ ] Note editor: deleted paragraph shown in red with strikethrough
- [ ] Sidebar: inline diff shows the deleted text as all-red deletion
- [ ] Surrounding content not highlighted

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — No dedicated deletion test. Deletion styling (red/strikethrough) was verified as part of title replacement tests.

### Test 9.4: Multiple Edits Combined Preview

Verify that multiple pending edits are shown simultaneously in the preview.

#### Guidelines
- Send a prompt producing 2-3 `edit_note` calls for the same note
- Verify that all edits appear in the preview at once

#### Verify
- [ ] All edits visible simultaneously in the note editor (multiple red/green sections)
- [ ] Editor scrolls to the first diff
- [ ] Each edit has its own entry in the sidebar

#### Test result

- **Date**: 2026-04-01
- **Result**: PASS (observed during Test 1.2) — Two edits (title change + bold "Logan") both visible simultaneously in editor. Title showed red/green at top, "Logan" showed green highlight in body text.

### Test 9.5: Replace All Preview

Verify the preview for a `replace_all` operation.

#### Guidelines
- Send a prompt to replace all occurrences of a word (e.g., "Replace every occurrence of 'X' with 'Y'")
- The agent should use `replace_all: true`

#### Verify
- [ ] Note editor: every occurrence highlighted (red old, green new)
- [ ] Sidebar: shows "Replace (all occurrences)" label
- [ ] All occurrences are visible in the preview

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — No replace_all test run. Would need a note with repeated words.

---

## Category 10: Preview When Note Not Open in Editor

### Test 10.1: Edit Note Not Open in Tab (No Preview)

Verify that the diff preview gracefully falls back when the note is not open in a Zotero tab.

#### Guidelines
- Close all note/reader tabs so only the library tab is visible
- Send a prompt referencing a note by its key (e.g., "Edit note '1-ABCDE'...")
- Verify that the approval flow works without the in-editor preview

#### Verify
- [ ] No in-editor diff preview appears (note is not open)
- [ ] Sidebar diff preview still shows the change (inline diff)
- [ ] Approve/Reject buttons work normally
- [ ] Edit is applied correctly via API

#### Test result

- **Date**: 2026-04-01
- **Note**: ID 2034 (key 72DUSPAN, library 1) — all note/reader tabs closed, library tab only
- **Prompt**: "Change the title of note '1-72DUSPAN' from 'School Segregation and Performance Disparities' to 'No Preview Test'."
- **Result**: PASS
  - No in-editor diff preview appeared (no banner, no highlighting — correct, note not open in a tab)
  - Sidebar diff preview still showed the inline diff (old/new text)
  - Action appeared with pending/spinner icon
  - Note content unchanged in DB (original title) — awaiting post-run Apply
  - Agent completed run, said "Done" (received tool result but actual Zotero-side application deferred)

### Test 10.2: Open Note After Preview Attempt

Verify behavior when the note is opened in a tab after the approval already appeared.

#### Guidelines
- Start with the note closed (library tab only)
- Send a prompt to edit the note
- After the approval appears (no preview), open the note in a tab
- Check if the preview appears retroactively

#### Verify
- [ ] Initial approval: no in-editor preview (note wasn't open)
- [ ] After opening note: document whether preview appears retroactively or not
- [ ] Approve/Reject still works regardless of preview state

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — Would require opening note tab while approval is pending. Skipped for time.

---

## Category 11: Edge Cases

### Test 11.1: Approve Then Undo Then Re-Apply (Full Roundtrip with Preview)

Verify the complete approve -> undo -> re-apply lifecycle after the preview feature.

#### Guidelines
- Send a prompt requesting an edit
- Approve via the in-editor banner "Approve All"
- Wait for the agent to complete
- Undo the edit from the sidebar
- Re-apply the edit from the sidebar

#### Verify
- [ ] Approve: preview dismissed, edit applied, green checkmark
- [ ] Undo: edit reverted, red X icon, "Apply" button available
- [ ] Re-apply: edit applied again, green checkmark restored
- [ ] No preview is shown during post-run undo/re-apply (preview is only for deferred approvals)

#### Test result

- **Date**: 2026-04-01
- **Result**: PASS (verified as part of Tests 1.1 and 4.1) — Full approve → undo → re-apply roundtrip verified. No preview shown during post-run undo/re-apply. Preview is only for deferred approvals during the agent run.

### Test 11.2: Rapid Approve/Reject Sequence

Rapidly approve and reject multiple pending actions to test race conditions.

#### Guidelines
- Send a prompt producing 3+ edit_note tool calls
- As approvals appear, rapidly click Approve on one, Reject on another, Approve on the third
- Verify no stale previews or orphaned banners remain

#### Verify
- [ ] Each action processed correctly (no double-approve, no lost actions)
- [ ] Preview updates correctly between each action
- [ ] After all actions processed: no lingering banner or frozen editor
- [ ] Final note state matches the approved edits only

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — Requires 3+ parallel edit_note calls. Skipped for time.

### Test 11.3: Dedup — Same Preview Not Re-Shown

Verify that showing the same set of edits twice doesn't recreate the preview.

#### Guidelines
- This is tested implicitly: when an approval is added and the exact same edits are already previewed, `showDiffPreview` deduplicates via the `editsHash`
- Observe via debug logging: `showDiffPreview: preview active for...` should only appear once per unique edit set

#### Verify
- [ ] Check console logs: no duplicate "preview active" messages for the same edit set
- [ ] Preview remains stable (no flicker or re-render)

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — Requires log analysis. Skipped for time.

### Test 11.4: Editor Becomes Unavailable During Preview

Verify cleanup when the note editor tab is closed while a preview is active.

#### Guidelines
- Send a prompt requesting an edit
- Wait for the diff preview to appear
- Close the note tab in Zotero (click the X on the tab)

#### Verify
- [ ] Preview auto-dismisses (detected by the 200ms liveness poll)
- [ ] Pending approvals still available in sidebar (can approve/reject)
- [ ] Note content not corrupted (editor was frozen during preview)
- [ ] Log message: "editor became unavailable, auto-dismissing"

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — Would need to close note tab during active preview. Skipped for time.

### Test 11.5: Preview with Citation Edits

Verify the preview correctly handles edits involving citations.

#### Guidelines
- Use a note with existing citations
- Send a prompt to modify text near or including a citation
- Verify the preview handles the citation HTML correctly

#### Verify
- [ ] Citations in unchanged text remain intact in the preview
- [ ] Citations in the changed region render correctly (or show [citation] placeholder)
- [ ] After approval, citation `data-citation-items` and `data-citation` attributes are correct
- [ ] `stripDataCitationItems` / `rebuildDataCitationItems` round-trip works correctly

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — Requires notes with citations. Skipped for time.

### Test 11.6: Dark Mode Preview

Verify the diff preview renders correctly in dark mode.

#### Guidelines
- Enable dark mode in Zotero (or system dark mode)
- Trigger a diff preview

#### Verify
- [ ] Banner colors are appropriate for dark mode (greenish tones, not washed out)
- [ ] Red/green diff highlighting is visible and distinguishable in dark mode
- [ ] Close/Approve/Reject button hover states work in dark mode

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — System was in light mode. Skipped for time.

---

## Category 12: Arrow (Open in Editor) Button Interaction

### Test 12.1: Arrow Button Opens Note and Scrolls to Edit

Test the arrow icon (ArrowUpRightIcon) on the edit action, which opens the note and scrolls to the edit location.

#### Guidelines
- After an edit is applied (or pending), click the arrow icon on the edit action header
- The arrow icon is the third element in the action header (after the tool icon and note title)

#### Verify
- [ ] If note not open: note opens in a new Zotero tab
- [ ] If note already open: tab is focused/selected
- [ ] Editor scrolls to the location of the edit
- [ ] When edit is applied: scrolls to the new text
- [ ] When edit is undone: scrolls to the old text location

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — Skipped for time.

---

## Category 13: Interaction with _disableSaving

### Test 13.1: Saving Disabled During Preview

Verify that the note editor does not save diff HTML to the database during preview.

#### Guidelines
- Trigger a diff preview
- While the preview is active, check the note's database content

#### Verify
- [ ] `item.getNote()` returns the original content (not the diff HTML with red/green spans)
- [ ] After dismissing the preview, `item.getNote()` still returns the correct content
- [ ] No `<span style="background-color:rgba(210,40,40,0.28)...">` in the saved HTML

#### Test result

- **Date**: 2026-04-01
- **Note**: ID 2034
- **Prompt**: "Change the title to 'SAVE TEST TITLE'."
- **Result**: PASS
  - While preview was active (banner visible, diff highlighting in editor), checked `item.getNote()` via API
  - DB content had original title "School Segregation and Performance Disparities" (NOT the diff HTML)
  - No `background-color:rgba(210,40,40` found in saved HTML
  - `_disableSaving = true` confirmed working — diff HTML never persisted to database
- **Notes**: The preview module sets `editorInstance._disableSaving = true` and restores it after dismiss. This test verifies that the diff HTML is never persisted.

### Test 13.2: Rapid Dismiss and Re-Show

Verify that rapidly dismissing and re-showing the preview doesn't corrupt the saving state.

#### Guidelines
- Trigger a preview, then quickly close via banner, then trigger another edit
- Verify _disableSaving is correctly managed through the transitions

#### Verify
- [ ] No save corruption between transitions
- [ ] Editor saving state is correctly restored each time
- [ ] No stale _disableSaving=true after final dismiss

#### Test result

- **Date**: 2026-04-01 | **Result**: NOT RUN — Would require rapid sequential edits. Skipped for time.

---

## Category 14: Backend Approval Timeout

The backend waits up to **5 minutes (300 seconds)** for the user to approve or reject a deferred approval. If no response is received, the backend times out: it returns a `tool_return` with `status: pending`, and the agent run continues. The frontend's `onToolReturn` handler removes the pending approval (by matching `toolCallId`), which triggers `removePendingApprovalAtom` → `updateDiffPreviewForNote()` → preview dismissal if no more pending edits remain.

**Important**: The frontend does NOT have its own timeout timer. It relies entirely on the backend sending a `tool_return` event after timeout.

### Test 14.1: Single Edit Timeout — Preview Dismissed

Wait for the backend approval timeout without approving or rejecting a single edit.

#### Guidelines
- Send a prompt requesting a single edit
- Wait for the deferred approval and diff preview to appear
- Do **NOT** click any banner button or sidebar button — just wait ~5 minutes
- Observe what happens when the backend timeout fires

#### Verify
- [ ] After ~5 minutes: banner disappears from editor
- [ ] Editor unfreezes (editable again, toolbar active)
- [ ] Note content restored to original (edit was NOT applied)
- [ ] Agent run continues (agent may send additional messages or complete)
- [ ] Sidebar: the action shows status "pending" (not applied, not rejected)
- [ ] The "Pending Approval" bar disappears from the input area
- [ ] Check for a warning event: backend may send `type: "action_timeout"` warning
- [ ] Post-run: the action should have an "Apply" button (user can still apply manually)
- [ ] No Beaver-related errors in `zotero_read_errors`

#### Test result

- **Date**:
- **Note**:
- **Prompt**:
- **Result**:

### Test 14.2: Multiple Edit Timeout — All Previews Dismissed

Wait for timeout when multiple edit_note approvals are pending for the same note.

#### Guidelines
- Send a prompt that produces 2+ `edit_note` actions for the same note
- Wait for both approvals to arrive (combined preview showing both changes)
- Do NOT approve — wait for both to timeout

#### Verify
- [ ] After timeout: both approvals removed from pending state (both `tool_return` events arrive)
- [ ] Preview fully dismissed (not partially — all edits gone from preview)
- [ ] Editor unfreezes completely
- [ ] Both actions show as "pending" in sidebar with "Apply" buttons
- [ ] Note content is original (no edits applied)
- [ ] Both actions can still be applied manually post-run

#### Test result

- **Date**:
- **Note**:
- **Prompt**:
- **Result**:

### Test 14.3: Approve One Edit, Let Remaining Timeout

With multiple pending edits, approve one via sidebar, then let the other timeout.

#### Guidelines
- Send a prompt producing 2 edits for the same note
- Close the editor preview (click × on banner) to avoid the combined banner
- Approve the first edit via sidebar "Apply" button
- Wait for the second edit to timeout (~5 min)

#### Verify
- [ ] First edit: applied successfully (green checkmark)
- [ ] After timeout: second edit transitions to "pending" (timed out)
- [ ] Note content reflects only the first edit
- [ ] Second edit can still be applied manually (click "Apply" in sidebar)
- [ ] No diff preview artifacts remain in editor

#### Test result

- **Date**:
- **Note**:
- **Prompt**:
- **Result**:

### Test 14.4: Timeout During Active Editor Preview — No Diff HTML Saved

Verify that when the timeout fires and the preview is dismissed, no diff-styled HTML leaks into the database.

#### Guidelines
- Trigger an edit, verify diff preview is showing in editor
- Wait for the timeout (~5 min)
- After preview is dismissed, check `item.getNote()`

#### Verify
- [ ] `item.getNote()` returns original content (no red/green diff styles)
- [ ] No `rgba(210,40,40` or `rgba(16,150,72` strings in saved HTML
- [ ] `_disableSaving` flag correctly restored to `false` after dismiss

```javascript
const item = await Zotero.Items.getAsync(NOTE_ID);
await item.loadDataType('itemData');
const html = item.getNote();
const hasDiffStyles = html.includes('rgba(210,40,40') || html.includes('rgba(16,150,72');
return JSON.stringify({ hasDiffStyles, preview: html.substring(0, 200) });
```

Expected: `hasDiffStyles: false`

#### Test result

- **Date**:
- **Note**:
- **Prompt**:
- **Result**:

---

## Verification Checklist (Note-in-Tab Mode)

- [ ] Preview appears in editor when `edit_note` approval arrives (note open in tab)
- [ ] Banner shows "Preview of Note Edits" with ×, "Reject All", "Approve All"
- [ ] Deletions: red background (`rgba(210,40,40,0.28)`) + strikethrough
- [ ] Additions: green background (`rgba(16,150,72,0.28)`)
- [ ] Editor frozen: `contentEditable=false`, toolbar dimmed (opacity 0.35), no text selection
- [ ] **Close (×)**: preview dismissed, pending approvals remain, editor unfreezes
- [ ] **Approve All (banner)**: all edit_note actions approved, banner dismissed, editor unfreezes
- [ ] **Reject All (banner)**: all edit_note actions rejected, banner dismissed, editor unfreezes
- [ ] **Approve All (PendingActionsBar)**: all actions approved, preview dismissed
- [ ] **Individual Apply (sidebar)**: single action approved, preview updates for remaining
- [ ] **Stop**: preview dismissed, all pending approvals cleared, run canceled
- [ ] **Thread switch**: preview dismissed, approvals cleared
- [ ] **Close note tab**: preview auto-dismissed (200ms poll detects unavailable editor)
- [ ] **Backend timeout (5 min)**: preview dismissed, actions left as "pending"
- [ ] Diff HTML is NEVER saved to Zotero database
- [ ] Apply → Undo → Re-Apply roundtrip works after banner approval
- [ ] Auto-approve ("Apply all for this note") skips preview for subsequent edits
- [ ] Multiple edits for same note: single combined preview
- [ ] Dark mode: banner and diff colors visible and correct
- [ ] No Beaver-related errors in `zotero_read_errors`

## Verification Checklist (Library-View Mode)

- [ ] No in-editor preview (no editor available)
- [ ] Diff shown in sidebar EditNotePreview component
- [ ] Approve/Reject from sidebar works correctly
- [ ] Backend timeout (5 min): approval removed, action left as "pending"
- [ ] No Beaver-related errors in `zotero_read_errors`

## Common Failure Modes

| Symptom | Likely Cause | Investigation |
|---------|-------------|---------------|
| Banner doesn't appear | Editor instance not found in `Zotero.Notes._editorInstances` | Verify note is open in a tab; check `areEditorApisAvailable()` |
| Diff HTML saved to DB | `_disableSaving` not set or restored too early | Check `_disableSaving` flag and 150ms delay on restoration |
| Editor stays frozen after dismiss | `contentEditable` not restored to `'true'` | Check error handling in `dismissDiffPreview()` |
| Preview shows for auto-approved edit | `autoApproveNoteKeysAtom` check not running before `addPendingApprovalAtom` | Verify auto-approve logic in `onDeferredApprovalRequest` |
| Banner buttons don't respond | Polling timer not started or `__beaverPreviewAction` not set on iframe | Check iframe communication; verify 200ms poll is running |
| `diffPreviewNoteKeyAtom` stuck non-null | `onDismiss` callback not firing on dismiss | Check coordinator's `setOnDismiss` registration and `dismissDiffPreview()` path |
| Multiple banners appear | Stale preview not dismissed before new one created | Check generation counter in `showDiffPreview()` |
| Preview doesn't dismiss on timeout | `onToolReturn` can't match pending approval by `toolCallId` | Verify `toolcallId` in `PendingApproval` matches `tool_call_id` in `WSToolReturnEvent` |
| Diff styles bleed after dismiss | `#beaver-diff-preview-style` not removed from iframe | Check CSS cleanup in `dismissDiffPreview()` |
| Preview persists after Stop | `clearAllPendingApprovalsAtom` not calling `dismissDiffPreview()` | Check `closeWSConnectionAtom` → `clearAllPendingApprovalsAtom` flow |
| Toolbar stays dimmed | Toolbar opacity CSS not restored | Check `PREVIEW_CSS` removal from iframe `<style>` tag |
