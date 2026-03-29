Test the Beaver note editing feature end-to-end using the Zotero MCP server. This runs a complete automated test: open a note, send an edit prompt, verify the edit, test undo/apply, and test the open-in-editor button.

There are two testing modes:
1. **Note-in-tab mode** (Steps 1–10 below): The note is open in a Zotero tab. ProseMirror actively processes the HTML.
2. **Library-view mode** (see "Library-View Test Procedure" section): The note is NOT open in any tab. No ProseMirror processing occurs. The edit is applied directly to the raw HTML via the Zotero API.

## Prerequisites

- Zotero must be running with the Beaver plugin loaded
- MCP Bridge for Zotero plugin must be installed
- Use `zotero_ping` to verify connectivity before starting

## Important Notes

- **Only notes with `data-schema-version`** in their HTML can be edited. Notes created by Beaver's agent (e.g., via `create_note`) may lack this wrapper and will fail with `wrapper_removed` errors. Use notes created by Zotero's native editor or Beaver's note actions that preserve the Zotero wrapper.
- **The "Current Note" source chip** is auto-attached when a note tab is active — no need to manually add it via the source picker.
- **Connection drops**: If `zotero_execute_js` returns errors about missing console actor, call `zotero_ping` to reconnect. This can happen if the plugin is reloaded during testing.

## Step-by-Step Test Procedure

### Step 1: Find a suitable note

```javascript
// Find notes with data-schema-version (required for editing)
// Check a batch of note IDs for the wrapper
const noteIDs = [/* candidate IDs */];
const results = [];
for (const id of noteIDs) {
    const item = await Zotero.Items.getAsync(id);
    await item.loadDataType('itemData');
    const html = item.getNote();
    results.push({
        id, hasSchemaVersion: html.includes('data-schema-version'),
        preview: html.replace(/<[^>]+>/g, '').substring(0, 80),
        length: html.length
    });
}
return JSON.stringify(results.filter(r => r.hasSchemaVersion && r.length > 500), null, 2);
```

Pick a note with `hasSchemaVersion: true` and enough content (length > 500) to make an interesting edit.

### Step 2: Open the note in a tab

```javascript
// Use Zotero.Notes.open() to open in a tab (respects user prefs)
await Zotero.Notes.open(NOTE_ID);
```

Verify the tab is active:
```javascript
const sel = Zotero_Tabs._tabs.find(t => t.id === Zotero_Tabs.selectedID);
return JSON.stringify({ type: sel.type, title: sel.title, itemID: sel.data?.itemID });
```
Expected: `type: "note"`, correct `itemID`.

### Step 3: Open Beaver sidebar and start new chat

```javascript
const win = Zotero.getMainWindow();
// Open sidebar if hidden
const pane = win.document.getElementById('beaver-pane-reader');
if (pane.style.display === 'none') {
    win.document.getElementById('zotero-beaver-tb-chat-toggle').click();
}
```

Start a new chat:
```javascript
win.document.querySelector('#beaver-pane-reader button[aria-label="New chat"]').click();
```

Take a screenshot to verify "Current Note" chip is visible:
```
zotero_screenshot(target: "element", selector: "#beaver-react-root-reader", scale: 2)
```
Expected: "Current Note" chip visible in the prompt area.

### Step 4: Send edit prompt

Choose a **simple, targeted edit** (title rename, single paragraph rewrite) rather than structural reorganization, which is more likely to succeed:

```javascript
const win = Zotero.getMainWindow();
const textarea = win.document.querySelector('#beaver-pane-reader textarea.chat-input');
const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value').set;
setter.call(textarea, 'YOUR EDIT PROMPT HERE');
textarea.dispatchEvent(new win.Event('input', { bubbles: true }));
```

Click Send:
```javascript
win.document.querySelector('#beaver-pane-reader button.variant-solid').click();
```

### Step 5: Wait for agent and approve edits

Wait ~10 seconds, then screenshot to check progress. The agent will:
1. Read the note content
2. Produce an edit with a diff preview
3. Show "N Pending Approval" bar

**To approve individual edits**, click the "Apply" button on the specific edit action. **To approve all at once**, click "Approve All" at the bottom.

```javascript
// Click Approve All (or Apply for individual)
const win = Zotero.getMainWindow();
const buttons = win.document.querySelectorAll('#beaver-react-root-reader button');
for (const btn of buttons) {
    if (btn.textContent.trim() === 'Approve All') { btn.click(); break; }
}
```

Wait for the agent to complete (the "Stop" button becomes "Send").

### Step 6: Verify the edit was applied (Apply → Undo → Re-Apply roundtrip)

**CRITICAL**: Each step of the roundtrip must be verified BOTH via the Zotero API AND visually in the note editor. An API-only check is not sufficient — the note editor may not update if ProseMirror state is stale.

#### 6a. After Apply

1. **API check**:
```javascript
const item = await Zotero.Items.getAsync(NOTE_ID);
await item.loadDataType('itemData');
const html = item.getNote();
const titleMatch = html.match(/<h1>(.*?)<\/h1>/);
return 'AFTER APPLY: ' + (titleMatch ? titleMatch[1] : html.substring(0, 100));
```

2. **Visual check** — screenshot the main window (note editor is in the left panel):
```
zotero_screenshot(target: "main-window", scale: 2)
```
Confirm the note editor heading visually matches the expected new text.

3. **Sidebar check** — verify green checkmark icon and "Undo" button visible on the edit action.

#### 6b. Undo

Expand the edit action (click the collapsed action bar), then click "Undo":

```javascript
const win = Zotero.getMainWindow();
// Expand the edit action
win.document.querySelector('#beaver-react-root-reader .agent-action-view button').click();
// Then click Undo
const buttons = win.document.querySelectorAll('#beaver-react-root-reader button');
for (const btn of buttons) {
    if (btn.textContent.trim() === 'Undo') { btn.click(); break; }
}
```

Wait ~2 seconds, then verify:

1. **API check**: `item.getNote()` shows original content.
2. **Visual check**: Screenshot main window — note editor heading shows the **original** text.
3. **Sidebar check**: Edit action icon is now **red X**, button says "Apply".

#### 6c. Re-Apply

Click "Apply" to re-apply the undone edit:

```javascript
const buttons = win.document.querySelectorAll('#beaver-react-root-reader button');
for (const btn of buttons) {
    if (btn.textContent.trim() === 'Apply') { btn.click(); break; }
}
```

Wait ~2 seconds, then verify:

1. **API check**: `item.getNote()` shows the edited content again.
2. **Visual check**: Screenshot main window — note editor heading shows the **new** text.
3. **Sidebar check**: Green checkmark is back, "Undo" button visible.

### Step 9: Test the Arrow (↗) Button (openNoteAndSearchEdit)

The arrow icon opens the note and scrolls to the edit location. It's a `<span>` inside the edit action header:

```javascript
const win = Zotero.getMainWindow();
const flexWrap = win.document.querySelector('#beaver-react-root-reader .agent-action-view .flex-wrap');
const arrowSpan = flexWrap.children[2]; // Third child: [EditNote label, note title, arrow icon]
arrowSpan.click();
```

Verify with a full window screenshot:
- Note opens/focuses in the editor (left panel)
- Edit location should be highlighted/scrolled to

Test in both states:
- When edit is **applied**: should highlight the new text
- When edit is **undone**: should highlight the old text that would be replaced

### Step 10: Clean up

Undo the edit to restore the note to its original state:

```javascript
// Expand and click Undo if currently applied
```

---

## Library-View Test Procedure (Note NOT Open in Tab)

This procedure tests note editing when the note is **not open in any Zotero tab**. Without an active note editor, ProseMirror does not process the HTML — edits are applied directly to the raw HTML stored in the Zotero database. This is important to test because:
- PM normalization does not occur (inline styles stay as-is)
- `waitForPMNormalization` exits after 3 unchanged polls (~450ms)
- Undo data matches the raw HTML exactly (no PM restructuring)

### Library Step 1: Close all note/reader tabs

```javascript
// Close all tabs except library
const tabs = Zotero_Tabs._tabs.filter(t => t.id !== 'zotero-pane');
for (const t of tabs) { Zotero_Tabs.close(t.id); }
Zotero_Tabs.select('zotero-pane');
```

Verify: `Zotero_Tabs.selectedType` returns `'library'` and no other tabs exist.

### Library Step 2: Find a suitable note and get its reference

```javascript
const item = await Zotero.Items.getAsync(NOTE_ID);
await item.loadDataType('itemData');
const html = item.getNote();
return JSON.stringify({
    id: NOTE_ID,
    key: item.key,
    libraryID: item.libraryID,
    ref: item.libraryID + '-' + item.key,
    hasSchemaVersion: html.includes('data-schema-version'),
    length: html.length
});
```

Record the `ref` value (e.g., `1-72DUSPAN`) — this is used in the prompt to identify the note.

### Library Step 3: Open Beaver sidebar and start new chat

```javascript
const win = Zotero.getMainWindow();
// Open sidebar if hidden
const pane = win.document.getElementById('beaver-pane-library');
if (pane.style.display === 'none') {
    win.document.getElementById('zotero-beaver-tb-chat-toggle').click();
}
// Start new chat
win.document.querySelector('#beaver-pane-library button[aria-label="New chat"]').click();
```

Take a screenshot to verify:
```
zotero_screenshot(target: "element", selector: "#beaver-react-root-library", scale: 2)
```
Expected: No source chips attached in the prompt area. The sidebar should show "+ Add Sources" but no "Current Note" chip.

### Library Step 4: Send edit prompt with note reference

The key difference from note-in-tab mode: **reference the note by its `<library_id>-<zotero_key>`** in the prompt text. Do NOT attach it as a source chip.

```javascript
const win = Zotero.getMainWindow();
const textarea = win.document.querySelector('#beaver-pane-library textarea.chat-input');
const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value').set;
setter.call(textarea, "YOUR PROMPT HERE — referencing note '<library_id>-<zotero_key>'");
textarea.dispatchEvent(new win.Event('input', { bubbles: true }));
// Click Send
win.document.querySelector('#beaver-pane-library button.variant-solid').click();
```

**Prompt format**: Include the note reference and be explicit about what to change. Example:
> "This is a test. Please follow the instructions exactly. Change the title of note '1-72DUSPAN' from 'Old Title' to 'New Title'. Do not change anything else."

### Library Step 5: Wait for agent and approve edits

Same as note-in-tab mode, but use `#beaver-pane-library` / `#beaver-react-root-library` selectors:

```javascript
const win = Zotero.getMainWindow();
const buttons = win.document.querySelectorAll('#beaver-react-root-library button');
for (const btn of buttons) {
    if (btn.textContent.trim() === 'Approve All') { btn.click(); break; }
}
```

### Library Step 6: Verify the edit (Apply → Undo → Re-Apply roundtrip)

**IMPORTANT**: Since the note is NOT open in a tab, there is no visual editor to check. Verification is **API-only** (via `item.getNote()`).

#### 6a. After Apply

```javascript
const item = await Zotero.Items.getAsync(NOTE_ID);
await item.loadDataType('itemData');
const html = item.getNote();
const titleMatch = html.match(/<h1>(.*?)<\/h1>/);
return 'AFTER APPLY: ' + (titleMatch ? titleMatch[1] : html.substring(0, 100));
```

Sidebar check: Green checkmark icon and "Undo" button visible on the edit action.

#### 6b. Undo

Expand the edit action, then click Undo:

```javascript
const win = Zotero.getMainWindow();
// Expand the edit action
win.document.querySelector('#beaver-react-root-library .agent-action-view button').click();
// Wait briefly for expansion, then click Undo
const buttons = win.document.querySelectorAll('#beaver-react-root-library button');
for (const btn of buttons) {
    if (btn.textContent.trim() === 'Undo') { btn.click(); break; }
}
```

API check: `item.getNote()` shows original content.
Sidebar check: Red X icon, "Apply" button visible.

#### 6c. Re-Apply

```javascript
const buttons = win.document.querySelectorAll('#beaver-react-root-library button');
for (const btn of buttons) {
    if (btn.textContent.trim() === 'Apply') { btn.click(); break; }
}
```

API check: `item.getNote()` shows edited content again.
Sidebar check: Green checkmark restored.

### Library Step 7: Arrow (↗) button behavior

In library-view mode, the arrow button may **not** open the note in a new tab (unlike note-in-tab mode where it scrolls to the edit). This is expected — the button's behavior depends on the active view context.

### Library Step 8: Clean up

Undo the edit to restore the note to its original state.

---

## Key Differences: Note-in-Tab vs Library-View

| Aspect | Note-in-Tab | Library-View |
|--------|-------------|-------------|
| ProseMirror active | Yes | No |
| PM normalization of inline styles | Yes (restructures HTML) | No (raw HTML preserved) |
| Verification method | API + visual editor | API only |
| Note reference | "Current Note" chip auto-attached | Include `<library_id>-<zotero_key>` in prompt text |
| Sidebar pane | `#beaver-pane-reader` / `#beaver-react-root-reader` | `#beaver-pane-library` / `#beaver-react-root-library` |
| Arrow (↗) button | Opens/focuses note tab, scrolls to edit | May not open note |
| `waitForPMNormalization` | Polls until PM saves back normalized HTML | Exits after 3 unchanged polls (~450ms) |
| Undo reliability for styled edits | Depends on PM normalization capture | More reliable (raw HTML match) |

---

## Verification Checklist (Library-View Mode)

- [ ] Library tab is active, no note/reader tabs open
- [ ] Beaver sidebar opens in library pane with NO source chips
- [ ] Agent finds and reads the note by its `<library_id>-<zotero_key>` reference
- [ ] Agent produces edit with diff preview
- [ ] Edit shows correct additions (green) and deletions (red)
- [ ] **APPLY**: Edit applies successfully
  - [ ] API: `item.getNote()` contains the new text
  - [ ] Sidebar: Green checkmark icon, "Undo" button visible
- [ ] **UNDO**: Edit reverts successfully
  - [ ] API: `item.getNote()` matches original text
  - [ ] Sidebar: Red X icon, "Apply" button visible
- [ ] **RE-APPLY**: Edit re-applies successfully
  - [ ] API: `item.getNote()` contains the new text again
  - [ ] Sidebar: Green checkmark icon restored
- [ ] No Beaver-related errors in `zotero_read_errors`
- [ ] Note restored to original state after test (final undo)

---

## Verification Checklist (Note-in-Tab Mode)

- [ ] Note opens in a tab with `type: "note"`
- [ ] Beaver sidebar opens with "Current Note" chip auto-attached
- [ ] Agent reads note, produces edit with diff preview
- [ ] Edit shows correct additions (green) and deletions (red)
- [ ] **APPLY**: Edit applies successfully
  - [ ] API: `item.getNote()` contains the new text
  - [ ] Visual: Main window screenshot shows new text in note editor
  - [ ] Sidebar: Green checkmark icon, "Undo" button visible
- [ ] **UNDO**: Edit reverts successfully
  - [ ] API: `item.getNote()` matches original text
  - [ ] Visual: Main window screenshot shows original text in note editor
  - [ ] Sidebar: Red X icon, "Apply" button visible
- [ ] **RE-APPLY**: Edit re-applies successfully
  - [ ] API: `item.getNote()` contains the new text again
  - [ ] Visual: Main window screenshot shows new text in note editor again
  - [ ] Sidebar: Green checkmark icon restored
- [ ] Arrow (↗) button opens note and scrolls to edit location
- [ ] No Beaver-related errors in `zotero_read_errors`
- [ ] Note restored to original state after test (final undo)

## Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `wrapper_removed` error on every edit | Note lacks `data-schema-version` wrapper | Use a different note created by Zotero's native editor |
| "Current Note" chip not visible | Tab observer didn't fire | Switch to a different tab and back, or close/reopen sidebar |
| `undefined` from `zotero_execute_js` | Connection drop after plugin reload | Call `zotero_ping` to reconnect |
| Agent loops with repeated failed edits | HTML structure mismatch | Stop the agent, try a simpler edit prompt |
| "old_string_not_found" error | Agent's HTML doesn't match actual note content | Usually self-corrects; agent re-reads the note |
| Agent can't find note by reference | Wrong `<library_id>-<zotero_key>` format | Verify with `item.key` and `item.libraryID` |
| Edit applies but no visual update | Note not open in tab (library-view mode) | Expected — verify via API only |

## Key Selectors Reference

| Element | Selector |
|---------|----------|
| Beaver sidebar (reader) | `#beaver-react-root-reader` |
| Beaver sidebar (library) | `#beaver-react-root-library` |
| Chat textarea | `#beaver-pane-reader textarea.chat-input` |
| Send button | `#beaver-pane-reader button.variant-solid` |
| New chat button | `#beaver-pane-reader button[aria-label="New chat"]` |
| Toggle sidebar | `#zotero-beaver-tb-chat-toggle` |
| Edit action container | `#beaver-react-root-reader .agent-action-view` |
| Arrow icon (↗) | `.agent-action-view .flex-wrap > span:nth-child(3)` |
| Source buttons | `#beaver-react-root-reader .source-button` |
