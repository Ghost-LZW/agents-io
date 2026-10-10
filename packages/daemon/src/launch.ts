import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { SessionLaunch } from '@agents-io/protocol';
import { VAR_NAME, type AgentConfig, type HarnessInstance } from './config.js';

/*
 * Session launches (decision 7, docs/design/session-launch): a host gives one
 * interactive session its own cwd and child env, within the bounds the agent's
 * `sessionParams` sets. Checked here, pinned with the session (DaemonRecords), and
 * applied by a per-session adapter (Gateway.lane).
 */

export type LaunchCheck = { ok: true; launch: SessionLaunch } | { ok: false; code: string; message: string };

/** What may be shown of a launch: its cwd and env keys, never values. */
export function launchView(l: SessionLaunch): { cwd?: string; envKeys: string[] } {
  return { ...(l.cwd !== undefined ? { cwd: l.cwd } : {}), envKeys: Object.keys(l.env ?? {}).sort() };
}

/** Same launch: cwd by realpath (the stored one already is), env as a whole table. */
export function sameLaunch(a: SessionLaunch, b: SessionLaunch): boolean {
  if ((a.cwd ?? null) !== (b.cwd ?? null)) return false;
  const ea = a.env ?? {};
  const eb = b.env ?? {};
  const ka = Object.keys(ea);
  return ka.length === Object.keys(eb).length && ka.every((k) => Object.prototype.hasOwnProperty.call(eb, k) && eb[k] === ea[k]);
}

/**
 * Check a launch against the agent's bounds and the instance that will run it;
 * the result carries the launch as it is pinned (cwd and path values by realpath,
 * an empty env left out).
 */
export function checkLaunch(agent: AgentConfig, launch: SessionLaunch, inst: HarnessInstance | undefined): LaunchCheck {
  const p = agent.sessionParams;
  if (!agent.configured || !p) return no('launch_not_allowed', `agent ${agent.name} takes no session launch (its config has no sessionParams)`);
  if (agent.mode !== 'interactive') return no('launch_not_allowed', `agent ${agent.name} is a task agent`);
  const out: SessionLaunch = {};
  if (launch.cwd !== undefined) {
    const r = underRoots(launch.cwd, p.cwdRoots);
    if (typeof r !== 'string') return no('bad_cwd', `cwd ${r.why}: ${launch.cwd}`);
    out.cwd = r;
  }
  const env = launch.env ?? {};
  const keys = Object.keys(env);
  if (keys.length) {
    const checked: Record<string, string> = {};
    for (const k of keys) {
      if (!VAR_NAME.test(k)) return no('bad_env', `${JSON.stringify(k)} is not an environment variable name`);
      if (k.startsWith('AGENTS_IO_')) return no('bad_env', `${k}: AGENTS_IO_* variables are the daemon's own`);
      if (!p.envKeys.includes(k)) return no('bad_env', `${k} is not in agent ${agent.name}'s sessionParams.envKeys`);
      const v = env[k];
      if (typeof v !== 'string') return no('bad_env', `${k}: value must be a string`);
      const roots = p.envPathRoots[k];
      if (roots) {
        const r = underRoots(v, roots);
        // The key only, never the value (SE-1): launch env values stay out of errors and logs.
        if (typeof r !== 'string') return no('bad_env', `${k} ${r.why}`);
        checked[k] = r;
      } else checked[k] = v;
    }
    // A Codex app-server on a Unix socket outlives the daemon and serves every session: no per-session env.
    if (inst?.kind === 'codex' && inst.codex.transport.kind === 'unix') return no('launch_unsupported', `harness instance ${inst.name} is a shared Codex app-server (unix transport); a session env cannot apply there (a cwd alone can)`);
    out.env = checked;
  }
  return { ok: true, launch: out };
}

/** The realpath of `p` when it is an absolute, existing directory under one of `roots` (also by realpath). `why` never contains `p`. */
function underRoots(p: string, roots: string[]): string | { why: string } {
  if (!isAbsolute(p)) return { why: 'must be absolute' };
  let real: string;
  try {
    real = realpathSync(p);
    if (!statSync(real).isDirectory()) return { why: 'is not a directory' };
  } catch {
    return { why: 'does not exist' };
  }
  for (const root of roots) {
    let r: string;
    try {
      r = realpathSync(root);
    } catch {
      continue;
    }
    const rel = relative(r, real);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return real;
  }
  return { why: 'is outside the allowed roots' };
}

function no(code: string, message: string): LaunchCheck {
  return { ok: false, code, message };
}
