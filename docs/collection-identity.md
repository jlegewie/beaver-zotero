# Collection identity and resolution

`src/services/collections/collectionIdentity.ts` is the React-free lookup boundary.
`resolveCollection` accepts portable IDs (`u-KEY`, `g12345-KEY`), legacy local
`libraryID-KEY` IDs, native `libraryID_KEY` search values, local numeric collection
IDs, bare keys, and case-insensitive exact names. Qualified references are terminal.
A bare key or name must identify one collection within the permitted scope.

`libraryID` is an explicit constraint. `libraryIds` restricts discovery, including
an empty scope. A default library never overrides a qualified reference or breaks
a key/name collision. Single-library searches and populations infer their library
from resolved collection references when no library is explicit; references spanning
multiple libraries fail. With no collection reference, the default library applies. Agent lookups intersect the scope with the instance account's
searchable libraries and exclude trash. An unready access snapshot resolves nothing.
`access: 'local'` is reserved for local history labels, never agent data or writes.

`resolveCollectionList` returns deduplicated identities, successful references in
input order, and typed failures. Discovery can retain partial success and report
unresolved inputs; ambiguity fails the request. Populations require every reference
to resolve before searching. Collection predicates preserve `is`/`isNot` and the
caller's joins and recursion; an invalid predicate fails instead of being dropped.

The compatibility helpers in `agentDataProvider/utils.ts` delegate to this boundary.
A supplied library in `getCollectionByIdOrName` is a constraint, not a preference.
It returns null only for a missing collection; other typed failures propagate.

## Additive wire contract

Existing request fields and native response keys retain their meanings. The
`collection_ids` capability additionally covers the mutation and client contracts
described below.

| Response | Additional fields |
| --- | --- |
| `list_collections.collections[]` | Optional `collection_id`, `parent_collection_id`; existing `library_id`, `library_ref`, `collection_key`, `parent_key`, names and counts remain |
| Full metadata collection memberships | `collection_id`, `library_ref`, optional `parent_collection_id`, alongside `collection_key` and `name` |
| `resolve_population` | Optional `collection_ids`, aligned with existing `collection_names` in request order, including repeated aliases |
| Metadata, topic and quick search | Optional `unresolved_collections` for partially resolved discovery filters |

For example, a group listing row can contain `collection_key: "ABCD2345"` and
`collection_id: "g12345-ABCD2345"`. The former is still a native key, and the latter
is portable across devices. Population `collection_keys` continues accepting scoped
bare keys, and also accepts qualified references matching its selected library.

Typed resolution errors use `collection_not_found`, `ambiguous_collection`,
`library_unavailable`, `library_collection_mismatch`, and `library_not_searchable`.
Ambiguity messages provide portable candidates with readable parent paths only
within the permitted scope. Missing portable mapping produces an availability error,
never a fabricated personal-library ID.

Model-facing output activation is controlled by the backend. The optional fields
above do not change the meaning of native execution or undo records.

Resolution failures identify the supplied reference and suggest a bounded retry:
rediscover a missing ID with `list_collections`, correct conflicting explicit library
scope, or issue separate single-library searches. A note's memberships must share
one intended library. Unavailable libraries require `list_libraries` discovery and,
when necessary, user action in Zotero. Access-loading errors recommend retrying the
same request after initialization. Errors never suggest stripping qualification or
removing a narrowing condition to obtain results, and do not expose excluded names,
paths, or inferred library mappings.

The `collection_ids` client capability is advertised in both the chat and Zotero
provider handshakes through the shared Zotero client identity. A backend must
check the executing provider as well as the consuming client before switching
its model-facing interface. `portable_ids` alone does not imply this support.

## Mutation and client compatibility

Existing required fields retain their meanings. Older backends may ignore these
fields and continue using the native key plus library pair.

| Surface | Portable fields | Native fields retained |
| --- | --- | --- |
| Collection reference, attachment, filter, current collection, metadata membership | `collection_id`, optional `parent_collection_id` | `zotero_key` or `collection_key`, library identity, parent key |
| Create collection validation | `parent_collection_id`, `library_ref` | `parent_key`, `library_id` |
| Create collection result | `collection_id`, `library_ref` | `collection_key`, `library_id` |
| Manage collections proposal/result | `collection_id`, `new_parent_collection_id`; result also `old_parent_collection_id` | target and parent keys, library identity, undo snapshot |
| Create item validation/result and create note validation/result | `collection_ids` | `collection_keys`, legacy singular note key, library identity |
| Organize items result | `collection_ids_added`, `collection_ids_removed` | `collections_added`, `collections_removed`; owning item IDs scope the native memberships |

Validation's `normalized_action_data` must be merged into the action before
execution or persistence. It retains exact keys and portable library references.
Create-item validation returns both `collections` and `collection_keys` so batch
inputs and per-item proposals can retain the resolved memberships. Collection
names in organize-item validation include native and portable map keys.

Execution rechecks the recorded identity, current access, editability, existence,
and applicable move/delete guards. A name is never resolved to a replacement
collection after approval. A membership the write would *add*, and a parent or
target a create/rename/move/delete names, must still exist: it fails before any
write rather than reporting incomplete work as done. A membership the write
would *remove* is dropped instead — an item cannot belong to a collection that
no longer exists, so the requested state already holds, and failing over it
would also discard tag changes requested in the same action. Child notes inherit
their parent's membership and do not receive direct collection assignments.
Restore permits a trashed collection only through an explicit exact-identity
lookup and rechecks its parent.

Undo resolves recorded targets the same way with two allowances, because it is
the user's only way back out of an applied action: it accepts a trashed
collection, whose memberships still exist, and treats a collection that is gone
entirely as nothing left to restore, continuing with the rest of the undo.
Access, editability and library-availability failures still stop it. Resolution
errors quote the reference the caller supplied, never one the recheck qualified
on its behalf.

Readers accept portable ID-only collection rows, scoped legacy keys, and
historical compound keys. Structured action and attachment decoding preserves
portable identity without rewriting prose. Explicit collection navigation keeps
its collection kind; ambiguous unscoped batch keys do not select a first match.
Batch outcome groups can reconcile a native key with a portable ID only when the
batch supplies its library reference.

Regression fixtures live in the collection mutation lifecycle, item import,
note collection resolution, and collection compatibility unit suites.

## Backend integration follow-ups

The backend must preserve `unresolved_collections` in model-facing discovery
results so partial success cannot silently drop a requested collection. Population
results must retain `collection_ids` aligned with `collection_names`, including
repeated aliases. Typed plugin errors should retain their recovery message rather
than being wrapped with another “Collection not found” prefix or replaced.

Search input validation must allow the collection reference grammar described
above. Write tools persist the normalized keys and portable references returned
in `normalized_action_data`; changing only the backend schema is insufficient.

Full metadata memberships exclude trashed collections. Collection write validation
rejects trashed targets, and execution rechecks create parents, move parents and
sources, and organize memberships after approval.
