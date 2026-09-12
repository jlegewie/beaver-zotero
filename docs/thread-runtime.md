# Thread state across windows

The plugin instance owns `threads` (metadata and query cache) and `presence`
(viewers, active writers, and history invalidation). Each renderer subscribes
before mounting and projects plain snapshots into its own atom graph. Drafts,
attachments, run history, and streamed parts stay local to that renderer.

The repository retains normalized entities, scoped query identities, pagination,
pin reconciliation and error backoff. Reads share in-flight requests; metadata
mutations execute in order in the plugin realm. Account generations reject old
responses, per-entity revisions protect newer mutations, and deletion tombstones
prevent late fetches from recreating deleted entries. Realtime subscriptions and
network continuations belong to the instance, so closing their original caller
cannot strand them. Subscriber snapshots do not expose mutable cache objects.

A writer claim contains an account generation, runtime id, thread identity and
unique token. Send (including slash-command preparation), continuation, retry,
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
