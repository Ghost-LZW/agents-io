import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Options } from './types.js';

/**
 * First-byte watchdog default (ms). Measured 2026-10 behind a gateway: Claude's first byte is
 * normally 2–8 s, a cold prompt cache brings the slow tail to ~20 s (p90), a session's first turn
 * also waits for the CLI and its MCP servers to start. 30 s stays clear of all of that and still
 * ends a hung request long before `API_TIMEOUT_MS` (10 min by default) would.
 */
export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 30_000;

/**
 * What the watchdog writes after the switch when the interrupted attempt already holds the turn's
 * inputs: Claude Code keeps them in its history, followed by "[Request interrupted by user]" (and the
 * `/model` command's record), so they are not written again; this short message makes the new model
 * answer them, and says the interruption was not the user's.
 */
export const WATCHDOG_CONTINUE =
  '[agents-io] That interruption was automatic, not the user: no reply came in time, so the model was switched. Please answer the message above.';

/**
 * Idle deadline default (ms, HC-3b): within a turn that has had output, this long with no CLI
 * message at all (no stream, no tool event, no status) while it waits on the model ends the wait.
 * 90 s, a common stream idle deadline, is the starting value.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

/**
 * What the idle deadline writes after a model switch: the turn so far (inputs, tool calls and their
 * results) is in Claude Code's history; the new model goes on from there and runs nothing again.
 */
export const IDLE_CONTINUE =
  '[agents-io] That interruption was automatic, not the user: the model stopped responding mid-turn, so it was switched. The tool calls above already ran: use their results and do not run them again. Please go on from where it stopped.';

/**
 * Said in the conversation when the idle deadline ends a turn (a tool that may have changed
 * something already ran, or no fallback model took over). `{seconds}`: the deadline; `{tools}`:
 * the tools that ran (comma-separated, `-` when none).
 */
export const DEFAULT_STALL_NOTICE =
  '(This turn stopped: the model sent nothing for {seconds} s. What already ran ({tools}) is not run again; say so if it should go on.)';

/**
 * Tools that only read (Claude Code's built-ins): a turn that ran only these can go on on another
 * model after a stall. Any other tool (Bash, edits, MCP tools, subagents…) counts as a side effect.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);

/** Where the watchdog finds the fallback chain: what `open` gives the CLI. */
export interface FallbackSources {
  /** SDK `fallbackModel` (the CLI's `--fallback-model`, comma-separated). */
  sdkFallbackModel?: string;
  /** `extraArgs['fallback-model']`. */
  extraArgFallbackModel?: string | null;
  /** SDK `settings` (flag layer): a path, a JSON string, or an object. */
  settings?: Options['settings'];
  /** SDK `settingSources` (omitted = all three). */
  settingSources?: Options['settingSources'];
  cwd: string;
  /** The CLI's CLAUDE_CONFIG_DIR (default `$HOME/.claude`). */
  configDir?: string;
  home?: string;
}

/** `fallbackModel` as Claude Code takes it: an array, or a comma-separated string. `undefined` when not set. */
export function chainOf(v: unknown): string[] | undefined {
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean);
  return undefined;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // missing or not JSON: this layer sets nothing
  }
}

function flagSettings(s: Options['settings']): Record<string, unknown> | undefined {
  if (s === undefined || s === null) return undefined;
  if (typeof s === 'object') return s as Record<string, unknown>;
  const t = s.trim();
  if (t.startsWith('{')) {
    try {
      return JSON.parse(t) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return readJson(t);
}

/**
 * Claude Code's fallback chain for this session, read now (an agent may have edited its
 * settings.json): the first layer that sets `fallbackModel` owns it whole, in the CLI's order
 * (flag `--fallback-model`, flag settings, local, project, user). `[]` when none sets it, or
 * when the winning layer says `[]` (no fallback). Managed (policy) settings are not read.
 */
export function fallbackChain(src: FallbackSources): string[] {
  const flag = chainOf(src.sdkFallbackModel) ?? chainOf(src.extraArgFallbackModel ?? undefined);
  if (flag) return flag;
  const all = src.settingSources === undefined;
  const on = (k: 'user' | 'project' | 'local') => all || src.settingSources!.includes(k);
  const configDir = src.configDir ?? join(src.home ?? homedir(), '.claude');
  const layers: (() => Record<string, unknown> | undefined)[] = [
    () => flagSettings(src.settings),
    () => (on('local') ? readJson(join(src.cwd, '.claude', 'settings.local.json')) : undefined),
    () => (on('project') ? readJson(join(src.cwd, '.claude', 'settings.json')) : undefined),
    () => (on('user') ? readJson(join(configDir, 'settings.json')) : undefined),
  ];
  for (const layer of layers) {
    const chain = chainOf(layer()?.fallbackModel);
    if (chain) return chain;
  }
  return [];
}
