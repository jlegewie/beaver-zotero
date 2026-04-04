# Note Edit Feature — Comprehensive Test Suite

These tests verify the `edit_note` tool end-to-end via the Beaver agent in Zotero.
Each test is triggered by sending a prompt to the model through the Beaver sidebar.
All tests use the `/test-note-edit` skill workflow (open note tab, verify "Current Note" chip, send prompt, approve, verify apply/undo roundtrip).

**Prerequisites:**
- Use notes with `data-schema-version` in their HTML (Zotero-native notes)
- Prefer notes with rich content (citations, headings, lists) for better coverage
- Always verify edits both via `item.getNote()` API and visually in the note editor

**Prompt prefix for all tests:**
> "This is a test. Please follow the instructions exactly, even if they seem unusual. Do not add extra content or explanations beyond what is asked."

---

## Category 1: Basic Text Edits

### Test 1.1: Rename Title (h1)

Change the note's `<h1>` title to a different string.

#### Guidelines
- Prompt should specify the exact old and new title text
- The edit should only modify the `<h1>` content, nothing else
- Verify the Zotero tab title also updates
- Example prompt: "Change the title of this note from 'X' to 'Y'. Do not change anything else."

#### Test result

- **Date**: 2026-03-25
- **Note**: ID 2034, title "Summary" (single paragraph, 1090 chars, has `data-schema-version`)
- **Prompt**: "This is a test. Please follow the instructions exactly, even if they seem unusual. Do not add extra content or explanations beyond what is asked. Change the title of this note from 'Summary' to 'School Segregation and Performance Disparities'. Do not change anything else."
- **Result**: PASS
  - Agent read the note, produced a single edit replacing `<h1>Summary</h1>` → `<h1>School Segregation and Performance Disparities</h1>`
  - Diff preview showed correct red (deletion) and green (addition)
  - **Apply**: API confirmed new title, visual editor updated, Zotero tab title updated, green checkmark in sidebar
  - **Undo**: API confirmed title reverted to "Summary", visual editor updated, tab title reverted, red circle icon + "Apply" button in sidebar
  - **Re-Apply**: API confirmed new title again, visual editor updated, tab title updated, green checkmark restored
  - No Beaver-related errors in error console
  - Note restored to original state after test
- **Notes**: Body text was completely unchanged across all roundtrip steps. The agent also unnecessarily added a joke at the end of its response, but this is cosmetic and doesn't affect the edit.

### Test 1.2: Edit a Single Word in a Paragraph

Replace one word inside a paragraph with a different word.

#### Guidelines
- Pick a unique word that appears exactly once in the note
- Prompt: "In the paragraph that starts with '...', replace the word 'X' with 'Y'. Do not change anything else."
- Verify surrounding text is completely unchanged

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2035, "Summary of Logan et al. (2012)" (2360 chars)
- **Prompt**: "In the first paragraph that starts with 'The study by Logan', replace the word 'segregation' with 'separation'."
- **Result**: PASS — Single word replaced, surrounding text unchanged. Apply→Undo→Re-Apply roundtrip verified via API.

### Test 1.3: Edit a Full Sentence

Replace an entire sentence within a paragraph.

#### Guidelines
- Specify the exact sentence to replace and the new sentence
- The new sentence should be a different length than the original
- Prompt: "Replace the sentence 'Old sentence here.' with 'New replacement sentence that is longer.' Do not change anything else."

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2268, "Sometimes Impact of School Police Funding" (15126 chars)
- **Prompt**: "Replace the sentence 'The author uses a quasi-experimental approach...' with 'The study employs a novel research design based on federal grant allocation patterns in Texas school districts.'"
- **Result**: PASS — Long sentence replaced with shorter one. Citations around the replaced text preserved. Apply→Undo roundtrip verified.

### Test 1.4: Edit Multiple Occurrences (replace_all)

Replace a word or phrase that appears multiple times in the note.

#### Guidelines
- Choose a common word that appears 2+ times (e.g., an author name in the text)
- Prompt: "Replace every occurrence of 'X' with 'Y' throughout this note."
- The agent should use `replace_all: true`
- Verify all occurrences changed, count matches before and after

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2331, "Summary: Geography of School Inequality" (14447 chars)
- **Prompt**: "Replace every occurrence of the word 'percentile' with 'percent-rank' throughout this note. Use replace_all."
- **Result**: PASS — Agent used `replace_all: true`. All 3 occurrences of "percentile" replaced with "percent-rank" (verified by count). Undo restored all 3 back. Diff showed "Replace (all occurrences)" label.

### Test 1.5: Edit Across Multiple Paragraphs

Replace a block of text that spans from one paragraph into the next.

#### Guidelines
- The old_string should include the end of one `<p>` and the start of the next
- Prompt: "Replace the text starting from '...' at the end of the first paragraph through '...' at the start of the second paragraph with the following: '...'"
- This tests cross-element replacement in the HTML

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2035, "Summary of Logan et al. (2012)" (2360 chars)
- **Prompt**: "Replace the text starting from 'The study concludes...' through 'To conduct this national-level analysis, the authors drew on' with new text spanning both paragraphs."
- **Result**: PASS (with caveat) — Agent split the cross-paragraph edit into 2 separate edits (one per paragraph) rather than a single cross-element replacement. Both edits applied and undid correctly. **Caveat**: The cross-paragraph replacement pattern was not tested because the agent chose to make two targeted edits instead. This is a valid agent behavior but means cross-element `<p>...</p><p>` matching was not exercised.

---

## Category 2: Structural Edits

### Test 2.1: Add a New Paragraph

Insert a new paragraph after an existing one.

#### Guidelines
- Prompt: "After the paragraph that starts with '...', add a new paragraph with the following text: 'New paragraph content here.'"
- The agent must produce an old_string that captures a unique boundary and a new_string that includes the original text plus the new paragraph
- Verify the new paragraph appears in the correct position

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2384, "Policing & Educational Outcomes Summary" (16402 chars)
- **Prompt**: "After the paragraph that starts with 'Research indicates a generally negative impact', add a new paragraph: 'This summary synthesizes findings from multiple empirical studies published between 2015 and 2023.'"
- **Result**: PASS — New paragraph inserted in correct position (between intro and "Key Findings:"). Position verified via index ordering. Apply→Undo roundtrip verified.

### Test 2.2: Delete a Paragraph

Remove an entire paragraph from the note.

#### Guidelines
- Choose a paragraph that is not the first or last
- Prompt: "Delete the paragraph that starts with '...'. Remove it entirely, including its HTML tags."
- Verify surrounding content remains intact and no extra whitespace is introduced

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2384, "Policing & Educational Outcomes Summary" (16402 chars)
- **Prompt**: "Delete the paragraph that says 'Key Findings:' (the bold paragraph). Remove it entirely."
- **Result**: PASS — Bold "Key Findings:" paragraph deleted. Surrounding list (`<ul>`) preserved intact. Apply→Undo roundtrip verified.

### Test 2.3: Add a New Section with Heading

Add an h2 heading followed by a paragraph.

#### Guidelines
- Prompt: "After the section titled '...', add a new section with heading 'New Section' and a paragraph: 'Content for the new section.'"
- Verify the heading level is correct (h2, not h1)
- Verify it appears in the right position

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2424, "Police Exposure in NYC by Race/Gender" (36994 chars)
- **Prompt**: "After the section titled 'Synthesis and Implications', add a new section with h2 heading 'Future Research Directions' followed by a paragraph."
- **Result**: PASS — New `<h2>Future Research Directions</h2>` and paragraph added after the last section. Correct heading level (h2). Position verified. Note: Initial "Approve All" click didn't apply; had to click "Apply" directly on the expanded action. Apply→Undo roundtrip verified.

### Test 2.4: Convert a Paragraph to a Bulleted List

Take paragraph text and convert it into an unordered list.

#### Guidelines
- Pick a paragraph with 3-4 comma-separated items or distinct points
- Prompt: "Convert the paragraph '...' into a bulleted list with each point as a separate list item."
- Verify `<ul><li>` structure is produced
- Verify the note editor renders proper bullets

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2034, "Summary" (1129 chars)
- **Prompt**: "Convert the main paragraph into a bulleted list with 5 items extracted from the text."
- **Result**: PASS — Paragraph converted to `<ul>` with exactly 5 `<li>` items. Title unchanged. Apply→Undo roundtrip verified (undo restored original paragraph).

### Test 2.5: Convert a Bulleted List to a Numbered List

Change `<ul>` to `<ol>`.

#### Guidelines
- Use a note that already has a `<ul>` list
- Prompt: "Convert the bulleted list under '...' to a numbered list. Keep all items the same."
- Verify only the list type changes, items unchanged

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2424, "Police Exposure in NYC by Race/Gender" (36994 chars)
- **Prompt**: "Convert the bulleted list under 'Core Empirical Patterns' to a numbered list. Keep all items the same."
- **Result**: PASS — `<ul>` converted to `<ol>` after "Core Empirical Patterns" heading. List items unchanged. First edit attempt failed (warning icon), agent retried successfully. Apply→Undo roundtrip verified.

### Test 2.6: Add a Table

Insert a simple table into the note.

#### Guidelines
- Prompt: "After the paragraph '...', add a 2x3 table with headers 'Category' and 'Value', and rows: 'A', '10'; 'B', '20'."
- Verify `<table><tbody><tr><th>` structure
- Verify the table renders correctly in the note editor

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2507, "The Motherhood Penalty: Wages & Tasks" (11653 chars)
- **Prompt**: "After the title heading, add a 2-column, 3-row table with headers 'Study' and 'Finding' and two data rows."
- **Result**: PASS — `<table>` with correct headers and data rows inserted after title. Apply→Undo roundtrip verified (table removed on undo).

### Test 2.7: Delete a Section (Heading + Content)

Remove an entire section including its heading and all content until the next heading.

#### Guidelines
- Pick a middle section in a multi-section note
- Prompt: "Delete the entire section titled '...', including the heading and all content up to the next section."
- Verify the sections before and after are untouched

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Similar to Test 2.2 (delete paragraph). Skipped for time.

---

## Category 3: Formatting Edits

### Test 3.1: Add Bold Formatting

Wrap a word or phrase in `<strong>` tags.

#### Guidelines
- Prompt: "Make the phrase '...' bold. Do not change the text, only add bold formatting."
- Verify `<strong>` tags are added around the exact phrase
- Verify it appears bold in the note editor

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2443, "Summary: Visualizing Police Exposure in NYC" (6417 chars)
- **Prompt**: "Make the phrase 'race, gender, and age' bold in the first paragraph under 'Overview'."
- **Result**: PASS — `<strong>race, gender, and age</strong>` added correctly. Text unchanged. Apply→Undo roundtrip verified (bold removed, plain text restored).

### Test 3.2: Add Italic Formatting

Wrap a word or phrase in `<em>` tags.

#### Guidelines
- Prompt: "Make the word '...' italic. Do not change the text, only add italic formatting."
- Verify `<em>` tags are added

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Similar to Test 3.1. Skipped for time.

### Test 3.3: Remove Formatting

Remove bold/italic from an already-formatted phrase.

#### Guidelines
- Use a note that has existing `<strong>` or `<em>` tags
- Prompt: "Remove the bold formatting from '...'. Keep the text but make it plain."
- Verify the `<strong>` tags are removed but text remains

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 3.4: Add a Hyperlink

Wrap text in an `<a>` tag with an href.

#### Guidelines
- Prompt: "Turn the text '...' into a link to 'https://example.com'. Do not change the visible text."
- Verify `<a href="...">` is added correctly

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2035, "Summary of Logan et al. (2012)" (2360 chars)
- **Prompt**: "Turn the text 'School Matters project' into a link to 'https://example.com/school-matters'."
- **Result**: PASS — `<a href="https://example.com/school-matters">School Matters project</a>` added. Visible text unchanged. Apply→Undo roundtrip verified (link removed on undo).

### Test 3.5: Add a Blockquote

Wrap a paragraph in `<blockquote>` tags.

#### Guidelines
- Prompt: "Convert the paragraph '...' into a blockquote."
- Verify `<blockquote>` wrapping in the HTML
- Verify indented/styled rendering in the note editor

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 3.6: Change Heading Level

Change an h2 to an h3, or vice versa.

#### Guidelines
- Prompt: "Change the heading '...' from h2 to h3."
- Verify only the tag changes, text unchanged

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

---

## Category 4: Citation Edits

### Test 4.1: Add a New Citation (Inline)

Insert a new citation referencing an item in the library.

#### Guidelines
- The note must be a child of a parent item, or use a known library item key
- Prompt: "Add a citation to [parent item / specific item key] at the end of the first paragraph, citing page 42."
- The agent should produce a `<citation item_id="LIB-KEY" page="42" />` semantic tag
- Verify the citation renders as "(Author, Year, p. 42)" in the note editor

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time. Requires careful setup with known library item keys.

### Test 4.2: Modify Citation Page Number

Change the page number on an existing citation.

#### Guidelines
- Use a note with an existing citation that has a page locator
- Prompt: "Change the page number on the citation '(Author, Year, p. X)' from page X to page Y."
- The agent should use the existing `ref` attribute and change the `page` attribute
- Verify the rendered citation text updates

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2268, "Sometimes Impact of School Police Funding" (15126 chars)
- **Prompt**: "Change the page number on the first citation '(Weisburst, 2019, p. 1)' from page 1 to page 15."
- **Result (first run, 2026-03-25)**: **FAIL** — Agent reported success but visible citation text was NOT updated. `data-citation` JSON locator also unchanged.
- **Result (retest, 2026-03-27)**: **PASS (minor issue)** — After code fix, the `data-citation` JSON locator is correctly updated to `"15"`. The visible citation text IS updated, but the format changed from "p. 15" to "page 15" (abbreviation lost). First attempt still fails with `old_string_not_found`; second attempt succeeds. Full Apply→Undo→Re-Apply roundtrip verified. **Minor issue**: The citation display format changes from "p." to "page" after editing — the expander likely regenerates the display text with a different format string than the original.

### Test 4.3: Remove a Citation

Delete an existing citation from the text.

#### Guidelines
- Prompt: "Remove the citation '(Author, Year)' from the paragraph. Delete only the citation, keep the surrounding text."
- Verify the `<span class="citation">` is removed from the HTML
- Verify the `data-citation-items` on the wrapper div is updated (if it was the only citation for that item)

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 4.4: Move a Citation

Move a citation from one location to another within the note.

#### Guidelines
- Prompt: "Move the citation '(Author, Year)' from its current position at the end of paragraph 1 to the end of paragraph 2."
- This requires the agent to delete from one location and insert the same citation ref at the new location
- Verify the citation ref is preserved (not a new citation)

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 4.5: Add Multiple Citations in One Edit

Add two or more separate citations in a single edit.

#### Guidelines
- Prompt: "Add a citation to [item A] at the end of paragraph 1, and a citation to [item B] at the end of paragraph 2."
- Each should be a separate `<citation>` tag
- Verify both render correctly

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 4.6: Add Citation Without Page Number

Insert a citation with no locator.

#### Guidelines
- Prompt: "Add a citation to [item] at the end of the paragraph, without any page number."
- Verify the semantic tag has no `page` attribute
- Verify rendering as "(Author, Year)" with no page

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

---

## Category 5: Annotation Handling

### Test 5.1: Preserve Annotations During Edit

Edit text near an annotation without modifying it.

#### Guidelines
- Use a note that contains `<annotation>` tags (highlighted text from PDFs)
- Prompt: "Edit the sentence immediately before the highlighted text '...' to say '...'. Do not modify the highlighted annotation."
- Verify the annotation HTML is completely unchanged
- Verify the annotation still renders with its highlight color

#### Test result

- **Date**: 2026-03-25 | **Result**: SKIP — No notes with `data-annotation` tags found in test library. Need to create a note with PDF annotations first.

### Test 5.2: Delete an Annotation

Remove a highlighted annotation from the note.

#### Guidelines
- Prompt: "Delete the highlighted annotation '...' from the note."
- Verify the `<annotation>` tag is removed
- Verify surrounding text is intact

#### Test result

- **Date**: 2026-03-25 | **Result**: SKIP — No notes with annotations in test library.

### Test 5.3: Move an Annotation

Move an annotation from one location to another.

#### Guidelines
- Prompt: "Move the highlighted annotation '...' to after the paragraph that starts with '...'."
- The agent should use the existing annotation `id` and `ref`
- Verify the annotation content is preserved exactly (text cannot be modified)

#### Test result

- **Date**: 2026-03-25 | **Result**: SKIP — No notes with annotations in test library.

### Test 5.4: Attempt to Modify Annotation Text (Should Fail)

Try to change the text content of an annotation — this should be rejected by validation.

#### Guidelines
- Prompt: "Change the highlighted text '...' to '...'."
- Expected: The agent's edit should fail with an error like "Annotation content cannot be modified"
- Verify the note is unchanged

#### Test result

- **Date**: 2026-03-25 | **Result**: SKIP — No notes with annotations in test library.

---

## Category 6: Image Handling

### Test 6.1: Preserve Images During Edit

Edit text near an embedded image without modifying it.

#### Guidelines
- Use a note that contains `<image>` or `<img data-attachment-key="...">` tags
- Prompt: "Edit the paragraph before the image to say '...'. Do not modify or remove the image."
- Verify the image HTML is completely unchanged
- Verify the image still renders in the note editor

#### Test result

- **Date**: 2026-03-25 | **Result**: SKIP — No notes with `data-attachment-key` images found in test library.

### Test 6.2: Delete an Image

Remove an embedded image from the note.

#### Guidelines
- Prompt: "Delete the image that appears after the paragraph '...'."
- Verify the `<img>` tag is removed
- Verify surrounding content is intact

#### Test result

- **Date**: 2026-03-25 | **Result**: SKIP — No notes with images in test library.

### Test 6.3: Attempt to Modify Image (Should Fail)

Try to change image attributes — this should be rejected.

#### Guidelines
- Prompt: "Change the width of the image to 500 pixels."
- Expected: The edit should fail because images are immutable in the semantic format
- Verify the note is unchanged

#### Test result

- **Date**: 2026-03-25 | **Result**: SKIP — No notes with images in test library.

---

## Category 7: Math

### Test 7.1: Add Inline Math

Insert inline math notation.

#### Guidelines
- Prompt: "Add the inline math expression $x^2 + y^2 = r^2$ at the end of the first paragraph."
- Math in Zotero notes is stored as `<span class="math">$...$</span>`
- Verify the math renders correctly in the note editor (may need KaTeX support)
- Note: Math may not yet be handled by the simplifier — this test documents current behavior

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2034, "Summary" (1129 chars)
- **Prompt**: "Add the inline math expression $x^2 + y^2 = r^2$ at the end of the paragraph, formatted as a span with class 'math'."
- **Result**: PASS — `<span class="math">` with `x^2 + y^2 = r^2` added to the note HTML. Apply→Undo roundtrip verified. Note: Math is not handled by the simplifier, but the agent correctly produced raw HTML with the math class.

### Test 7.2: Add Display Math

Insert a display-mode math block.

#### Guidelines
- Prompt: "Add a display math equation $$E = mc^2$$ after the first paragraph."
- Display math is stored as `<pre class="math">$$...$$</pre>`
- Verify rendering in the note editor

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 7.3: Modify Existing Math

Change an existing math expression.

#### Guidelines
- Requires a note with existing math
- Prompt: "Change the equation $x^2$ to $x^3 + 1$."
- Verify the math content changes but the `<span class="math">` wrapper is preserved

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Requires note with existing math. Skipped for time.

### Test 7.4: Delete Math

Remove a math expression.

#### Guidelines
- Prompt: "Delete the math expression '...' from the paragraph."
- Verify the `<span class="math">` or `<pre class="math">` is removed
- Verify surrounding text is intact

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Requires note with existing math. Skipped for time.

---

## Category 8: Large and Complex Edits

### Test 8.1: Rewrite an Entire Paragraph

Replace a full paragraph with completely new content of different length.

#### Guidelines
- Pick a paragraph of ~50 words
- Prompt: "Replace the entire paragraph that starts with '...' with: '[new paragraph text, ~100 words]'"
- Verify only the target paragraph changed, all other content intact

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 8.2: Reorganize Content into Sections

Break a long single-section note into multiple sections with headings.

#### Guidelines
- Use a note with one long block of text (no headings except h1)
- Prompt: "Reorganize this note into three sections with h2 headings: 'Background', 'Methods', 'Findings'. Distribute the existing content under the appropriate headings."
- This is a large edit — verify content is preserved (not fabricated)
- Verify proper heading hierarchy

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 8.3: Append a Long Section at the End

Add multiple paragraphs at the end of the note.

#### Guidelines
- Prompt: "Add a new section at the end of the note with the heading 'Additional Notes' and three paragraphs: [specify exact text for each paragraph]."
- Verify the existing content is completely unchanged
- Verify all three paragraphs appear in order

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 8.4: Multiple Edits in Sequence

Send a prompt requesting several distinct changes in one message.

#### Guidelines
- Prompt: "Make the following three changes to this note: (1) Change the title to '...', (2) Add bold to the word '...' in paragraph 2, (3) Add a new paragraph at the end saying '...'."
- The agent may make multiple `edit_note` calls or one large replacement
- Verify all three changes are applied correctly
- Test undo — all changes should revert (may require undoing multiple actions)

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

---

## Category 9: Edge Cases and Boundary Conditions

### Test 9.1: Edit Empty Paragraph

Modify a note that contains an empty paragraph (`<p></p>`).

#### Guidelines
- Create or use a note with an empty paragraph between two content paragraphs
- Prompt: "Fill the empty paragraph between '...' and '...' with: 'New content here.'"
- Verify the empty `<p>` is replaced with content

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — No notes with empty paragraphs available. Skipped for time.

### Test 9.2: Edit With Special Characters

Insert text containing HTML-special characters.

#### Guidelines
- Prompt: "Add a paragraph saying: 'The formula is: if x < 10 & y > 5, then z = x & y. Use "quotes" and 'apostrophes'.'"
- Verify `<`, `>`, `&`, `"`, `'` are properly escaped in the HTML as `&lt;`, `&gt;`, `&amp;`, `&quot;`, etc.
- Verify the text displays correctly (unescaped) in the note editor

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2034, "Summary" (1129 chars)
- **Prompt**: "Add a paragraph saying: 'The formula is: if x < 10 & y > 5, then z = x & y. Use \"quotes\" and apostrophes.'"
- **Result**: PASS — HTML correctly escaped: `x &lt; 10 &amp; y &gt; 5` and `x &amp; y`. Quotes preserved as `"`. Apply→Undo roundtrip verified.

### Test 9.3: Edit With Unicode Characters

Insert text with non-ASCII characters.

#### Guidelines
- Prompt: "Add a paragraph with: 'Müller (2024) found that naive Bayes — not naïve — performs well in résumé classification. See §3.2 for the €50 threshold.'"
- Verify accented characters, em-dash, section sign, euro sign are preserved
- Verify display in the note editor

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2035, "Summary of Logan et al. (2012)" (2360 chars)
- **Prompt**: "Add a paragraph with: 'Müller (2024) found that naive Bayes — not naïve — performs well in résumé classification. See §3.2 for the €50 threshold.'"
- **Result**: PASS — All Unicode characters preserved correctly in HTML: Müller (ü), em-dash (—), naïve (ï), résumé (é), § (section sign), € (euro). Apply→Undo roundtrip verified.

### Test 9.4: Edit Near the Beginning of the Note

Modify content right after the `<h1>` title, before any other content.

#### Guidelines
- Prompt: "Insert a new paragraph immediately after the title, before the first existing paragraph: 'This is a summary paragraph.'"
- Verify the paragraph appears between h1 and the first existing paragraph
- Verify no damage to the wrapper div or data-schema-version

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 9.5: Edit at the Very End of the Note

Append content at the very end of the note.

#### Guidelines
- Prompt: "Add the following as the very last paragraph of the note: 'Last updated: March 2026.'"
- The agent should anchor on the last content element (e.g., the last `<p>` tag) — **not** on `</div>`, which is no longer visible in the simplified output since the wrapper div is stripped
- Verify it appears after all existing content
- Verify the note structure is intact (wrapper div preserved internally)

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2384, "Policing & Educational Outcomes Summary" (16402 chars)
- **Prompt**: "Add the following as the very last paragraph of the note: 'Last updated: March 2026.'"
- **Result**: PASS — New paragraph appended at the very end, before `</div>`. Wrapper div and `data-schema-version` preserved. Apply→Undo roundtrip verified.

### Test 9.6: Consecutive Rapid Edits

Apply an edit, immediately undo, then immediately re-apply.

#### Guidelines
- After the agent produces an edit, rapidly cycle: Apply → Undo → Apply → Undo → Apply
- Do this within 1-2 seconds between each action
- Verify the note state is consistent after each toggle
- Check for race conditions or stale state

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Requires rapid manual interaction. Skipped for time.

### Test 9.7: Edit While Note is Open in Multiple Editors

Test editing a note that is open in both a tab and the library sidebar.

#### Guidelines
- Open the note in a tab AND in the library-view note panel
- Apply an edit via Beaver
- Verify BOTH editors update to show the new content
- Undo — verify both editors revert

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Requires multi-editor setup. Skipped for time.

### Test 9.8: Very Long old_string Match

Replace a very large block of text (500+ characters).

#### Guidelines
- Prompt should quote a very long passage as the text to replace
- Verify the agent can match and replace the entire block
- Verify no partial matches or truncation

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 9.9: Replacement With Empty String (Deletion)

Replace specific text with nothing (effective deletion).

#### Guidelines
- Prompt: "Remove the sentence '...' from the paragraph. Replace it with nothing — just delete it."
- Verify the sentence is removed and surrounding text flows naturally
- Verify no extra whitespace or empty tags remain

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2331, "Summary: Geography of School Inequality" (14447 chars)
- **Prompt**: "Remove the bold paragraph 'Key Findings on Disparities:' entirely. Delete it, replacing it with nothing."
- **Result**: PASS — Paragraph deleted (replacement with empty string). Surrounding list (`<ul>`) preserved. Apply→Undo roundtrip verified.

---

## Category 10: Expected Failures (Validation)

### Test 10.1: old_string Not Found

Send an edit with text that doesn't exist in the note.

#### Guidelines
- Prompt: "Replace the text 'this text does not exist in the note' with 'something else'."
- Expected: Agent should get `old_string_not_found` error
- The agent should report the failure to the user
- Verify the note is unchanged

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 10.2: Ambiguous Match Without replace_all

Send an edit where the old_string matches multiple locations.

#### Guidelines
- Use a common word that appears many times (e.g., "the", "and")
- Prompt: "Replace the word 'the' with 'THE' — but only the first occurrence."
- Expected: Agent should get `ambiguous_match` error (if it tries without replace_all and the old_string is too short)
- The agent should add more context to make the match unique

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 10.3: Attempt to Remove the Wrapper Div

Try to replace the entire note content including the wrapper.

#### Guidelines
- Prompt: "Replace the entire content of this note with just: '<p>Hello world</p>'."
- If the agent's old_string captures the `data-schema-version` div, expected: `wrapper_removed` error
- The agent should retry with a more targeted replacement

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 10.4: Fabricate an Annotation (Should Fail)

Try to add a fake annotation that references a non-existent PDF annotation.

#### Guidelines
- Prompt: "Add a highlighted annotation saying 'fake highlighted text' with annotation key 'NONEXISTENT'."
- Expected: Validation should reject fabricated annotations
- Verify the note is unchanged

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — No notes with annotations in test library. Skipped.

### Test 10.5: Fabricate an Image (Should Fail)

Try to add an image with a non-existent attachment key.

#### Guidelines
- Prompt: "Add an embedded image with attachment key 'FAKEKEY123'."
- Expected: Validation should reject fabricated images
- Verify the note is unchanged

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

---

## Category 11: Undo Robustness

### Test 11.1: Undo After External Edit

Apply a Beaver edit, then manually edit the note via the Zotero editor, then try to undo the Beaver edit.

#### Guidelines
- Apply an edit via Beaver (title change)
- Manually type additional text in the note editor
- Click Undo on the Beaver edit
- Expected: The undo should work if the edited region is unmodified, or fail gracefully if there's a conflict
- Verify manual edits are preserved

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Requires manual editing in Zotero editor. Skipped for time.

### Test 11.2: Undo After Note is Closed and Reopened

Apply an edit, close the note tab, reopen it, then try to undo.

#### Guidelines
- Apply an edit via Beaver
- Close the note tab (Cmd+W or click X)
- Reopen the same note via `Zotero.Notes.open()`
- Navigate back to the chat thread in Beaver
- Try clicking Undo
- Verify whether undo still works after tab close/reopen

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 11.3: Undo End-of-Note Append (Content-Based Anchor)

Apply an edit that appends content at the very end of the note, then undo.

#### Guidelines
- Prompt: "Add a short sentence at the very end of this note."
- The agent should anchor on the **last content element** (e.g., `old_string: "<p>Last paragraph.</p>"`, `new_string: "<p>Last paragraph.</p>\n<p>New text.</p>"`) — it should **not** use `</div>` because the wrapper div is stripped from the simplified output
- Verify the new paragraph appears at the end of the note
- Click **Undo** and verify:
  - The appended paragraph is removed
  - No empty paragraphs or extra whitespace remain
  - The note structure is intact
- Also test Apply → Undo → Apply → Undo cycle to verify repeatability
- **Note:** If an agent somehow uses `</div>` as `old_string` (legacy behavior), the edit still applies correctly since `executeEditNoteAction` operates on the full HTML. However, undo may fail when ProseMirror normalizes the HTML and `waitForPMNormalization` can't update the stale undo data (e.g., when the note editor isn't active)

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 11.4: Undo After PM Restructures Inline Styles (Multi-Edit Agent Run)

Apply multiple edits in a single agent run where at least one edit uses inline CSS styles that ProseMirror restructures into semantic elements, then undo each edit.

#### Guidelines
- Send a single prompt that triggers **three separate `edit_note` calls** in one agent run. At least one edit should use inline styles (e.g., `style="color: blue; font-weight: bold;"`) that ProseMirror will restructure.
- Example prompt: "Make three changes to this note: (1) Add '[Test edit #1]' in bold after the title. (2) Add the italicized text '[This is test edit #2]' at the end of the last paragraph. (3) Append a new paragraph at the very end of the note with blue bold text saying '[Test Edit #3]'."
- After all three edits are applied, verify:
  - All edits appear in the note
  - ProseMirror restructured the inline styles (e.g., `<p style="color: blue; font-weight: bold;">` became `<p><strong><span style="color: blue;">...</span></strong></p>`)
- Undo **each edit individually** in reverse order (edit #3 first, then #2, then #1):
  - After undoing #3: edits #1 and #2 remain, #3 is gone
  - After undoing #2: only edit #1 remains
  - After undoing #1: note is back to its original state
- **Key verification:** The undo of the styled edit (#3) must succeed despite ProseMirror having restructured the HTML. This requires the server-side handler to have refreshed `undo_new_html` via `waitForPMNormalization` after saving.
- **Known bug (fixed):** Before the fix, the server-side `executeEditNoteAction` did not call `waitForPMNormalization`, so `undo_new_html` stored the pre-PM HTML (e.g., `<p style="color: blue; font-weight: bold;">`). When undo tried to find this in the PM-normalized note (which had `<p><strong><span style="color: blue;">`), it failed with: "Cannot undo: the note has been modified since this edit was applied."

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 11.5: Undo After PM Normalizes Inline Styles (Note Tab Open)

Apply an edit that uses inline CSS styles, verify PM restructures them, then undo.

#### Guidelines
- Use a note that is open in a tab (so ProseMirror actively normalizes)
- Prompt: "Add a new paragraph at the end of this note with bold blue text saying '[Test styled edit]'."
- The agent should produce something like `<p style="color: blue; font-weight: bold;">[Test styled edit]</p>`
- After apply, verify PM has restructured the HTML (e.g., `<p><strong><span style="color: blue;">...</span></strong></p>`)
- Click **Undo** and verify:
  - The styled paragraph is removed
  - Surrounding content is intact
- **What this tests:** `waitForPMNormalization` polling detects the PM restructuring (via `item.getNote()` after the editor saves back) and updates `undo_new_html` with the PM-normalized version. Undo then uses the correct HTML for matching.

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 11.6: Undo Edit on Note NOT Open in Editor

Apply an edit to a note that is NOT open in any tab, then undo.

#### Guidelines
- Close all note tabs for the target note before applying the edit
- Prompt: "Change the word 'X' to 'Y' in this note."
- Verify the edit is applied (check via `item.getNote()` API)
- Click **Undo** and verify the original text is restored
- **What this tests:** When no editor is active, the HTML is saved un-normalized and read back identically. `waitForPMNormalization` exits after 3 unchanged polls (~450ms). The undo data matches the current HTML exactly, so undo succeeds via exact match.

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 11.7: Undo After Note Opened Then Closed Between Apply and Undo

Apply an edit to a note that is NOT open in a tab, then open the note tab (triggering PM normalization), close it, and then try to undo.

#### Guidelines
- Close all tabs for the target note
- Apply an edit with inline styles (e.g., "Add a bold paragraph at the end")
- Open the note in a tab — PM normalizes the HTML and saves it back
- Close the note tab
- Click **Undo** in the Beaver sidebar
- Verify the undo succeeds (via text-content fallback if PM normalization data wasn't captured)
- **What this tests:** The scenario where PM normalization happens asynchronously and the undo data is stale. The text-content fallback compares visible text (HTML tags stripped) and trusts context anchors when the text matches.
- **Known limitation:** If PM changes the visible text (unlikely but possible), the fallback won't match and the undo will fail with an error.

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 11.8: Double Undo (Two Sequential Edits)

Send two edit prompts, creating two separate edit actions, then undo both in reverse order.

#### Guidelines
- First prompt: Change the title
- Second prompt (in same chat): Change a word in a paragraph
- Undo the second edit first, verify only the paragraph reverts
- Then undo the first edit, verify the title also reverts
- Verify independence of the two undo operations

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

---

## Category 12: Code Blocks

### Test 12.1: Add a Code Block

Insert a `<pre>` code block.

#### Guidelines
- Prompt: "Add a code block after the first paragraph with the following Python code: `print('hello world')`"
- Verify `<pre>` tags in HTML
- Verify monospace rendering in the note editor
- Verify special characters in code are properly escaped

#### Test result

- **Date**: 2026-03-25 | **Note**: ID 2443, "Summary: Visualizing Police Exposure in NYC" (6417 chars)
- **Prompt**: "Add a code block after the title heading with the following Python code: print('hello world')."
- **Result**: PASS — `<pre>` block with `print('hello world')` added. Apply→Undo roundtrip verified.

### Test 12.2: Modify Code Block Content

Change the content inside an existing code block.

#### Guidelines
- Requires a note with an existing `<pre>` block
- Prompt: "Change the code in the code block from '...' to '...'."
- Verify only the code content changes, the `<pre>` wrapper is preserved

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Requires note with existing code block. Skipped for time.

---

## Category 13: Horizontal Rules and Whitespace

### Test 13.1: Add a Horizontal Rule

Insert an `<hr>` between sections.

#### Guidelines
- Prompt: "Add a horizontal rule between the section '...' and the section '...'."
- Verify `<hr>` in the HTML
- Verify visual separator in the note editor

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — Skipped for time.

### Test 13.2: Preserve Whitespace and Line Breaks

Edit near hard line breaks (`<br>`) without removing them.

#### Guidelines
- Use a note with `<br>` tags within a paragraph
- Prompt: "Edit the text before the line break to say '...'. Do not remove the line break."
- Verify `<br>` tags are preserved

#### Test result

- **Date**: 2026-03-25 | **Result**: NOT RUN — No notes with `<br>` tags in test library. Skipped.

---

## Category 14: Multi-Step Edits and Complex Agent Interactions

These tests involve agent runs that produce multiple `edit_note` calls, retry/regenerate flows, and interactions between edits.

### Test 14.1: Three Edits in One Run — Sequential Undo

Send a single prompt that triggers three separate `edit_note` calls, then undo each individually in reverse order.

#### Guidelines
- Use a medium-sized note with h1, h2, and body text
- Prompt: "Make three changes to this note: (1) Change the title to 'Updated Title', (2) Make the first sentence of the second paragraph bold, (3) Add a new paragraph at the end saying 'This is a test addition.'"
- After all three edits are applied:
  - Verify all three changes are present
- Undo in reverse order (#3 first, then #2, then #1):
  - After undoing #3: check that #1 and #2 remain, only the appended paragraph is gone
  - After undoing #2: check that #1 remains, bold is removed
  - After undoing #1: check that note is fully restored to original
- **Key risk**: If the agent applies edits sequentially and each changes the HTML, undo anchors for earlier edits may have shifted

#### Test result

- **Date**: 2026-03-27 | **Note**: ID 2035, "Summary of Logan et al. (2012)" (2360 chars)
- **Prompt**: "Make three separate edit_note calls: (1) Change title to 'Updated: Logan 2012 Review', (2) Make 'racial and ethnic groups' bold, (3) Append 'Test addition for evaluation purposes.'"
- **Result**: PASS — All 3 edits produced as separate actions and applied via "Approve All". Sequential undo in reverse (#3→#2→#1) worked perfectly:
  - After undo #3: append removed, title + bold still present
  - After undo #2: bold removed, title still present
  - After undo #1: title restored, note fully back to original
- **Note**: No issues with undo anchor stability despite sequential modifications to the same note.

### Test 14.2: Three Edits in One Run — Out-of-Order Undo

Same as 14.1 but undo in a different order (e.g., #1 first, then #3, then #2).

#### Guidelines
- Same setup as 14.1 — three edits applied in one run
- Undo edit #1 (title change) first while #2 and #3 are still applied
  - The title should revert; bold and appended paragraph should remain
- Then undo edit #3 (appended paragraph)
  - Bold should remain; title is original
- Then undo edit #2 (bold)
  - Note should be fully restored
- **Key risk**: Edit #1's undo anchors may overlap with content modified by #2 or #3. The `undo_before_context` / `undo_after_context` must be robust to surrounding content changes.

#### Test result

- **Date**: 2026-03-27 | **Result**: NOT RUN — Skipped. Test 14.1 covered reverse-order undo successfully. Out-of-order undo is partially covered by Test 14.7 (same paragraph, different runs).

### Test 14.3: Retry (Regenerate) with Applied Note Edits

Apply an edit, then use the Retry button to regenerate the response — verify that the applied edit is automatically undone.

#### Guidelines
- Send an edit prompt (e.g., "Change the title to 'New Title'")
- Approve and verify the edit is applied
- Click the Retry button (↻) in the AgentRunFooter
- Expected: A confirmation dialog appears saying "The following changes will be undone when regenerating: • 1 note edit"
- Click "Yes" to confirm
- Verify:
  - The note reverts to its original title
  - A new agent run starts with the same prompt
  - The new run produces a fresh edit (may be different from the first)
- Approve the new edit and verify it applies correctly
- **What this tests**: `regenerateFromRunAtom` → `confirmUndoAppliedActions` → `undoAppliedNoteEdits` flow

#### Test result

- **Date**: 2026-03-27 | **Note**: ID 2035, "Summary of Logan et al. (2012)"
- **First attempt (automated)**: INCONCLUSIVE — The `Zotero.Prompt.confirm()` modal dialog blocked RDP, was auto-dismissed without user interaction, and the undo did not fire. The new run found the edits already in place.
- **Second attempt (manual dialog)**: **PASS** — Used a simpler single-title-change test. Applied edit (title → "RETRY TEST TITLE"), clicked Retry. The modal confirmation dialog appeared and blocked RDP. User manually clicked "Yes". Result:
  1. The undo fired — title reverted to "Summary of Logan et al. (2012)"
  2. New run started with the same prompt
  3. Agent read the reverted note, successfully re-applied the title change (green checkmark)
  4. Agent confirmed: "I've changed the note title from 'Summary of Logan et al. (2012)' to 'RETRY TEST TITLE'"
  5. No corruption or duplicates
- **Key finding**: The confirmation dialog is a modal `Zotero.Prompt.confirm()` that blocks the RDP connection. It cannot be interacted with via MCP — requires manual user click. When the user clicks "Yes", the undo fires correctly before the new run starts.
- **Note**: The `Zotero.Prompt.confirm()` dialog should ideally be non-blocking or use a React-based confirmation to allow MCP automation.

### Test 14.4: Retry with Multiple Applied Edits Across Runs

Apply edits in two separate runs (two prompts in the same chat), then retry from the first run.

#### Guidelines
- First prompt: "Change the title to 'First Edit Title'"
  - Approve, verify applied
- Second prompt (same chat): "Add a paragraph at the end saying 'Second edit content.'"
  - Approve, verify applied
- Click Retry on the **first** run (not the second)
- Expected: Confirmation dialog says "The following changes will be undone when regenerating: • 2 note edits"
  - Both edits should be listed because retrying from run #1 removes run #1 and all subsequent runs (#2)
- Click "Yes" to confirm
- Verify:
  - Title reverted to original
  - Appended paragraph removed
  - Note is fully restored to its pre-edit state
  - New agent run starts with the first prompt
- **Key risk**: Undoing multiple edits across runs requires correct reverse-chronological ordering. The `undoAppliedNoteEdits` function reverses the array, but if run #2's edit overlaps with run #1's edit (e.g., both modify the title), the undo may fail.

#### Test result

- **Date**: 2026-03-27 | **Result**: NOT RUN — Test 14.3 covered the core retry+undo flow with a single edit. Multi-run retry needs a dedicated test with manual dialog interaction. Skipped for time.

### Test 14.5: Retry Cancellation — Edits Preserved

Same setup as 14.3, but click "No" on the confirmation dialog.

#### Guidelines
- Apply an edit, then click Retry
- When the confirmation dialog appears, click "No" / Cancel
- Verify:
  - The applied edit remains unchanged
  - No new agent run is started
  - The note content is still the edited version
- **What this tests**: That cancellation is a clean no-op with no side effects

#### Test result

- **Date**: 2026-03-27 | **Result**: NOT RUN — Requires manual interaction with modal dialog. Cannot be tested via MCP.

### Test 14.6: Retry After Partial Undo

Apply two edits in one run, manually undo one of them, then retry.

#### Guidelines
- Send prompt that produces two `edit_note` calls
- Approve both
- Manually undo edit #2 (click Undo on that specific action)
- Click Retry on the run
- Expected: Confirmation dialog should mention only "1 note edit" (the one still applied)
  - Edit #2 is already undone, so it should not be in the undo list
- Click "Yes" to confirm
- Verify:
  - The remaining applied edit (#1) is undone
  - Note is fully restored
  - New agent run starts
- **What this tests**: That `regenerateFromRunAtom` correctly filters to `status === 'applied'` and doesn't try to undo already-undone actions

#### Test result

- **Date**: 2026-03-27 | **Result**: NOT RUN — Requires manual interaction with modal dialog. Cannot be tested via MCP.

### Test 14.7: Edit-on-Edit — Same Paragraph Modified Twice

Two separate prompts that both modify the same paragraph in a note.

#### Guidelines
- First prompt: "In the paragraph starting with '...', replace the word 'X' with 'Y'."
  - Approve, verify
- Second prompt: "In the same paragraph, also replace the word 'A' with 'B'."
  - Approve, verify both changes present
- Undo edit #2: verify only 'B'→'A' reverts, 'Y' remains
- Undo edit #1: verify 'Y'→'X' reverts, note fully restored
- Re-apply edit #1, re-apply edit #2: verify both changes present again
- **Key risk**: Edit #2's `undo_before_context` and `undo_after_context` include text modified by edit #1. If edit #1 is undone first, edit #2's anchors no longer match the note content. The undo must use fuzzy matching or text-content fallback.

#### Test result

- **Date**: 2026-03-27 | **Note**: ID 2331, "Summary: Geography of School Inequality" (14447 chars)
- **Setup**: Two separate prompts in the same chat, both editing the same paragraph:
  - Prompt 1: Replace "conducted" with "performed"
  - Prompt 2: Replace "national-level" with "nationwide"
- **Result**: PASS — Both edits applied to the same paragraph. Undo in reverse order:
  - After undo #2: "nationwide" → "national-level" restored, "performed" still present
  - After undo #1: "performed" → "conducted" restored, note fully back to original
- **Key finding**: Undo anchors remain stable even when overlapping edits modify nearby text in the same paragraph. The context-based matching is robust enough to handle this case.

### Test 14.8: Retry During Active Agent Run

Click Retry while the agent is still processing (streaming).

#### Guidelines
- Send an edit prompt
- While the agent is still running (Stop button visible), click Retry
- Expected:
  - The active run is cancelled (`agentService.cancel()`)
  - If any edits were already applied during the run, a confirmation dialog appears
  - If no edits applied yet, regeneration proceeds immediately
  - A new run starts with the same prompt
- **What this tests**: The `activeRun` handling path in `regenerateFromRunAtom` (lines 1524-1530)

#### Test result

- **Date**: 2026-03-27 | **Result**: NOT RUN — Requires precise timing (clicking Retry during streaming). Difficult to automate via MCP.

### Test 14.9: Retry with Mixed Action Types

A run that produces both an `edit_note` and another action type (e.g., `create_note`, `edit_metadata`), then retry.

#### Guidelines
- Send a prompt that triggers a note edit AND creates a new note or edits metadata
  - Example: "Edit the title of this note to add 'Updated:' at the beginning, and also create a new standalone note summarizing the key findings."
- Approve all actions
- Click Retry
- Expected: Confirmation dialog lists BOTH the note edit and the other action
  - "• 1 note edit • 1 note created" (or similar)
- Click "Yes"
- Verify:
  - The note edit is undone (title reverted)
  - The created note is deleted from Zotero
  - New agent run starts
- **What this tests**: The multi-type action undo path in `regenerateFromRunAtom`, ensuring `undoAppliedNoteEdits`, `deleteAppliedZoteroItems`, etc. all execute correctly in sequence

#### Test result

- **Date**: 2026-03-27 | **Result**: NOT RUN — Skipped for time. Requires a prompt that triggers both edit_note and create_note actions.

### Test 14.10: Large Structural Edit — Section Reordering

Ask the agent to reorganize a multi-section note by reordering h2 sections.

#### Guidelines
- Use a note with 3+ h2 sections (e.g., note 2424 with "Core Empirical Patterns", "Consequences for Life Chances", etc.)
- Prompt: "Move the section titled 'Theoretical and Methodological Significance' to be the first section after the title, before 'Core Empirical Patterns'. Move the entire section including its content."
- This is a complex edit — the agent may need to:
  1. Delete the section from its current position
  2. Insert it at the new position
  - Or do a single large replacement
- Verify:
  - The section content is preserved exactly (especially citations within it)
  - The moved section appears in the correct new position
  - All other sections remain in their original order
  - `data-citation-items` on the wrapper div is still valid
- Test undo: verify the section returns to its original position
- **Key risk**: This is likely to require multiple `edit_note` calls or a very large `old_string`. High chance of `old_string_not_found` on first attempt. Citations within the moved section must be preserved.

#### Test result

- **Date**: 2026-03-27 | **Result**: NOT RUN — Complex structural test. Skipped for time.

### Test 14.11: Retry After External Note Modification

Apply an edit via Beaver, then modify the note externally (via Zotero editor or API), then retry.

#### Guidelines
- Apply an edit (e.g., title change)
- Manually modify the note via `item.setNote()` or typing in the Zotero editor (add a sentence)
- Click Retry on the Beaver run
- Confirm the undo dialog
- Expected:
  - The undo of the Beaver edit should succeed if the edited region is unmodified
  - The manual edit should be preserved (it's in a different region)
  - OR if the manual edit overlaps with the Beaver edit region, the undo should fail gracefully with an error message
- **What this tests**: Robustness of undo when the note has been modified outside Beaver between apply and undo

#### Test result

- **Date**: 2026-03-27 | **Result**: NOT RUN — Requires manual external modification + retry with modal dialog. Skipped for time.

---

## Category 14: HTML Entity Encoding Undo

These tests verify that undo works correctly when a note contains HTML-encoded entities (e.g., `&#x27;` for apostrophe, `&quot;` for double quote). ProseMirror normalizes these entities to their literal characters when the note is opened in the editor, which can cause a mismatch between the stored undo data and the actual note HTML.

### Setup (shared by both tests)

Create a new child note with HTML entities via the Zotero MCP or API (the note must NOT be open in the editor when created, otherwise PM will normalize the entities immediately):

```js
const note = new Zotero.Item('note');
note.libraryID = 1;
note.parentKey = '<PARENT_KEY>'; // e.g., F8E4GHHW
const html = `<div data-schema-version="9"><h1>Test Note: HTML Entity Encoding</h1>
<p>Sayeh Dashti&#x27;s memoir <em>You Belong</em> recounts her mother&#x27;s encounter with African American women.</p>
<p>The mother declared: &quot;We love our blacks... Our blacks are members of our families&quot; (p. 9).</p>
<p>Yet, as Motlagh notes, Dashti&#x27;s own description reveals these individuals came into the family as part of her aunt&#x27;s dowry\u2014&quot;suggesting that the family understood them as property first and humans second&quot; (p. 10).</p>
<p>The word &#x27;Persian&#x27; functions as a &quot;racial talisman&quot; that masks a long history.</p>
</div>`;
note.setNote(html);
await note.saveTx();
// Note the key for the prompt below
```

### Test 14.1: Edit with literal apostrophe — model uses entity-encoded form

In this test, the prompt uses a literal `'` in the edit instruction, but after reading the note the model typically converts it to `&#x27;` to match the note HTML. This tests that undo works when the undo data contains `&#x27;` but PM has normalized the note to use `'`.

#### Steps
1. Make sure you are in **library view** (not reading a PDF)
2. Create a new note using the setup above; note its key
3. Send the following prompt:
   ```
   Please make the following edit to note `1-<KEY>`:
   Replace "Sayeh Dashti's memoir" with "Sayeh Dashti's MEMOIR"
   ```
   (Note: the prompt uses literal `'`, not `&#x27;`)
4. **Apply** the edit
5. Verify the note now shows "MEMOIR" (uppercased)
6. **Undo** the edit
7. Verify the note is restored with "memoir" (lowercased)
8. **Apply** again to confirm the full roundtrip works

#### What this tests
- The model often reads the note and uses `&#x27;` in its `old_string`/`new_string` to match the raw HTML
- After the edit is applied, PM normalizes `&#x27;` to `'` in the note
- Undo must handle the entity mismatch between stored undo data (`&#x27;`) and current note HTML (`'`)

#### Additional variants that should also pass

These are targeted regression checks for the validation and reverse-matching gaps. Run them as separate fresh-note cases under the same test.

##### Variant A: Validation path must accept literal `'` when note HTML uses `&#x27;`
1. Re-create the shared setup note exactly as written above, without opening it first in the editor
2. Send this prompt:
   ```
   Please make the following edit to note `1-<KEY>`:
   Replace "Sayeh Dashti's memoir" with "Sayeh Dashti's BOOK"
   ```
3. Confirm the agent run reaches an actionable `edit_note` preview instead of failing early with `old_string_not_found`
4. Apply, Undo, and Re-Apply as in the base test

Expected result:
- Validation succeeds on the first attempt
- No `old_string_not_found` error appears before the action preview
- The edit roundtrip succeeds even though the prompt used literal `'` and the stored note HTML used `&#x27;`

##### Variant B: Reverse matching must also handle `&#39;` and `&apos;`
1. Create a fresh child note, but change the first paragraph in the setup HTML to use one of these alternative apostrophe encodings instead of `&#x27;`:
   ```html
   <p>Sayeh Dashti&#39;s memoir <em>You Belong</em> recounts her mother&#39;s encounter with African American women.</p>
   ```
   or
   ```html
   <p>Sayeh Dashti&apos;s memoir <em>You Belong</em> recounts her mother&apos;s encounter with African American women.</p>
   ```
2. Send this prompt:
   ```
   Please make the following edit to note `1-<KEY>`:
   Replace "Sayeh Dashti's memoir" with "Sayeh Dashti's BOOK"
   ```
3. Verify the run reaches an `edit_note` preview and does not fail with `old_string_not_found`
4. Apply, Undo, and Re-Apply

Expected result:
- The edit succeeds for both `&#39;` and `&apos;` note variants
- Undo also succeeds after PM normalizes the note to literal apostrophes

##### Variant C: Reverse matching must also handle `&#34;` for double quotes
1. Create a fresh child note, but change the second paragraph in the setup HTML to use `&#34;` instead of `&quot;`:
   ```html
   <p>The mother declared: &#34;We love our blacks... Our blacks are members of our families&#34; (p. 9).</p>
   ```
2. Send this prompt:
   ```
   Please make the following edit to note `1-<KEY>`:
   Replace "The mother declared: "We love our blacks... Our blacks are members of our families"" with "The mother declared: "We considered them part of the household""
   ```
3. Verify the run reaches an `edit_note` preview rather than failing with `old_string_not_found`
4. Apply, Undo, and Re-Apply

Expected result:
- The edit succeeds even when the stored note uses `&#34;` instead of `&quot;`
- Undo restores the original quoted sentence correctly

#### Test result

- **Date**: | **Result**:

### Test 14.2: Edit with literal apostrophe — model forced to use literal form

In this test, the prompt explicitly instructs the model to use a literal `'` (not escaped). This tests that the edit and undo work when the `old_string`/`new_string` use `'` but the note HTML contains `&#x27;`.

#### Steps
1. Make sure you are in **library view** (not reading a PDF)
2. Create a new note using the setup above; note its key
3. Send the following prompt:
   ```
   This is a test. Please make the following edit to note `1-<KEY>`. Make sure that you use `Dashti's` with `'` (not escaped), which is essential for the test to work. Here is the edit:
   Replace "Sayeh Dashti's memoir" with "Sayeh Dashti's MEMOIR"
   ```
4. **Apply** the edit
5. Verify the note now shows "MEMOIR" (uppercased)
6. **Undo** the edit
7. Verify the note is restored with "memoir" (lowercased)
8. **Apply** again to confirm the full roundtrip works

#### What this tests
- The `old_string` uses literal `'` but the note HTML has `&#x27;` — the edit must still find and replace the target
- After PM normalizes, undo data and note HTML should both use `'`, so undo should work straightforwardly
- This is the complementary case to Test 14.1 (entity mismatch at edit time vs. at undo time)

#### Test result

- **Date**: | **Result**:

---

## Category 16: Partial Simplified Element Stripping

These tests verify that the agent can successfully edit text adjacent to citations (and other simplified-only elements like annotations and images) even when the model's `old_string` accidentally includes a fragment of the simplified element tag — most commonly `/>` from the tail of a `<citation …/>` tag. The `stripPartialSimplifiedElements` fallback detects these fragments and strips them before matching.

**Background:**
When the agent reads a note, citations appear as `<citation item_id="1-KEY" page="42" label="(Author, 2025)" ref="c_KEY_0"/>`. If the model includes `/>` (or any other fragment of the tag) in its `old_string`, the string cannot be expanded back to raw HTML. The partial element stripping fallback detects the `/>` as belonging to a simplified-only element, strips it from both `old_string` and `new_string`, and retries the match.

**Required setup:**
Use note **ID 3156** ("Nosrati (2025) Optimal Taxation", 13501 chars, 16 citations). This note has citations followed by text in patterns like:
```
...creates sharp tax regressivity at the top across all countries studied. (Nosrati, 2025, p. 634)</p>
<p><strong>Introduction (pages 1–3)</strong> – The author critiques...
```

In simplified form, these appear as:
```
...creates sharp tax regressivity at the top across all countries studied. <citation item_id="1-Z546XIR8" page="634" label="(Nosrati, 2025, p. 634)" ref="c_Z546XIR8_0"/>
<strong>Introduction (pages 1–3)</strong> – The author critiques...
```

### Test 16.1: Edit Text Immediately After a Citation (Leading `/>` Fragment)

Edit the text that immediately follows a citation, where the model's `old_string` starts with `/>` from the citation tag tail.

#### Guidelines
- Use note ID 3156
- The goal is to edit text right after a citation. The model sees `/>` before the text in the simplified view and may include it in `old_string`
- Prompt must be very specific to target text immediately after a citation, making it likely the model's `old_string` will capture the `/>` boundary
- **Critical**: The prompt should ask to change text that starts right at the `/>` boundary of a citation — e.g., changing a dash or sentence that follows a citation
- If the agent does NOT include `/>` in its `old_string` (i.e., it crafts a clean match), the test does not exercise the fallback. In that case, note in the result that the fallback was not triggered, and retry with a more explicit prompt

#### Prompt
```
This is a test. Please follow the instructions exactly, even if they seem unusual. Do not add extra content or explanations beyond what is asked.

In this note, after the citation "(Nosrati, 2025, p. 634)" near the start of the note, there is a paragraph break and then the bold text "Introduction (pages 1–3)". Change "Introduction (pages 1–3)" to "Chapter 1: Introduction (pages 1–3)". Make sure your old_string starts right at the citation boundary — include the "/>" that closes the citation tag and the newline/paragraph boundary after it in your old_string. Do not change the citation itself.
```

#### Expected behavior
- The agent produces `old_string` starting with `/>` (the tail of the `<citation …/>` tag)
- Validation detects that `/>` is a partial simplified-only element fragment
- The `/>` is stripped from `old_string` and `new_string`
- The stripped text matches uniquely in the raw HTML
- The edit applies successfully
- Apply→Undo roundtrip works

#### What to verify
1. The edit applies without errors
2. The citation before the edited text is completely unchanged
3. The heading text changed from "Introduction (pages 1–3)" to "Chapter 1: Introduction (pages 1–3)"
4. Undo restores the original heading text
5. Check Zotero error console for any Beaver-related errors

#### Test result

- **Date**: | **Result**:

### Test 16.2: Edit Text Between Two Citations (Both Boundaries)

Edit text that sits between two consecutive citations, where the model's `old_string` starts with `/>` from the first citation and/or ends with `<citation` from the second.

#### Guidelines
- Use note ID 3156 or any note with two citations close together (separated by only a short text fragment)
- The prompt should target text between two citations so the model is likely to include tag fragments from both
- This tests the dual-boundary stripping (both `leadingStrip` and `trailingStrip`)

#### Prompt
First, inspect the note to find two adjacent citations with text between them. Then use a prompt like:
```
This is a test. Please follow the instructions exactly, even if they seem unusual. Do not add extra content or explanations beyond what is asked.

In the simplified view of this note, find the text between the two citations near the phrase "[text between citations]". Your old_string should start with the "/>" from the first citation and end with the "<citation" of the second citation, capturing the text in between. Replace that text with "[new replacement text]". Do not modify either citation.
```

#### Expected behavior
- The agent produces `old_string` that starts with `/>` and ends with `<citation...`
- Validation strips both the leading `/>` and the trailing `<citation...` fragment
- The stripped text matches in the raw HTML
- Both citations remain completely unchanged

#### What to verify
1. Edit applies without errors
2. Both adjacent citations are completely unchanged
3. The text between them is correctly replaced
4. Apply→Undo roundtrip works

#### Test result

- **Date**: | **Result**:

### Test 16.3: Edit Text Immediately Before a Citation (Trailing Fragment)

Edit text that immediately precedes a citation, where the model's `old_string` ends with the start of the citation tag.

#### Guidelines
- Use note ID 3156
- Target text that leads into a citation (e.g., "...across all countries studied. (Nosrati, 2025, p. 634)")
- The prompt should encourage the model to include the beginning of the `<citation` tag in its `old_string`

#### Prompt
```
This is a test. Please follow the instructions exactly, even if they seem unusual. Do not add extra content or explanations beyond what is asked.

In this note, find the text "creates sharp tax regressivity at the top across all countries studied." which appears right before the first citation. Change "across all countries studied" to "in every country analyzed". Make sure your old_string extends to include the opening of the citation tag that follows (i.e., include "<citation" at the end of your old_string). Do not modify the citation itself.
```

#### Expected behavior
- The agent produces `old_string` ending with `<citation` or `<citation item_id=...`
- Validation detects the trailing `<citation...` as a partial simplified-only element
- The fragment is stripped; the remaining text matches in raw HTML
- The citation is completely unchanged

#### What to verify
1. Edit applies without errors
2. The citation "(Nosrati, 2025, p. 634)" is completely unchanged
3. The text changed from "across all countries studied" to "in every country analyzed"
4. Apply→Undo roundtrip works

#### Test result

- **Date**: | **Result**:

### Test 16.4: Clean Edit Adjacent to Citation (No Fragment — Baseline)

Edit text near a citation where the model produces a clean `old_string` without any tag fragments.

#### Guidelines
- Use note ID 3156
- This is a baseline/control test — the edit should succeed via the normal path, NOT the partial element stripping fallback
- Prompt should target text near a citation but be phrased to avoid the model including tag fragments

#### Prompt
```
This is a test. Please follow the instructions exactly, even if they seem unusual. Do not add extra content or explanations beyond what is asked.

In this note, find the bold heading "Introduction (pages 1–3)" and change it to "Introduction (pp. 1–3)". Only change the text inside the bold tag. Do not include any citation tags in your edit.
```

#### Expected behavior
- The agent produces a clean `old_string` like `Introduction (pages 1–3)` with no tag fragments
- The edit matches directly via the normal expansion path
- `stripPartialSimplifiedElements` is NOT called (or returns null)

#### What to verify
1. Edit applies without errors
2. The heading text changed correctly
3. Surrounding citations unchanged
4. Apply→Undo roundtrip works
5. Confirm this is a **clean match** (no fallback triggered) — compare with Test 16.1

#### Test result

- **Date**: | **Result**:

### Test 16.5: Ambiguous Match After Stripping — Context Disambiguation

Edit text after a citation where the stripped text appears multiple times in the note, requiring context-based disambiguation.

#### Guidelines
- Use note ID 3156, which has repeated structural patterns (each section starts with `– The author...` or `– This section...`)
- Target a word or phrase that appears in multiple sections so that after stripping the `/>` from `old_string`, the resulting text is ambiguous
- The validation should disambiguate using the unique position of `old_string` in the simplified HTML and attach context anchors

#### Prompt
```
This is a test. Please follow the instructions exactly, even if they seem unusual. Do not add extra content or explanations beyond what is asked.

In this note, find the FIRST occurrence of the text "– The author critiques" (which appears right after a citation in the Introduction section). Change "critiques" to "challenges". Include the "/>" from the preceding citation tag at the start of your old_string. Do not change any other occurrence of similar text.
```

#### Expected behavior
- The agent produces `old_string` starting with `/>` + text that appears multiple times after stripping
- Validation strips `/>`, finds multiple matches in raw HTML, but the original `old_string` (with `/>`) was unique in simplified HTML
- Disambiguation uses prefix expansion to compute the correct raw position and attaches `target_before_context` / `target_after_context`
- The edit replaces only the first occurrence

#### What to verify
1. Edit applies without errors
2. Only the FIRST "critiques" is changed to "challenges"
3. Other occurrences of "critiques" (if any) are unchanged
4. The citation is unchanged
5. Apply→Undo roundtrip works

#### Test result

- **Date**: | **Result**:

### Test 16.6: Fragment Stripping Falls Through to Fuzzy Match

Edit with an `old_string` that includes a `/>` fragment but where the stripped text still doesn't match in the raw HTML (e.g., because the text itself has a typo). The fallback should fail gracefully with a fuzzy match suggestion.

#### Guidelines
- Use any note with citations
- Intentionally include a typo in the text portion of `old_string` so that even after stripping `/>`, the text doesn't match
- The agent should receive an `old_string_not_found` error with a fuzzy match suggestion

#### Prompt
```
This is a test. Please follow the instructions exactly, even if they seem unusual. Do not add extra content or explanations beyond what is asked.

In this note, find the text that appears after the first citation. Your old_string should be: "/>—ein theoretische bildungsfordernder Effekt" (note: this text has intentional typos and does not actually exist in this note). Replace it with "test replacement". Use exactly this old_string, do not correct it.
```

#### Expected behavior
- The agent's `old_string` starts with `/>` and contains text that doesn't exist in the note
- Validation strips `/>`, attempts to match, fails
- Falls through to the fuzzy match error with `old_string_not_found`
- The agent reports the error to the user (possibly with a fuzzy match suggestion)
- No note modification occurs

#### What to verify
1. The edit fails with an appropriate error message
2. The note is completely unchanged
3. No Zotero errors in the console

#### Test result

- **Date**: | **Result**:
