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
the schema around one observation.
