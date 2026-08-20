# mcp-tenderly

MCP server exposing Tenderly transaction simulation and trace debugging over the
stdio transport. See `README.md` for user-facing setup and the tool reference.

## Commands

```bash
npm run verify     # everything CI runs, in CI's order
npm test           # unit tests (excludes the stdio smoke test)
npm run test:smoke # builds, then drives dist/index.js over a real stdio transport
npm run typecheck
npm run lint
```

## Layout

```
src/
  index.ts            entry point: config, stdio transport, signals
  server.ts           builds the McpServer and registers tools
  config.ts           the only module that reads process.env
  logger.ts           structured NDJSON logging to stderr
  errors.ts           error taxonomy, retriable vs terminal, remediation text
  tenderly/
    client.ts         REST client: auth, timeout, bounded retry
    schemas.ts        zod shapes for every response
    format.ts         payload to LLM-readable digest  <- the point of the server
    networks.ts       chain name to chain id
  tools/
    common.ts         shared input schemas, runTool boundary
    *.ts              one file per tool
```

## Constraints worth knowing before you change anything

**Stdout belongs to the protocol.** Under stdio, stdout carries newline-delimited
JSON-RPC frames. A single `console.log` anywhere in `src/` corrupts the framing
and the host silently drops the server. All diagnostics go through `logger.ts`,
which writes to stderr. `tests/stdio-smoke.test.ts` asserts that stdout contains
nothing but valid frames — that test exists specifically to catch this.

**Response schemas are intentionally lenient.** Every response shape in
`schemas.ts` is a `z.looseObject` with almost every field optional. This is not
laziness. The Tenderly API is not version-locked, and its payloads genuinely
differ between `simulation_type` values, between `/simulate` and
`/simulations/{id}`, and between verified and unverified contracts. Strict
parsing would turn a harmless new field or an absent optional block into a hard
tool failure — much worse than a formatter rendering "unknown" for one line. The
invariant that _is_ kept: nothing reaches the formatter without passing a schema,
so the formatter never indexes into `any`.

**`CallTraceNode` duplicates its schema, and must be kept in sync.** The type in
`schemas.ts` is hand-written because the schema is recursive and `z.lazy` cannot
infer through the cycle. It is the one place a type restates a schema. Every
field marked `.nullable()` in the schema needs `| null` in the interface —
omitting it makes the null guards in `format.ts` look like dead code, and
`no-unnecessary-condition` will flag them.

**Optional tool arguments arrive as explicit `undefined`.** Because
`exactOptionalPropertyTypes` is on and tool args are mapped field by field, an
omitted argument reaches the formatter as a property present with value
`undefined`. Spreading that over a defaults object overwrites the defaults with
`undefined` — which once silently switched the call trace off. `withDefaults()`
in `format.ts` therefore resolves each field with `??` rather than spreading, and
a regression test covers it. Do not "simplify" it back into a spread.

**Free-tier endpoints only.** `client.ts` uses `/simulate`, `/simulate-bundle`,
`/simulations` and `/simulations/{id}` and nothing else. Web3 Gateway, DevNets,
Virtual TestNets, Alerts and Actions are paid or OAuth-gated; adding them would
break the server for the free-tier users it exists to serve.

**`GET /simulations/{id}` returns metadata only.** Verified against the live
API: the response is `{ simulation: {…} }` with inputs, gas, status and
`error_message`, and **no** `transaction_info` — so no call trace, no logs, no
state diff. The trace exists only in the `POST /simulate` response that created
it. `tenderly_get_simulation` therefore fetches the metadata and then calls
`client.replaySimulation()`, which rebuilds a `/simulate` call from the recorded
inputs at the recorded block (`save: false`, so it costs no stored-simulation
quota). The original metadata is kept for identity, so the reported id and
dashboard link still point at the saved simulation rather than the replay. Do not
"simplify" this back into a single GET — the trace will silently vanish.

**Real payloads are messier than the documented schema.** Each of these was found
by running against the live API, and each is covered by a test built from the
observed shape:

- Numeric fields mix decimal and hex, and zero arrives as bare `"0x"`, which
  `BigInt()` throws on. Every numeric read goes through `toBigInt()`.
- `gas` is the int64 maximum when the caller set no limit, and `0` on a saved
  record. `realGas()` drops the sentinel; `realGasLimit()` also drops zero, while
  leaving zero meaningful for gas _used_.
- Absent strings arrive as missing, `null`, **or** `""`, sometimes for the same
  field across endpoints. `??` does not skip `""`, which is why `present()` and
  `firstPresent()` exist — an empty `method` once rendered as a bare `- Method:`
  line, and an empty `call_type` as a blank op in the trace.
- A 20-byte address must not go through the long-blob eliding path, or a decoded
  argument renders as `0x0000…0001 (10 bytes elided)`.

**All chain-derived strings go through `untrusted()` before rendering.** This is
a security boundary in `format.ts`, not formatting. Contract names, token
symbols, function names, decoded string values, verified source lines and revert
reasons are controlled by whoever deployed the contract, and this server exists
to be pointed at contracts nobody trusts yet. A `revert()` string is fully
attacker-chosen and is rendered at the very top of the output, so an unsanitised
one can forge a `## heading` that reads as server-generated instruction.

`untrusted()` collapses whitespace (removing the newlines needed to forge
markdown structure), strips C0/C1 controls plus zero-width and bidi-override
characters (trojan-source style hiding), and caps length with the truncation
announced. The defence is deliberately structural — detecting injection
semantically is whack-a-mole, whereas text that cannot contain a newline cannot
start a new block. `sanitiseOrNull()` applies the same treatment inside
`buildDigest`, so `structuredContent` is covered as well as the text.

When adding a render site for any string that came from a simulation, route it
through `untrusted()` with a length cap suited to the field. The adversarial
tests in `tests/format.test.ts` ("untrusted chain data cannot escape its field")
cover heading forgery, bidi characters, oversized payloads and — importantly —
that ordinary revert strings survive unmangled.

**Truncation is always announced.** `format.ts` caps trace frames, events, asset
changes and state entries. Every cap emits a note saying what was dropped and
which argument raises it. A silent cap reads to the model as "that was
everything" and quietly produces wrong conclusions.

## Testing against real Tenderly

The suite never touches the network — the client takes an injected `fetch` and
the smoke test points `TENDERLY_BASE_URL` at a local stub. To exercise the real
API by hand, put credentials in `.env` (gitignored) and run the built server
directly, pasting JSON-RPC frames on stdin:

```bash
set -a && . ./.env && set +a && node dist/index.js
```

When a real response does not match `schemas.ts`, the fix is to relax the schema
and add the observed shape to a fixture in `tests/helpers.ts` — not to tighten
the schema around one observation. `realWorldUsdcResponse()` in that file is
captured from an actual mainnet response, and exists precisely because the
hand-written fixtures were too clean to expose the quirks listed above.
