# Collection resolution and read responses

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

Existing request fields and native response keys retain their meanings. No new
collection capability is advertised by this change.

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

Mutation lifecycle identity, historical payload migration, and model-facing output
activation are separate work. The optional fields above do not change the meaning
of native execution or undo records.

Resolution failures identify the supplied reference and suggest a bounded retry:
rediscover a missing ID with `list_collections`, correct conflicting explicit library
scope, or issue separate single-library searches. A note's memberships must share
one intended library. Unavailable libraries require `list_libraries` discovery and,
when necessary, user action in Zotero. Access-loading errors recommend retrying the
same request after initialization. Errors never suggest stripping qualification or
removing a narrowing condition to obtain results, and do not expose excluded names,
paths, or inferred library mappings.
