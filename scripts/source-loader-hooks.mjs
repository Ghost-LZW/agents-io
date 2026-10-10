// Resolve hooks for scripts/source-loader.mjs (they run on the loader thread).
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dirs = {
  protocol: 'packages/protocol',
  testkit: 'packages/testkit',
  session: 'packages/session',
  'host-mcp': 'packages/host-mcp',
  daemon: 'packages/daemon',
  'channel-jsonl-bridge': 'channel/jsonl-bridge',
  'channel-lark-bot': 'channel/lark-bot',
  'channel-mail': 'channel/mail',
  'harness-claude-code': 'harness/claude-code',
  'harness-codex': 'harness/codex',
};
let root = '';

export function initialize(data) {
  root = data?.root ?? root;
}

export async function resolve(specifier, context, next) {
  const pkg = /^@agents-io\/([^/]+)$/.exec(specifier)?.[1];
  if (pkg && dirs[pkg] && root) return next(new URL(`${dirs[pkg]}/src/index.ts`, pathToFileURL(root.endsWith('/') ? root : `${root}/`)).href, context);
  if (specifier.endsWith('.js') && (specifier.startsWith('.') || specifier.startsWith('file:')) && context.parentURL) {
    const url = new URL(specifier, context.parentURL);
    if (url.protocol === 'file:' && !existsSync(fileURLToPath(url))) {
      const ts = new URL(url.href.replace(/\.js$/, '.ts'));
      if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
  }
  return next(specifier, context);
}
