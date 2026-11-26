# Thread state across windows

The plugin instance owns `threads` (metadata and query cache) and `presence`
(viewers, active writers, and history invalidation). Each renderer subscribes
before mounting and projects plain snapshots into its own atom graph. Drafts and
attachments stay local to that renderer.

Runs execute in the plugin realm, in run sessions `addon.agentRuns` keeps, one per
chat that a window shows or that has a run going. A session holds the chat's run
history, streamed parts, cards and transport in a private store. Each window views
the session of the chat it shows and projects that state onto its own atoms,
applying streamed text once per animation frame; several windows can view one
session. What a window passes in (a message it assembled, a command) is copied
into the session, which owns the run.

Switching chats, or closing a window, only changes what is viewed: a run goes on
in its session, with or without a window, and the session leaves the registry once
nothing views it and it is idle. A session also waits on the table fills its runs
start and resumes the run when one ends. At most four chats run at once (a chat
parked on a fill does not count); a fifth send is refused and keeps the draft.
Thread lists show a spinner for a chat with a run going and the awaiting-input dot
while it waits for the user (`agent-runs:activity`). The account changing, or a
library leaving the searchable scope, stops every session's run; quitting Zotero
or disabling Beaver parks runs that wait only on cards and closes the others,
recording them as interrupted.

The repository retains normalized entities, scoped query identities, pagination,
pin reconciliation and error backoff. Reads share in-flight requests; metadata
mutations execute in order in the plugin realm. Account generations reject old
responses, per-entity revisions protect newer mutations, and deletion tombstones
prevent late fetches from recreating deleted entries. Network continuations
belong to the instance, so closing their original caller cannot strand them.
Subscriber snapshots do not expose mutable cache objects.

There is no server push for thread metadata. Every window mutates through the
repository, so a rename, pin, or deletion in one window reaches the others
synchronously. Changes made on another device surface through the view TTL, and
a deletion through the 404 of a stale fetch, which marks the chat deleted for
every viewer in this instance.

A writer claim contains an account generation, its owner (a run session, which
holds it for itself, or a window deleting a thread), thread identity and unique
token. A session's claim ends with the session, not with a window. Send (including slash-command preparation), continuation, retry,
regeneration and deletion claim before work begins. New chats use provisional
identities and bind to server thread ids without sharing a draft. Claims cover
preparation, connection, streaming, user-input waits, automatic replacement and
finalization. Socket callbacks are also bound to a connection epoch; a stale
completion cannot mutate or release a successor. Closing a renderer revokes its
subscriptions and removes its viewer record; its sessions go on.

Every window that shows a chat shows its one session, so any of them can stop
the run or answer its cards; a card answered in one window is gone in the others.
A chat whose history changed in this instance outside the session shown (a
deletion, say) must be refreshed before another send. Refreshing reads persisted
history without clearing the composer or attachments; an invalidation arriving
during the refresh requires another refresh. Deletion immediately blocks further
operations in every viewer.

Interrupted runs are retained in a bounded, account-scoped preference list,
keyed by thread/run. Synchronous consumption assigns an offer to one surface;
presented records suppress duplicate offers. The list accepts older single-record
preferences. Reopening loads saved history; continuation is offered only when
supported by that history.

Local claims are not a backend concurrency guarantee. A closed socket may still
have terminal persistence in flight. Another device's run shows as busy through
server admission only.
