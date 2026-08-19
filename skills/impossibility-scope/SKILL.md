---
name: impossibility-scope
description: Use whenever writing or fact-checking a claim that something is impossible, forbidden, or "can't happen" — process/OS boundaries, permissions, isolation guarantees, API limits, security claims, race conditions. Forces the claim to state its scope (which actor, via which mechanism, at what privilege level) instead of an absolute, and to name the next-wider scope where the claim flips.
---

# Impossibility Scope

Every "can't" is short for "can't *within* some model". The model has three
parts, and all three belong in the sentence:

1. **Actor** — who or what is prevented? (the process itself? another
   same-uid process? another user? root? kernel code?)
2. **Mechanism** — which boundary does the preventing? (address space,
   syscall surface, privilege ring, API contract, policy)
3. **Flip point** — the next-wider scope where the claim dies.

If the sentence doesn't name 1 and 2, it will be wrong the moment a reader
stands one rung wider than you assumed.

## Rules

- **Mechanism over verdict.** Instead of "X is impossible", say which memory,
  layer, or syscall boundary makes it impossible. For cross-process state the
  first question is: *whose address space is that state in?* A process can
  always mutate its own; nobody has a polite API to mutate another's.
- **Separate mechanism from policy.** "Can't happen" vs "doesn't happen by
  design". tmux *could* ptrace-inject a new env into a pane shell; it doesn't,
  because Unix policy is "let the process fix itself or restart it" (respawn,
  re-exec). Both facts belong in the answer; only one is physics.
- **Watch overloaded nouns.** Flat claims usually hide a term that's secretly
  several things. "The environment" = the kernel-copied initial block
  (`/proc/PID/environ`, frozen at exec), libc's `environ` pointer (relocated
  to the heap after the first `setenv`), and the shell's internal variable
  tables. Each copy obeys different rules — which one a claim is about
  changes the answer.
- **On pushback, decompose — don't defend.** If a user's counterexample
  lands, the claim's hidden scope was violated, not the user's reading.
  Identify which of actor/mechanism/noun they widened, restate the claim at
  the correct rung, and credit the counterexample as the scope-exposing one.
- **Climb the ladder explicitly when asked, stop one rung early by default.**
  A good answer implies the ladder exists (name the flip point) without
  climbing all of it (kernel rewrites) unprompted.

## Canonical example (environment variables)

Claim: *"No one — not even tmux — can mutate the environment of an
already-running shell."*

The ladder, narrowest to widest:

| Rung | Actor + mechanism | Verdict |
|------|-------------------|---------|
| Self | shell calls `putenv()` on its own memory | always works — `export VAR=1` |
| Peer | another process, normal APIs | true can't: env is private memory, no syscall for it |
| Debugger | same-uid via ptrace, `/proc/PID/mem`, `process_vm_writev` | memory is writable, but allocation-invariants make raw patches unsafe; real tooling (gdb `call (int)putenv("V=1")`) forces the target to mutate *itself* — recreating rung 1 |
| Kernel | module walking page tables | no rules |

The flat claim was rung 2, phrased as universal. The counterexample
(`export`) sat on rung 1 — one step *narrower* in actor scope, which is the
direction absolute claims never check.

## Self-check

Scan your draft for: *impossible, no one, never, can't, only way, by design*.
For each hit, ask:

- Does the sentence name the actor and the enforcing boundary?
- Would it survive a "what about X?" from a reader one rung wider?
- Is a policy choice being stated as physics (or vice versa)?

## Rewrite examples

| Don't write | Write instead |
|-------------|---------------|
| "No one can mutate the env of a running shell." | "No *external* process can via normal APIs — the env is private per-process memory; the shell itself trivially can (`export`), and even the external case ends at ptrace, where the practical fix is making the target call `putenv` itself." |
| "You can't change another process's memory." | "No sanctioned userland API lets A write B's memory; ptrace and `/proc/PID/mem` exist for same-uid debuggers, and kernel code has no limit at all." |
| "tmux can't update the pane's env." | "tmux won't reach into a running process — it updates its own stored copy, which new panes inherit at creation. A live shell must fix itself (`export`) or be re-exec'd (`respawn-pane`)." |
