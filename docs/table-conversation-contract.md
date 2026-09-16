# Table conversation contracts

Table content remains in the Zotero snapshot. Messages and tool results retain
compact observations; they never authorize a write or replace a fresh provider read.

## Attachments and cards

A message attachment is `{ type: "table", reference: { kind: "table", key, title } }`.
`key` is a portable Zotero item ID. The title records the observation at submission.
The provider validates explicit selections with a bounded `list` request before
submission. Removing a composer selection changes future submissions only.
The ordinary composer clears explicit selections after a successful submission.

A tool card uses `metadata.view = { view_type: "table", record }`; `record` mirrors
`TableRecord` in the backend, with `reference`, `change`, `summary`, `changes`,
`operation_id`, `version`, and `saved`. Its historical title and counts do not
change when the document changes. Current local metadata is displayed separately
and refreshed after item notifications and table writes. Opening always targets
the current snapshot reader. No full table spec enters the chat view.

`tables` is declared only by the Zotero identity provider in development builds.
The shared default feature list excludes it. Other chat clients must supply their
own table views before opting in; provider support alone is insufficient.

## Optional table batch approval

The optional `table` field on `batch_approval_request` is:

```json
{
    "reference": {
        "kind": "table",
        "key": "u-ABCDEFGH",
        "title": "Study comparison"
    },
    "schema_id": "opaque-schema-identity",
    "population_id": "opaque-population-identity",
    "population_count": 40,
    "columns": [{ "id": "design", "question": "What is the study design?" }],
    "cost_estimate": "8 credits"
}
```

The response echoes only `{ key, schema_id, population_id }` in `table`, together
with the existing decision fields. The backend must bind these identifiers to the
approved schema and frozen population, verify them before execution, and request a
new approval after a relevant change. The client does not derive either identity
from titles or counts. The table plan is read-only. Typed changes require canceling
and requesting a new plan. Requests without `table` preserve prose approval behavior.

This optional payload is a contract for the table batch producer. It does not
activate structured extraction or batch execution on its own.

## Outcomes

Table result bodies may expose `error_code` (or `status`) of `schema_changed`,
`confirmed_uncommitted`, `outcome_unknown`, `conflict`, or `provider_unavailable`.
`status: "partial"` and `rejected_count` describe partial completion.
`saved: false`/`repair_warning` describe committed content needing local repair;
`recording_warning` describes a confirmed outcome whose chat result could not be
saved. Neither warning changes the content outcome to failure. Unknown outcomes
require inspection, never automatic replacement creation or repeated extraction.

Conversation retry and turn deletion do not call table trim, revert, or delete.
Retained-version restore stays an explicit item-pane operation.
