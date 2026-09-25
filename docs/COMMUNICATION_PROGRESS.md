The reconciled repair branch passes 221 TypeScript tests; the preceding Rust relay run passed 17 tests. The hourly automation continues remaining verified work; the original development checkout and already-running interactive MCP hosts have not received these changes. [data]

The coordinator and Claude maintainer exchanged implementation findings directly through Magpie call `call-hGvZDhh97Q4DA9q0`. The coordinator independently reviewed and tested the maintainer's changes. The earlier design agreement is recorded in call `call-aR3rDR49YM1HGWwF`. [action]

| Defect | Current result | Verification |
| --- | --- | --- |
| Cancelled waits lost messages or later sent abandoned questions. | MCP cancellation now preserves buffered and late responses, cancels pairing timers, and distinguishes sent from not-sent. | Real MCP cancellation tests and session tests pass. |
| Recovered responses requested another answer. | The tool now preserves reply correlation and distinguishes responses from queries. | The late-response RPC test passes. |
| One hangup closed unrelated calls. | A call ID scopes termination; socket loss still closes all calls on that socket. | A second call remains usable in the real-relay test. |
| An unpaired invitation survived hangup. | Both relay implementations remove only the owner's invitation and acknowledge removal. | TypeScript socket tests, Rust registry tests, and client integration tests pass. |
| Resolution was reported before delivery. | A sealed receipt must match the exact resolution ID; cap rejection and unrelated receipts fail honestly. | Conversation-budget, wrong-receipt, and absolute-cap tests pass. |
| Report IDs reached file paths without validation. | Wire parsing and report persistence enforce canonical call IDs. | Invalid paths are refused before a file is created or read. |
| An unattended worker could outlive its run. | A local supervisor locks execution, bounds runtime, records results, and cleans its process group. | Normal exit, failure, cancellation, ignored TERM, descendant cleanup, and overlap tests pass. |

The coordinator verified the combined batch with `npx tsc -b`, `npx vitest run --cache=false`, and `cargo test -p magpie-relay --offline`. The baseline at `7f6ca41` contained 187 TypeScript tests. New regressions were observed before the corresponding core repairs. The two existing cap tests now account for two additional sealed termination messages. [data]

The relay counts opaque sealed frames, not semantic conversation turns. The client adds four slots for two hellos, a resolution, and its receipt; the absolute relay ceiling remains 50. A caller can consume the reserved slots with ordinary traffic, in which case termination fails honestly. A peer without receipt support or a relay without termination acknowledgements produces an unconfirmed error, never fabricated confirmation. [data]

## Remaining work

The durable worktree is `/Users/sanghoon/Desktop/saway/.magpie-worktrees/communication-lifecycle`, branch `fix/communication-lifecycle`. The five repair commits are `32b32d1`, `0d13935`, `6af748a`, `06c568c`, and `1ae9d49`. The maintainer call has resolved, and its Claude process and MCP child have exited. The shared localhost relay remains running for other sessions. [data]

The original `main` independently advanced to `f143a73` during this batch, with overlapping commits `fa0032f`, `20d3d1c`, `418ce00`, and `f143a73`. The coordinator reconciled these changes in local merge `b2d901f`, preserving public constants, socket-drop compatibility, and the original report-path tests. The coordinator must check whether another worker still owns the original development files. [data]

The coordinator reproduced simultaneous `resolve` calls returning two different successful summaries. Both agents agreed to reject simultaneous attempts, retain both attempted summaries, and close without agreement. Fresh client and real MCP tests now verify both failures and both non-resolved session reports. [data]

A fresh supervised Claude session acknowledged runtime `9429efd` on call `call-xXQwHeFC0mqtw1D_`. A reply arriving after the 20-second ask bound was recovered with its original correlation and no answer-back instructions. The smoke run also exposed three orchestration defects: a canonical PTY truncated a long command, the peer ended the call under its three-minute idle rule, and the tool allowlist denied the peer's attempt to ask a follow-up. The run correctly reported failure. The coordinator changed terminal input mode, removed the independent idle-close rule, and allowed bidirectional asks. The next run on `7ae2ffa` completed the long-input and bidirectional exchange, and both endpoint reports matched, but the supervisor correctly reported denied Git-shell variants. The launcher now supplies Git metadata and gives review peers file-reading tools only. [data]

The final permission-free run on `ee818fc` completed successfully on call `call-9SwhnN6DZKp8Cvt6`. The peer session was `ca37269b-ffdf-4671-b713-f1ad7aabc374`, explicitly a fresh supervised maintainer rather than the original interactive session. Both endpoints saved `resolved` reports with identical summaries, agreed points, contested points, and transcripts. The supervisor saved `status: completed`, exited with code 0, and released its lock. The coordinator and all owned maintainer/MCP process groups from the three debug runs were verified gone. The earlier long-input run was `call-0AqAdkpvFBY14YvF`; its 1,954-character probe also arrived intact. [data]

The remaining rollout task must verify deployment into the original checkout and refresh the relevant runtime only after checking its current state and active calls. Neither a source build nor passing tests updates an already-running MCP process. The shared localhost relay must not be killed while another call uses it. [data]

The next review must bound raw client open/join waits and inspect retention of closed sessions in long-running MCP hosts. The current scheduled-worker deadline limits each owned process; it is not a substitute for those library-level lifecycle bounds. [inference]

## Automation contract

Each run reads this record and `git status` before choosing one concrete pending item. When the desktop MCP host has old loaded code, `node scripts/debug-coordinator.mjs` starts an isolated fresh MCP coordinator and relay; its stdin accepts one JSON tool request per line and a final `{"name":"shutdown"}` command. It opens a fresh Magpie call and launches a maintainer with `node scripts/review-peer.mjs <invite> <bounded scope>` (read-only) or the same command with `--implement` before the invite (authorized edits) from the worktree. The launcher reads this record instead of repeatedly forking the entire historical Claude conversation. Its persisted result identifies the revision, actual peer session ID, fresh-session role, and clean/dirty worktree state. The launcher provides Git metadata directly; review peers do not need shell permissions. The user does not relay routine messages. [action]

The launcher records `.magpie/automation/last-result.json` and `latest-peer-summary.txt`. Its atomic `active` directory prevents concurrent workers. A stale lock must be investigated using its owner metadata; a run must never remove a lock blindly or start duplicate workers. The coordinator owns normal termination; a waiting maintainer must not hang up merely because the coordinator is busy. The 15-minute supervisor deadline remains the final bound. The coordinator concludes or hangs up each owned call and verifies process exit before finishing. [action]

The automation makes reviewed local commits only. It preserves the original interactive checkout and performs no automatic push, merge, or publication. It notifies the user on a meaningful change, completed batch, failure, or human-only decision. It stays quiet when nothing actionable changes and creates no speculative work once the recorded defects are resolved. [action]

## Falsification and limitations

Any lost message, cross-call termination, unconfirmed success, duplicate worker, or surviving owned child invalidates the relevant completion claim. Receipt confirmation proves that the peer received a specific conclusion; it does not prove that a human approved it or that both agents chose the same conclusion during a race. [inference]

Process-group cleanup covers owned POSIX descendants that remain in the group. An operating-system crash, a SIGKILL of the supervisor, or a deliberately detached descendant requires recovery inspection; this batch does not claim universal cleanup under those conditions. The original interactive hosts still use their previously loaded code. [data]
