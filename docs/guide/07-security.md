# 7. Security

> **In plain terms:** Three ideas protect everything. **One door**: the
> only thing on the internet is one Worker behind Google sign-in.
> **One readable copy**: your memories are readable only inside your
> Postgres database; every other component holds encrypted blobs or
> content-free bookkeeping, and the keys that unlock content either derive
> from *your* login or live for at most 24 hours. **Nothing irreversible
> without you**: actions are classified by how much damage they could do,
> and the dangerous ones stop at your approval — with the approved content
> cryptographically pinned so nothing can be swapped after you tap yes.

## Law 1 in practice: one door

- The hostname (`haetsalos.specialdarksystems.com`) is entirely behind
  **Cloudflare Access** — dashboard, APIs, MCP, webhooks with their own
  verification. Interactive = Google SSO; headless (smoke tests, CI) = a
  named service token.
- There is no second service, no admin port, no direct database exposure.
  Neon is reached only from inside the Worker via Hyperdrive.

## Law 2 in practice: where content may live

| Store | What it holds |
|---|---|
| **Neon Postgres** (Hyperdrive) | **The plaintext copy** — documents, chunks, embeddings, governance |
| R2 (`brain-artifacts`) | Sealed blobs only: archival bodies, photos, execution traces, compiled artifacts, action payloads — AES-GCM under a tenant key |
| D1 (`brain-us`) | Metadata: tenants, pending-action rows, audit ops, traces, decay states, canary results — content-free |
| DO SQLite | Session messages and automation specs as `*_ciphertext` columns |
| KV | Session material and the short-lived Cron KEK (24 h TTL) |
| Logs / Analytics / AI Gateway | Shape-only: counts, statuses, fixed-vocabulary errors — never content previews |

Managed artifact lifecycle events in D1 record only tenant/operation/upload
IDs, timestamps, the fixed states `reserved`, `sealed`, `finalized`, `failed`,
`expired`, and `reaped`, plus fixed-vocabulary failure codes. Names, local
paths, hosted URLs, captions, extraction text, and file bytes are excluded.

### The two key families (and why there are two)

- **TMK (Tenant Master Key)** — derived *per request* from your
  authenticated identity (HKDF over your Access JWT subject), held as a
  non-extractable WebCrypto key. It exists only while you're
  authenticated; it is never stored anywhere.
- **Cron KEK** — a random 32-byte key for scheduled jobs (which run with
  no user present): raw copy in KV with a 24-hour TTL, TMK-encrypted copy
  in D1, renewed whenever you're active.

They are **not interchangeable** (proven live in Phase 8: a KEK-sealed
dream report is unreadable under the TMK), so everything sealed at rest is
**family-tagged**: `TMK1:…` / `KEK1:…` prefixes on the blob say which key
can open it, and a cross-family attempt fails loudly instead of
half-working.

**The accepted trade-offs** (deliberate, documented in the
[ops runbook ADRs](../lessons/phase-13-ops-runbook.md)): the KEK's raw
bytes sit in KV for up to 24 h (that's what lets 2am jobs work at all),
and queue messages carry content for the seconds between enqueue and
acknowledgment. Both were audited and judged better than the
alternatives (no overnight autonomy; every retain dependent on the KEK).

## Law 3 + actions: nothing irreversible without you

Every action tool carries a **capability class**:

| Class | Tools | Behavior (authorization floor) |
|---|---|---|
| `READ` | `act_search`, `act_browse` | GREEN — executes immediately |
| `WRITE_INTERNAL` | `act_draft`, `act_remind` | GREEN — executes immediately (changes only your own state) |
| `WRITE_EXTERNAL_REVERSIBLE` | `act_create_event`, `act_modify_event` | YELLOW — awaits your approval (and can be undone) |
| `WRITE_EXTERNAL_IRREVERSIBLE` | `act_send_message`, `act_run_playbook` | YELLOW — **draft-first + explicit approval**, then a 120 s send delay (your undo window) |

Floors are one-directional: policy can tighten an action's level, never
loosen it below the class floor (`src/types/action.ts`).

The approval flow, cryptographically:

1. **Propose**: the action is drafted; its payload is sealed to R2 under
   whichever key is live (`TMK1:` if your session is warm, `KEK1:`
   otherwise), with a payload hash pinned in D1.
2. **You approve**: your authenticated approval re-derives your TMK.
3. **Execute**: the payload is unsealed *by its family tag*, integrity-
   checked against the pinned hash (the TOCTOU guard — what you saw is
   what runs), and executed. A KEK-sealed payload whose KEK has expired
   (24 h of zero activity) fails with an explicit error and asks for
   re-approval — never a silent fallback.

And per Law 3, no agent can shortcut this by *writing itself permission*:
agent-authored memory is downgraded away from instruction-grade
automatically ([chapter 6](06-memory-model.md)).

## Secret hygiene (G2)

No token values, connection strings, key bytes, or webhook secrets appear
in code, tests, logs, lessons, or this guide. Secrets live as Worker
secrets (`wrangler secret put`), encrypted at rest by Cloudflare;
migrating them to the account-level Secrets Store is a documented,
deliberately deferred follow-up (runbook ADR #1).

---

## Under the hood

- **TMK derivation**: HKDF(SHA-256) over the CF Access JWT `sub` with the
  Access AUD and salt `brain-tmk`, imported non-extractable
  (`deriveTmk` in the auth middleware). Rotating the Access app rotates
  the key universe.
- **KEK lifecycle**: `src/services/tenant.ts` (`provisionOrRenewKek`) —
  generated on first auth, re-encrypted (fresh IV) and TTL-refreshed when
  under 2 h from expiry, raw copy `cron_kek:<tenant>` in KV. Validation +
  fetch: `src/cron/kek.ts` (`fetchAndValidateKek`).
- **Family-tagged sealing**: the action worker
  (`src/workers/action/index.ts`) seals payloads with the family prefix;
  `src/services/action/approved-execution.ts` dispatches decrypt by
  prefix (legacy untagged = TMK) and throws a loud, specific error on a
  KEK-sealed payload with no KEK. Contract-tested in
  `tests/mission-13.0-hardening.test.ts` (cross-key decrypt, legacy
  compat, honest cross-family failure).
- **Why the Phase 5 "cold approval" bug mattered**: the worker used to
  address the session DO by raw tenant id — the wrong object — so even
  warm sessions couldn't produce the TMK. The fix (correct DO identity +
  KEK fallback + family tags) is what makes "approve six hours later from
  your phone" reliable.
- **Sanitized failure surfaces**: anything the platform persists
  verbatim (agent-run summaries, workflow step returns, gateway logs)
  gets fixed-vocabulary strings (`sanitizeExecutionError`,
  `GATEWAY_CHAT_EMPTY` shape-only logging) — Law 2 applies to *error
  paths* too, which is where content classically leaks.
- **Managed files**: raw sources and derivatives are AES-GCM envelopes tagged
  `TMK1` or `KEK1`; the canonical extraction is the only searchable plaintext.
  Exact R2 key, ciphertext length, and ciphertext hash are proven again before
  finalization. Cross-tenant status, finalization, document, and search reads
  fail closed.
- **Audit**: security-relevant operations write content-free rows to the
  audit ledger (`memory_audit` and friends) — tenant created, KEK
  provisioned/renewed, action approved, decay completed — which is also
  what the Usage panel reads.

## Why it's built this way

The zero-knowledge posture assumes any *one* component can be compromised
or subpoenaed without yielding your memory: logs leak, analytics get
shared, object stores get misconfigured — so none of them ever hold
readable content. The two-key design is the honest resolution of a real
conflict: user-derived keys (perfect isolation, exists only when you're
present) vs. an always-on brain (must work at 2am). TMK for presence, KEK
for absence, family tags so the boundary between them is *typed and
loud* rather than implicit and silent.
