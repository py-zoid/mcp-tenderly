/**
 * Turns Tenderly payloads into text a model can reason over.
 *
 * This module is the point of the server. A `simulation_type: "full"` response
 * for a DeFi transaction routinely exceeds a megabyte of JSON — state diffs
 * over every touched slot, a call tree hundreds of frames deep. Handing that to
 * a model is both unaffordable and useless: the answer to "why did this revert"
 * is four lines buried in it.
 *
 * So everything here optimises for signal per token: outcome first, then the
 * revert reason and source frame, then decoded events, then the call tree.
 * Where output is capped, the cap is stated in the output — a silent truncation
 * reads as "that was everything" and quietly misleads the model.
 */

import type { Config } from '../config.js';
import { simulationUrl } from '../config.js';
import { describeNetwork, nativeSymbol } from './networks.js';
import type {
  CallTraceNode,
  SimulateResponse,
  SolValue,
  StackFrame,
  TenderlyContract,
  TenderlyLog,
} from './schemas.js';

export interface FormatOptions {
  /** Render the decoded call tree. */
  includeCallTrace?: boolean | undefined;
  /** Render the storage state diff. Off by default: it is the bulkiest section. */
  includeStateDiff?: boolean | undefined;
  /** Render ERC-20/721/1155 transfers and native balance deltas. */
  includeAssetChanges?: boolean | undefined;
  maxTraceNodes?: number | undefined;
  maxTraceDepth?: number | undefined;
  maxLogs?: number | undefined;
  /** Show SLOAD/SSTORE/LOG frames, which are hidden by default as noise. */
  includeOpcodeFrames?: boolean | undefined;
}

/** Every knob decided — no `undefined` survives past `withDefaults`. */
interface ResolvedFormatOptions {
  includeCallTrace: boolean;
  includeStateDiff: boolean;
  includeAssetChanges: boolean;
  maxTraceNodes: number;
  maxTraceDepth: number;
  maxLogs: number;
  includeOpcodeFrames: boolean;
}

const DEFAULTS = {
  includeCallTrace: true,
  includeStateDiff: false,
  includeAssetChanges: true,
  maxTraceNodes: 200,
  maxTraceDepth: 12,
  maxLogs: 50,
  includeOpcodeFrames: false,
} satisfies ResolvedFormatOptions;

/**
 * Applies defaults field by field rather than by spreading.
 *
 * Not stylistic: callers build these objects from optional tool arguments, so
 * every absent argument arrives as an explicit `undefined` property. Spreading
 * that over the defaults would overwrite them with `undefined` and silently
 * turn the call trace off — the exact section the tool exists to produce.
 */
function withDefaults(options: FormatOptions): ResolvedFormatOptions {
  return {
    includeCallTrace: options.includeCallTrace ?? DEFAULTS.includeCallTrace,
    includeStateDiff: options.includeStateDiff ?? DEFAULTS.includeStateDiff,
    includeAssetChanges: options.includeAssetChanges ?? DEFAULTS.includeAssetChanges,
    maxTraceNodes: options.maxTraceNodes ?? DEFAULTS.maxTraceNodes,
    maxTraceDepth: options.maxTraceDepth ?? DEFAULTS.maxTraceDepth,
    maxLogs: options.maxLogs ?? DEFAULTS.maxLogs,
    includeOpcodeFrames: options.includeOpcodeFrames ?? DEFAULTS.includeOpcodeFrames,
  };
}

/**
 * Caps on sections that have no tool argument to raise them.
 *
 * Named rather than inline because every one of them must be *announced* when
 * it bites — three of these were previously silent, which is the failure the
 * "truncation is always announced" rule exists to prevent: the model reads a
 * truncated list as a complete one.
 */
const CAPS = {
  stackFrames: 20,
  assetChanges: 40,
  balanceChanges: 20,
  stateEntries: 30,
  consoleLogs: 40,
} as const;

/**
 * The omission note for a capped section, or nothing when nothing was dropped.
 *
 * Deliberately does not name an argument: unlike the call-trace caps, these
 * sections have no knob to raise, and pointing at a lever that does not exist
 * is worse than stating the limit plainly.
 */
function omitted(total: number, shown: number, unit: string): string | undefined {
  if (total <= shown) return undefined;
  return `… ${String(total - shown)} more ${unit} not shown (limit ${String(shown)}).`;
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/**
 * True when a nullable API string carries actual content.
 *
 * Tenderly returns absent strings three different ways — missing, `null`, and
 * `""` — often for the same field across different responses. Collapsing that
 * into one predicate keeps every call site honest about meaning "has a value"
 * rather than spelling out the same three comparisons a dozen times.
 */
function present(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== '';
}

/**
 * Parses a Tenderly numeric field, which may be decimal or hex.
 *
 * The API is not consistent about this: `value` comes back as `"0x"` for a
 * zero-value call while `gas_used` is a decimal number, and both appear on the
 * same object. `BigInt("0x")` throws, so bare `0x` is normalised to zero.
 */
function toBigInt(value: string | number | null | undefined): bigint | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number')
    return Number.isFinite(value) ? BigInt(Math.trunc(value)) : undefined;
  const raw = value.trim();
  if (raw === '' || raw.toLowerCase() === '0x') return 0n;
  try {
    return BigInt(raw);
  } catch {
    return undefined;
  }
}

/**
 * Neutralises a string that originated from chain data before it is rendered
 * into model context.
 *
 * This is a security boundary, not cosmetics. Every contract name, token
 * symbol, function name, decoded string, source line and revert reason in a
 * simulation is controlled by whoever deployed the contract — and the entire
 * point of this server is pointing it at contracts the user does not trust yet.
 * A contract can `revert()` with any string it likes, so an attacker can put
 * arbitrary text into the most prominent position in the output: the revert
 * reason at the top of the failure section.
 *
 * The defence is structural rather than semantic. Trying to *detect* injection
 * is whack-a-mole; instead untrusted text is made unable to escape the single
 * line and field it belongs to. Collapsing all whitespace removes the newlines
 * needed to forge a `##` heading or a list item, stripping bidi and zero-width
 * characters removes the trojan-source trick of hiding content from a human
 * reviewer, and the length cap stops a multi-kilobyte revert string flooding
 * the context.
 */
/**
 * Drops characters that let text hide or misrepresent itself: C0/C1 controls,
 * zero-width joiners and spaces, and the bidi overrides behind trojan-source
 * style attacks. Controls become spaces so the caller's whitespace collapsing
 * folds them away uniformly.
 *
 * Written as a code-point scan rather than a regex because the interesting
 * characters are exactly the ones a regex literal cannot hold legibly.
 */
function stripInvisible(value: string): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      out += ' ';
      continue;
    }
    const zeroWidth = cp >= 0x200b && cp <= 0x200f;
    const bidiOverride = cp >= 0x202a && cp <= 0x202e;
    const invisibleMath = cp >= 0x2060 && cp <= 0x2064;
    const bidiIsolate = cp >= 0x2066 && cp <= 0x2069;
    if (zeroWidth || bidiOverride || invisibleMath || bidiIsolate || cp === 0xfeff) continue;
    out += ch;
  }
  return out;
}

function untrusted(value: string, maxLength = 200): string {
  const flattened = stripInvisible(value).replace(/\s+/g, ' ').trim();
  if (flattened === '') return '';
  if (flattened.length <= maxLength) return flattened;
  return `${flattened.slice(0, maxLength)}… (truncated from ${String(flattened.length)} chars)`;
}

/** First argument that is a non-empty string, else null. */
function firstPresent(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (present(value)) return value;
  }
  return null;
}

function num(value: string | number | null | undefined): number | undefined {
  const big = toBigInt(value);
  if (big === undefined) return undefined;
  const n = Number(big);
  return Number.isFinite(n) ? n : undefined;
}

/** True when an amount is absent or parses to zero, in any of its spellings. */
function isZeroAmount(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return toBigInt(value) === 0n;
}

/**
 * Tenderly reports the int64 maximum as the gas limit when the caller did not
 * set one, and as `gas` on proxy fallback frames. Rendering that as a real
 * limit ("30,728 of 9,223,372,036,854,776,000") is worse than saying nothing,
 * so anything above any plausible block gas limit is treated as absent.
 */
const GAS_SENTINEL_FLOOR = 1_000_000_000;

function realGas(value: string | number | null | undefined): number | undefined {
  const n = num(value);
  return n === undefined || n >= GAS_SENTINEL_FLOOR ? undefined : n;
}

/**
 * A gas *limit* of zero means "none was recorded", so it must be suppressed
 * rather than rendered as "of 0 limit". Zero is left meaningful for gas *used*,
 * where a frame genuinely can consume none.
 */
function realGasLimit(value: string | number | null | undefined): number | undefined {
  const n = realGas(value);
  return n === undefined || n <= 0 ? undefined : n;
}

function withThousands(value: string | number | null | undefined): string {
  const n = num(value);
  return n === undefined ? 'unknown' : n.toLocaleString('en-US');
}

/** Formats a wei amount as a decimal string, trimming trailing zeros. */
export function formatUnits(raw: string | number | null | undefined, decimals = 18): string {
  const value = toBigInt(raw);
  if (value === undefined) return String(raw);
  if (decimals <= 0) return value.toString();

  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');

  return `${negative ? '-' : ''}${whole.toString()}${fraction === '' ? '' : `.${fraction}`}`;
}

/** Shortens a long hex blob to head and tail, noting the elided byte count. */
function shortHex(hex: string, keep = 10): string {
  if (hex.length <= keep * 2 + 12) return hex;
  const elided = Math.floor((hex.length - keep * 2 - 2) / 2);
  return `${hex.slice(0, keep + 2)}…${hex.slice(-keep)} (${String(elided)} bytes elided)`;
}

function shortAddress(address: string | null | undefined): string {
  if (!present(address)) return 'unknown';
  return address.length > 12 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

/** Renders a decoded Solidity value, bounding depth so nested structs cannot blow up. */
export function renderSolValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') {
    // A 20-byte address is the most common decoded argument and the one most
    // often compared by eye, so it gets the compact form rather than the
    // byte-count note that suits an opaque blob.
    if (/^0x[0-9a-fA-F]{40}$/.test(value)) return shortAddress(value);
    if (value.startsWith('0x') && value.length > 24) return shortHex(value);
    // A decoded string is contract-controlled: a token's name() can return
    // anything at all, including a forged instruction block.
    return untrusted(value, 120);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (depth >= 3) return Array.isArray(value) ? '[…]' : '{…}';
  if (Array.isArray(value)) {
    const shown = value.slice(0, 8).map((v) => renderSolValue(v, depth + 1));
    if (value.length > 8) shown.push(`… ${String(value.length - 8)} more`);
    return `[${shown.join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 8);
    return `{${entries.map(([k, v]) => `${k}: ${renderSolValue(v, depth + 1)}`).join(', ')}}`;
  }
  // Only symbols and functions remain, neither of which can occur in JSON.
  return '<unrenderable>';
}

/** Renders a decoded argument list as `name=value, …`. */
function renderArgs(args: SolValue[] | null | undefined): string {
  if (args === null || args === undefined || args.length === 0) return '';
  return args
    .map((arg, index) => {
      const name = arg.soltype?.name;
      const label = name !== undefined && name !== '' ? untrusted(name, 48) : `arg${String(index)}`;
      return `${label}=${renderSolValue(arg.value)}`;
    })
    .join(', ');
}

/** Index of address to a display label, so traces name contracts not hex. */
function buildContractLabels(
  contracts: TenderlyContract[] | null | undefined
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const contract of contracts ?? []) {
    const address = contract.address;
    if (!present(address)) continue;
    const symbol = contract.token_data?.symbol;
    const name = contract.contract_name;
    const label = present(name)
      ? present(symbol) && symbol !== name
        ? `${untrusted(name, 48)} (${untrusted(symbol, 24)})`
        : untrusted(name, 48)
      : undefined;
    if (label !== undefined) labels.set(address.toLowerCase(), label);
  }
  return labels;
}

function labelFor(address: string | null | undefined, labels: Map<string, string>): string {
  if (!present(address)) return 'unknown';
  const label = labels.get(address.toLowerCase());
  return label !== undefined ? `${label} [${shortAddress(address)}]` : shortAddress(address);
}

// ---------------------------------------------------------------------------
// call trace
// ---------------------------------------------------------------------------

/**
 * Frames that are storage or log opcodes rather than calls.
 *
 * A `simulation_type: "full"` trace interleaves these with real calls — a
 * plain USDC transfer produces a dozen SLOADs against four actual calls, and a
 * DeFi transaction produces hundreds. Left in, they consume the node budget and
 * push the frames that explain a revert out of the output entirely. JUMPDEST is
 * deliberately *not* here: it marks an internal Solidity function call, which
 * is exactly what you want when tracing a revert through a library.
 */
const OPCODE_FRAMES = new Set(['SLOAD', 'SSTORE', 'LOG0', 'LOG1', 'LOG2', 'LOG3', 'LOG4']);

function isOpcodeFrame(node: CallTraceNode): boolean {
  const op = node.call_type ?? node.caller_op;
  return present(op) && OPCODE_FRAMES.has(op);
}

/**
 * Drops opcode frames, lifting any children into the parent's position so a
 * pruned frame never takes a real call down with it.
 */
function pruneOpcodeFrames(node: CallTraceNode): { node: CallTraceNode; pruned: number } {
  let pruned = 0;
  const keep: CallTraceNode[] = [];

  for (const child of node.calls ?? []) {
    const result = pruneOpcodeFrames(child);
    pruned += result.pruned;
    if (isOpcodeFrame(child)) {
      pruned += 1;
      keep.push(...(result.node.calls ?? []));
    } else {
      keep.push(result.node);
    }
  }

  return { node: { ...node, calls: keep.length > 0 ? keep : null }, pruned };
}

function countNodes(node: CallTraceNode | null | undefined): number {
  if (node === null || node === undefined) return 0;
  let total = 1;
  for (const child of node.calls ?? []) total += countNodes(child);
  return total;
}

/**
 * Renders the call tree as an indented ASCII tree.
 *
 * Bounded on two axes because the two failure modes differ: a deep recursive
 * proxy chain blows the depth budget, while a batch settlement blows the node
 * budget. Both caps are reported in the returned notes.
 */
export function formatCallTrace(
  root: CallTraceNode | null | undefined,
  labels: Map<string, string>,
  options: { maxNodes: number; maxDepth: number; includeOpcodeFrames?: boolean | undefined }
): { text: string; notes: string[] } {
  if (root === null || root === undefined) {
    return { text: '(no call trace in this response)', notes: [] };
  }

  const notes: string[] = [];
  let tree = root;
  if (options.includeOpcodeFrames !== true) {
    const { node, pruned } = pruneOpcodeFrames(root);
    tree = node;
    if (pruned > 0) {
      notes.push(`(${String(pruned)} opcode frames hidden; include_opcode_frames=true shows them)`);
    }
  }

  const total = countNodes(tree);
  const lines: string[] = [];
  let rendered = 0;
  let depthTruncations = 0;

  const walk = (
    node: CallTraceNode,
    prefix: string,
    isLast: boolean,
    depth: number,
    parentTo?: string
  ): void => {
    if (rendered >= options.maxNodes) return;
    rendered++;

    const connector = depth === 0 ? '' : isLast ? '└─ ' : '├─ ';
    const op = firstPresent(node.call_type, node.caller_op) ?? 'CALL';
    // An internal frame stays inside its caller's contract, so re-printing that
    // contract's label on every one is noise — on a real proxy it repeats the
    // same 40 characters for most of the trace. The address is always visible
    // one ancestor up.
    const sameContract =
      present(node.to) && present(parentTo) && node.to.toLowerCase() === parentTo.toLowerCase();
    const target = sameContract ? '' : labelFor(node.to, labels);
    const dot = target === '' ? '' : '.';
    const fn = node.function_name;
    const args = renderArgs(node.decoded_input);

    const callee = present(fn)
      ? `${target}${dot}${untrusted(fn, 64)}(${args})`
      : // Unverified contract: the selector is all we have, and it is still
        // enough for a human to look up in 4byte.directory.
        present(node.input) && node.input.length >= 10
        ? `${target}${dot}<${node.input.slice(0, 10)}>`
        : target;

    const bits: string[] = [];
    const gasUsed = realGas(node.gas_used);
    if (gasUsed !== undefined) bits.push(`gas ${gasUsed.toLocaleString('en-US')}`);
    if (!isZeroAmount(node.value)) bits.push(`value ${formatUnits(node.value)}`);

    const failed = present(node.error);
    const marker = failed ? '✗ ' : '';
    const suffix = failed
      ? ` — ${untrusted(node.error_reason ?? node.error ?? 'reverted', 160)}`
      : '';
    const meta = bits.length > 0 ? ` · ${bits.join(' · ')}` : '';

    lines.push(`${prefix}${connector}${marker}${op} ${callee}${meta}${suffix}`);

    const children = node.calls ?? [];
    if (children.length === 0) return;

    if (depth + 1 > options.maxDepth) {
      depthTruncations += countNodes(node) - 1;
      const childPrefix = depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ');
      lines.push(`${childPrefix}└─ … ${String(children.length)} nested call(s) below depth limit`);
      return;
    }

    const childPrefix = depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ');
    children.forEach((child, index) => {
      walk(child, childPrefix, index === children.length - 1, depth + 1, node.to ?? undefined);
    });
  };

  walk(tree, '', true, 0);

  if (rendered < total - depthTruncations) {
    notes.push(
      `(showed ${String(rendered)} of ${String(total)} frames; raise max_trace_nodes for more)`
    );
  }
  if (depthTruncations > 0) {
    notes.push(
      `(${String(depthTruncations)} frames below depth ${String(options.maxDepth)} omitted; raise max_trace_depth)`
    );
  }

  return { text: lines.join('\n'), notes };
}

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

function formatLogs(
  logs: TenderlyLog[] | null | undefined,
  labels: Map<string, string>,
  maxLogs: number
): string[] {
  const all = logs ?? [];
  if (all.length === 0) return [];

  const out: string[] = [`## Events (${String(all.length)})`];
  for (const [index, log] of all.slice(0, maxLogs).entries()) {
    const name = log.name;
    const emitter = labelFor(log.raw?.address, labels);
    if (present(name)) {
      out.push(
        `${String(index + 1)}. ${untrusted(name, 64)}(${renderArgs(log.inputs)}) — from ${emitter}`
      );
    } else {
      // Unverified emitter: topic0 is the event signature hash, which is still
      // resolvable by hand, so it beats reporting nothing.
      const topic0 = log.raw?.topics?.[0] ?? 'unknown';
      out.push(`${String(index + 1)}. <undecoded> topic0=${topic0} — from ${emitter}`);
    }
  }
  const eventsNote = omitted(all.length, maxLogs, 'event(s)');
  if (eventsNote !== undefined) out.push(eventsNote);
  return out;
}

function formatStackTrace(frames: StackFrame[] | null | undefined): string[] {
  const all = frames ?? [];
  if (all.length === 0) return [];

  const out: string[] = ['## Source-mapped revert trace'];
  for (const [index, frame] of all.slice(0, CAPS.stackFrames).entries()) {
    const where = untrusted(present(frame.name) ? frame.name : (frame.contract ?? 'unknown'), 64);
    const line = frame.line !== null && frame.line !== undefined ? `:${String(frame.line)}` : '';
    const code = frame.code;
    const reason = frame.error_reason ?? frame.error;
    out.push(
      `${String(index + 1)}. ${where}${line}` +
        (present(frame.op) ? ` [${frame.op}]` : '') +
        (present(reason) ? ` — ${untrusted(reason, 160)}` : '')
    );
    if (present(code) && code.trim() !== '') {
      out.push(`   ${untrusted(code, 200)}`);
    }
  }
  const framesNote = omitted(all.length, CAPS.stackFrames, 'frame(s)');
  if (framesNote !== undefined) out.push(framesNote);
  return out;
}

function formatAssetChanges(response: SimulateResponse, networkId: string): string[] {
  const info = response.transaction?.transaction_info;
  const changes = info?.asset_changes ?? [];
  const balances = info?.balance_diff ?? [];
  const out: string[] = [];

  if (changes.length > 0) {
    out.push(`## Asset transfers (${String(changes.length)})`);
    for (const change of changes.slice(0, CAPS.assetChanges)) {
      const token = change.token_info;
      const symbol = untrusted(token?.symbol ?? token?.name ?? 'token', 24);
      const decimals = token?.decimals ?? 18;
      const raw = change.raw_amount ?? change.amount;
      const amount =
        change.raw_amount !== null && change.raw_amount !== undefined
          ? formatUnits(change.raw_amount, decimals)
          : String(raw ?? '?');
      out.push(
        `- ${untrusted(change.type ?? 'Transfer', 32)} ${amount} ${symbol}: ${shortAddress(change.from)} → ${shortAddress(change.to)}`
      );
    }
    const transfersNote = omitted(changes.length, CAPS.assetChanges, 'transfer(s)');
    if (transfersNote !== undefined) out.push(transfersNote);
  }

  const moved = balances.filter((b) => String(b.original ?? '0') !== String(b.dirty ?? '0'));
  if (moved.length > 0) {
    const symbol = nativeSymbol(networkId);
    out.push(`## Native balance changes (${symbol})`);
    for (const diff of moved.slice(0, CAPS.balanceChanges)) {
      let delta = '?';
      try {
        const before = BigInt(String(diff.original ?? '0'));
        const after = BigInt(String(diff.dirty ?? '0'));
        const change = after - before;
        delta = `${change > 0n ? '+' : ''}${formatUnits(change.toString())}`;
      } catch {
        delta = `${String(diff.original ?? '?')} → ${String(diff.dirty ?? '?')}`;
      }
      out.push(`- ${shortAddress(diff.address)}: ${delta} ${symbol}`);
    }
    const balanceNote = omitted(moved.length, CAPS.balanceChanges, 'address(es)');
    if (balanceNote !== undefined) out.push(balanceNote);
  }

  return out;
}

function formatStateDiff(response: SimulateResponse): string[] {
  const diffs = response.transaction?.transaction_info?.state_diff ?? [];
  if (diffs.length === 0) return [];

  const out: string[] = [`## Storage state diff (${String(diffs.length)} entries)`];
  for (const diff of diffs.slice(0, CAPS.stateEntries)) {
    const name = diff.soltype?.name;
    const label = present(name) ? untrusted(name, 48) : 'slot';
    out.push(
      `- ${shortAddress(diff.address)} ${label}: ${renderSolValue(diff.original)} → ${renderSolValue(diff.dirty)}`
    );
  }
  const stateNote = omitted(diffs.length, CAPS.stateEntries, 'state entries');
  if (stateNote !== undefined) out.push(stateNote);
  return out;
}

function formatConsoleLogs(response: SimulateResponse): string[] {
  const logs = response.transaction?.transaction_info?.console_logs ?? [];
  if (logs.length === 0) return [];
  const out: string[] = [`## console.log output (${String(logs.length)})`];
  for (const log of logs.slice(0, CAPS.consoleLogs)) {
    const args = renderArgs(log.decoded_input);
    out.push(`- ${args === '' ? renderSolValue(log.raw) : args}`);
  }
  const consoleNote = omitted(logs.length, CAPS.consoleLogs, 'line(s)');
  if (consoleNote !== undefined) out.push(consoleNote);
  return out;
}

// ---------------------------------------------------------------------------
// top level
// ---------------------------------------------------------------------------

/** Machine-readable digest, returned alongside the text as `structuredContent`. */
export interface SimulationDigest {
  status: 'success' | 'reverted' | 'unknown';
  simulation_id: string | null;
  network_id: string | null;
  block_number: number | null;
  gas_used: number | null;
  gas_limit: number | null;
  method: string | null;
  error_message: string | null;
  revert_reason: string | null;
  event_count: number;
  dashboard_url: string | null;
}

/** `untrusted`, preserving null for a field that carries no value. */
function sanitiseOrNull(value: string | null | undefined, maxLength: number): string | null {
  if (!present(value)) return null;
  const clean = untrusted(value, maxLength);
  return clean === '' ? null : clean;
}

export function buildDigest(response: SimulateResponse, config: Config): SimulationDigest {
  const tx = response.transaction;
  const sim = response.simulation;
  const info = tx?.transaction_info;

  const status = tx?.status ?? sim?.status;
  const simulationId = sim?.id ?? null;
  const errorMessage =
    tx?.error_message ?? sim?.error_message ?? tx?.error_info?.error_message ?? null;

  const revertReason =
    info?.stack_trace?.find(
      (f) => f.error_reason !== null && f.error_reason !== undefined && f.error_reason !== ''
    )?.error_reason ?? null;

  return {
    status: status === true ? 'success' : status === false ? 'reverted' : 'unknown',
    simulation_id: simulationId,
    network_id: tx?.network_id ?? sim?.network_id ?? null,
    block_number: tx?.block_number ?? sim?.block_number ?? null,
    gas_used: num(tx?.gas_used ?? sim?.gas_used ?? info?.gas_used) ?? null,
    gas_limit: realGasLimit(tx?.gas ?? sim?.gas) ?? null,
    method: sanitiseOrNull(firstPresent(tx?.method, sim?.method, info?.method), 64),
    error_message: sanitiseOrNull(errorMessage, 240),
    revert_reason: sanitiseOrNull(revertReason, 240),
    event_count: (info?.logs ?? []).length,
    dashboard_url: simulationId !== null ? simulationUrl(config, simulationId) : null,
  };
}

/**
 * Renders a full simulation as the text a tool returns.
 *
 * Ordering is by debugging value, not by the shape of the source payload:
 * outcome, then why it failed, then what it emitted, then how it got there.
 */
export function formatSimulation(
  response: SimulateResponse,
  config: Config,
  options: FormatOptions = {},
  heading?: string
): string {
  const opts = withDefaults(options);
  const tx = response.transaction;
  const sim = response.simulation;
  const info = tx?.transaction_info;
  const digest = buildDigest(response, config);
  const labels = buildContractLabels(response.contracts);
  const networkId = digest.network_id ?? '1';

  const sections: string[] = [];
  const icon = digest.status === 'success' ? '✅' : digest.status === 'reverted' ? '❌' : '❔';
  sections.push(`# ${heading ?? 'Simulation'}: ${digest.status.toUpperCase()} ${icon}`);

  // --- overview ---
  const overview: string[] = [];
  overview.push(`- Network: ${describeNetwork(networkId)}`);
  if (digest.block_number !== null) overview.push(`- Block: ${withThousands(digest.block_number)}`);
  if (tx?.from !== undefined) overview.push(`- From: ${labelFor(tx.from, labels)}`);
  const to = tx?.to ?? sim?.to;
  overview.push(present(to) ? `- To: ${labelFor(to, labels)}` : '- To: (contract creation)');
  if (digest.method !== null) overview.push(`- Method: ${digest.method}`);
  if (digest.gas_used !== null) {
    const limit = digest.gas_limit;
    overview.push(
      `- Gas used: ${withThousands(digest.gas_used)}${limit !== null ? ` of ${withThousands(limit)} limit` : ''}`
    );
  }
  const value = tx?.value ?? sim?.value;
  if (!isZeroAmount(value)) {
    overview.push(`- Value: ${formatUnits(value)} ${nativeSymbol(networkId)}`);
  }
  if (digest.simulation_id !== null) overview.push(`- Simulation ID: ${digest.simulation_id}`);
  if (digest.dashboard_url !== null) overview.push(`- Dashboard: ${digest.dashboard_url}`);
  sections.push(overview.join('\n'));

  // --- failure detail, ahead of everything else when it exists ---
  if (digest.status === 'reverted' || digest.error_message !== null) {
    const failure: string[] = ['## Failure'];
    if (digest.error_message !== null) failure.push(`- Error: ${digest.error_message}`);
    // In practice these are usually the same string; printing it twice is pure cost.
    if (digest.revert_reason !== null && digest.revert_reason !== digest.error_message) {
      failure.push(`- Revert reason: ${digest.revert_reason}`);
    }
    const failingFrame = findFailingCall(info?.call_trace ?? null);
    if (failingFrame !== null) {
      failure.push(
        `- Failing call: ${labelFor(failingFrame.to, labels)}.${untrusted(failingFrame.function_name ?? '<unknown>', 64)} — ${untrusted(failingFrame.error_reason ?? failingFrame.error ?? 'reverted', 160)}`
      );
    }
    if (digest.error_message === null && digest.revert_reason === null) {
      failure.push(
        '- No revert string was returned. This usually means a custom error, an out-of-gas, or an unverified contract; the call trace below shows the frame that failed.'
      );
    }
    sections.push(failure.join('\n'));
  }

  const stack = formatStackTrace(info?.stack_trace);
  if (stack.length > 0) sections.push(stack.join('\n'));

  const consoleLogs = formatConsoleLogs(response);
  if (consoleLogs.length > 0) sections.push(consoleLogs.join('\n'));

  const logs = formatLogs(info?.logs, labels, opts.maxLogs);
  if (logs.length > 0) sections.push(logs.join('\n'));

  if (opts.includeAssetChanges) {
    const assets = formatAssetChanges(response, networkId);
    if (assets.length > 0) sections.push(assets.join('\n'));
  }

  if (opts.includeCallTrace) {
    const trace = formatCallTrace(info?.call_trace ?? null, labels, {
      maxNodes: opts.maxTraceNodes,
      maxDepth: opts.maxTraceDepth,
      includeOpcodeFrames: opts.includeOpcodeFrames,
    });
    sections.push(['## Call trace', '```', trace.text, '```', ...trace.notes].join('\n'));
  }

  if (opts.includeStateDiff) {
    const diff = formatStateDiff(response);
    if (diff.length > 0) sections.push(diff.join('\n'));
  }

  // A response with neither a transaction nor a simulation block means the
  // request succeeded but returned something unrecognised — say so plainly
  // rather than emitting a confident-looking empty digest.
  if (tx === null || tx === undefined) {
    sections.push(
      '## Note\nThis response carried no execution detail, so there is no call trace, no events and no state diff — only the fields above. ' +
        'For a saved simulation that is expected: Tenderly stores metadata without the trace. Otherwise, re-run with include_raw_response=true to inspect what was returned.'
    );
  }

  return sections.join('\n\n');
}

/** Depth-first search for the deepest frame carrying an error — the true culprit. */
export function findFailingCall(node: CallTraceNode | null | undefined): CallTraceNode | null {
  if (node === null || node === undefined) return null;
  for (const child of node.calls ?? []) {
    const deeper = findFailingCall(child);
    if (deeper !== null) return deeper;
  }
  const failed = node.error !== null && node.error !== undefined && node.error !== '';
  return failed ? node : null;
}

/** One-line summary, for list views where a full digest is too much. */
export function formatSimulationLine(response: SimulateResponse, config: Config): string {
  const d = buildDigest(response, config);
  const bits = [
    d.status === 'success' ? '✅' : d.status === 'reverted' ? '❌' : '❔',
    d.simulation_id ?? '(unsaved)',
    describeNetwork(d.network_id ?? '1'),
    d.method ?? '(unknown method)',
    d.gas_used !== null ? `gas ${withThousands(d.gas_used)}` : '',
    d.error_message ?? '',
  ].filter((s) => s !== '');
  return `- ${bits.join(' · ')}`;
}
