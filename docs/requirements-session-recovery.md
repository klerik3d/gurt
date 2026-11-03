# Session recovery and deferred updates

Started sessions persist an unfinished-turn marker before sending work to the
agent, and clear it when the turn finishes. Accepted queued prompts, including
context and image payloads, are persisted before acceptance returns. Writes use
the existing serialized atomic JSON store.

On launch, interrupted turns and restored queues remain paused. The application
shows a checklist to resume selected sessions; Later keeps a resume button in
the titlebar. Resuming loads the existing ACP conversation and places a recovery
instruction before queued messages. It tells the agent to inspect current state,
avoid repeating completed actions, and request necessary permissions again.
Queued messages that had not started retain their original order and payloads.
A missing or unloadable agent session is reported by the existing resume error
path; recovery cannot recreate a lost agent history or undo partial tool effects.

The update button is immediately left of Search. Its menu offers Update now,
Update when sessions finish, and Later. A scheduled update can be cancelled.
Deferred installation waits for running prompts (including contract nudges),
startup, queued sessions/messages, loading, permission requests, rate-limit waits,
and sessions awaiting recovery. Idle open conversations do not block it.
Before installation, session state and buffered history are flushed, and the
deferred path rechecks that no work began while flushing. Scheduling is local to
the current application process.

Older records without interruption markers continue to load normally, but work
interrupted before this feature was installed cannot reliably be identified.
