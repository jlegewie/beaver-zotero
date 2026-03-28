Test the Beaver note editing feature end-to-end using the Zotero MCP server. This runs a complete automated test: open a note, send an edit prompt, verify the edit, test undo/apply, and test the open-in-editor button.

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

## Verification Checklist

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
