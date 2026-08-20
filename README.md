# mcp-tenderly

An [MCP](https://modelcontextprotocol.io) server that gives an AI assistant the
ability to **simulate EVM transactions and debug why they revert**, using
Tenderly's free-tier simulation API.

Ask "would this transaction work?" or "why did this fail?" and get an answer
grounded in real forked chain state — the decoded call trace, the revert reason,
the exact source line — instead of a guess.

Nothing is ever broadcast. Simulations are read-only against a fork, so they are
safe to run freely.

## Why this exists

An assistant reasoning about an on-chain transaction is normally working blind:
it can read the contract source, but it cannot tell you whether a call reverts
against _current_ state, what the gas actually costs, or which of eight nested
delegatecalls is the one that failed. Tenderly can answer all three, and its
simulation API is usable on a free account.

The hard part is not calling the API — it is that a `simulation_type: "full"`
response for a real DeFi transaction is frequently **over a megabyte of JSON**:
a state diff over every touched storage slot, a call tree hundreds of frames
deep. Handing that to a model is both unaffordable and useless, because the
answer to "why did this revert" is four lines buried inside it.

So this server's real work is the formatter: it puts the outcome first, then the
revert reason and the source-mapped frame, then decoded events, then the call
tree as an indented ASCII diagram — and it always states when it truncated
something, because a silent cap reads as "that was everything".

## Quickstart

Requires Node.js 22.12 or newer.

### 1. Get Tenderly credentials

All three come from a free Tenderly account:

| Variable                | Where to find it                                                               |
| ----------------------- | ------------------------------------------------------------------------------ |
| `TENDERLY_API_KEY`      | Dashboard → **Account Settings → Access Tokens** → _Generate Access Token_     |
| `TENDERLY_ACCOUNT_SLUG` | The first path segment of your dashboard URL: `dashboard.tenderly.co/<this>/…` |
| `TENDERLY_PROJECT_SLUG` | The second segment: `dashboard.tenderly.co/…/<this>`                           |

Both slugs are the **URL slugs**, not display names — a project shown as
"My Project" is usually `my-project`. The server validates this at startup and
tells you which variable is wrong rather than letting it surface later as a 404.

### 2. Register the server with your client

**Claude Code**

```bash
claude mcp add tenderly \
  -e TENDERLY_API_KEY=your-token \
  -e TENDERLY_ACCOUNT_SLUG=your-account \
  -e TENDERLY_PROJECT_SLUG=your-project \
  -- npx -y mcp-tenderly
```

**Claude Desktop, Cursor, or any other MCP host** — add to the client's MCP
config file:

```json
{
  "mcpServers": {
    "tenderly": {
      "command": "npx",
      "args": ["-y", "mcp-tenderly"],
      "env": {
        "TENDERLY_API_KEY": "your-token",
        "TENDERLY_ACCOUNT_SLUG": "your-account",
        "TENDERLY_PROJECT_SLUG": "your-project"
      }
    }
  }
}
```

### Running from a local clone

```bash
git clone https://github.com/py-zoid/mcp-tenderly.git
cd mcp-tenderly
npm install
npm run build
```

Then point the client at the build output, replacing `<repo>` with the absolute
path to your clone:

```json
{
  "mcpServers": {
    "tenderly": {
      "command": "node",
      "args": ["<repo>/dist/index.js"],
      "env": { "TENDERLY_API_KEY": "…", "TENDERLY_ACCOUNT_SLUG": "…", "TENDERLY_PROJECT_SLUG": "…" }
    }
  }
}
```

## Tools

### `tenderly_simulate_transaction`

Simulate one transaction against forked chain state. Returns success or revert,
gas used, the revert reason with a source-mapped stack trace where the contract
is verified, decoded events, token transfers, and the decoded call trace.

Accepts `network` as a name (`base`, `arbitrum`, `polygon`, `sepolia`, …) or a
numeric chain id, the usual transaction fields (`from`, `to`, `data`, `value`,
`gas`, `gas_price`), an optional `block_number` to fork from, and
`state_overrides` to fake balances, nonces, storage slots or bytecode.

### `tenderly_simulate_bundle`

Simulate up to 20 transactions **in order against shared state**, so each sees
the effects of the ones before it. This is the tool for flows that cannot be
checked one transaction at a time — approve then swap, deploy then initialise,
or replaying an exploit sequence. It reports which step in the sequence broke.

### `tenderly_get_simulation`

Look up a saved simulation by id and render its outcome and full call trace. Use
it to go deeper on a trace that was truncated, to pull the state diff that is
omitted by default, or to inspect a simulation created earlier or from the
Tenderly UI.

One thing worth knowing, because it shapes how this tool behaves: Tenderly's
saved-simulation record stores **only metadata** — inputs, gas, status, error
message. The call trace is not kept. So the trace is reproduced by replaying the
recorded inputs at the recorded block, which is faithful (same fork, same
outcome) but costs one simulation against your rate limit. The replay is not
saved, so it does not consume stored-simulation quota. Pass
`reconstruct_trace: false` for a cheap metadata-only lookup.

### `tenderly_list_simulations`

List recent saved simulations in the project, one line each, to find an id.

### Controlling output size

Every read tool takes the same output controls. The defaults are tuned to keep a
typical response affordable:

| Argument                | Default | Notes                                            |
| ----------------------- | ------- | ------------------------------------------------ |
| `include_call_trace`    | `true`  | The main debugging artefact.                     |
| `include_asset_changes` | `true`  | Token transfers and native balance deltas.       |
| `include_state_diff`    | `false` | Off by default — by far the bulkiest section.    |
| `include_opcode_frames` | `false` | Show `SLOAD`/`SSTORE`/`LOG` frames. See below.   |
| `max_trace_nodes`       | `200`   | Truncation is always reported in the output.     |
| `max_trace_depth`       | `12`    | Deep proxy chains hit this before the node cap.  |
| `include_raw_response`  | `false` | Appends the untouched Tenderly JSON. Very large. |

A full Tenderly trace interleaves storage and log opcodes with real calls — a
plain USDC transfer yields a dozen `SLOAD`s around four actual calls, and a DeFi
transaction yields hundreds. Left in, they consume the frame budget and push the
calls that explain a revert out of the output, so they are hidden by default and
the count is reported. Internal Solidity function frames (`JUMPDEST`) are kept:
those are what let you follow a revert through a library or proxy.

## Free-tier notes

This server deliberately uses **only** the v1 simulation REST endpoints that
work on a free plan: `/simulate`, `/simulate-bundle`, `/simulations` and
`/simulations/{id}`. It never touches the Web3 Gateway, DevNets, Virtual
TestNets, Alerts or the Actions API — those are paid or OAuth-gated, and
reaching for them would make the server fail confusingly for exactly the users
it targets.

Two things to know about quota:

- **Saved simulations consume quota.** By default simulations are saved, because
  a dashboard URL is worth a great deal when debugging. Set
  `TENDERLY_SAVE_SIMULATIONS=false`, or pass `save: false` per call, to keep them
  ephemeral.
- **Rate limits produce a 429.** The client retries these with backoff, honouring
  `Retry-After`, and then reports the limit plainly rather than hanging.

### Optional configuration

| Variable                    | Default                   | Purpose                               |
| --------------------------- | ------------------------- | ------------------------------------- |
| `TENDERLY_SAVE_SIMULATIONS` | `true`                    | Persist simulations and return a URL. |
| `TENDERLY_LOG_LEVEL`        | `info`                    | `debug`, `info`, `warn`, `error`.     |
| `TENDERLY_TIMEOUT_MS`       | `30000`                   | Per-request timeout.                  |
| `TENDERLY_BASE_URL`         | `https://api.tenderly.co` | Override for testing against a stub.  |

## Security and trust model

**Simulations never broadcast.** Every call is read-only against a Tenderly
fork. No transaction is signed or sent, and the server holds no keys beyond your
Tenderly access token.

**One outbound host.** The server talks only to `api.tenderly.co`. Nothing else
is contacted, and no telemetry is collected.

**Your access token stays out of output.** It is sent only as the `X-Access-Key`
header, is never logged at any log level, and is excluded from error messages
and paths. A test asserts it is absent from both stdout and stderr.

**Simulation output is treated as untrusted input.** This is the one worth
understanding, because it is easy to miss. Contract names, token symbols,
function names, decoded strings, verified source lines and revert reasons are
all controlled by whoever deployed the contract — and the point of this server
is pointing it at contracts you do _not_ yet trust. A contract can `revert()`
with any string it likes, which lands in the most prominent position in the
output.

So all such text is passed through a sanitiser before rendering: whitespace is
collapsed to a single line, zero-width and bidi-override characters are removed,
and length is capped with the truncation stated. That prevents hostile chain
data from forging a markdown heading, a list item, or anything else that could
read to a model as instructions rather than as data. It is a structural defence,
not an attempt to detect malicious intent — untrusted text simply cannot escape
the field it belongs to. Ordinary revert strings are unaffected.

This does not make a hostile contract's output _true_, only inert. Treat a
simulation result as a report about untrusted code, which is what it is.

## Troubleshooting

**The server exits immediately with a config message.** That is by design — it
refuses to start rather than failing inside your first tool call. The message
names the variable at fault. Exit code is `78` (`EX_CONFIG`).

**`401` or `403`.** The token must be an **Access Token** from Account Settings,
not a project secret or an RPC key, and it must belong to an account with access
to `TENDERLY_ACCOUNT_SLUG`.

**`404`.** Almost always a slug problem: display name instead of slug, or
`account/project` pasted into one variable.

**No revert reason on a failure.** The contract is probably unverified, or it
used a custom error. The call trace still identifies the failing frame, and the
selector is shown so you can look it up.

**Everything looks empty.** Re-run with `include_raw_response: true` to see what
Tenderly actually returned.

Server logs go to **stderr** as JSON — check your MCP client's server log view.
The API key is never logged.

## Development

```bash
npm install        # also installs the git hooks via core.hooksPath
npm run verify     # everything CI runs: format, lint, types, unit, stdio smoke
npm test           # unit tests only
npm run test:smoke # builds, then drives dist/index.js over real stdio
```

`npm run verify` is exactly what CI executes — the workflow YAML only invokes
`.github/scripts/verify.sh`, so there is nothing you cannot reproduce locally.

See [CLAUDE.md](./CLAUDE.md) for the architecture and the design decisions worth
knowing before changing anything.

## License

MIT
