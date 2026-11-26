# Thread state across windows

The plugin instance owns `threads` (metadata and query cache) and `presence`
(viewers, active writers, and history invalidation). Each renderer subscribes
before mounting and projects plain snapshots into its own atom graph. Drafts and
attachments stay local to that renderer.

Runs execute in the plugin realm, in the run session `addon.agentRuns` keeps for
each chat window. The session holds the chat's run history, streamed parts, cards
and transport in a private store; its window is its only viewer and projects that
state onto its own atoms, applying streamed text once per animation frame. A
message the window assembles is copied into the session, which then owns the run.
Closing the window parks a run that waits only on cards and closes any other
(recording it as interrupted); switching chats parks, leaves or stops the run as
before. The account changing, or a library leaving the searchable scope, stops
every session's run.

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

A writer claim contains an account generation, its owner (the run session, or a
window deleting a thread), the window it acts for, thread identity and unique
token. Send (including slash-command preparation), continuation, retry,
regeneration and deletion claim before work begins. New chats use provisional
identities and bind to server thread ids without sharing a draft. Claims cover
preparation, connection, streaming, user-input waits, automatic replacement and
finalization. Socket callbacks are also bound to a connection epoch; a stale
completion cannot mutate or release a successor. Closing a renderer revokes its
callbacks and admission, removes its viewer record, and invalidates its history.

Another viewer keeps its composer, sees “Responding in another window”, and can
focus the owner. Following settlement it must refresh before another send.
Refreshing reads persisted history without clearing the composer or attachments;
an invalidation arriving during the refresh requires another refresh. Deletion
immediately blocks further operations in every viewer.

Interrupted runs are retained in a bounded, account-scoped preference list,
keyed by thread/run. Synchronous consumption assigns an offer to one surface;
presented records suppress duplicate offers. The list accepts older single-record
preferences. Reopening loads saved history; continuation is offered only when
supported by that history.

Local claims are not a backend concurrency guarantee. A closed socket may still
have terminal persistence in flight. Atomic server admission, conflict protocol
integration, and enabling concurrent standalone chat remain separate rollout
gates. No live stream is transferred between windows.
