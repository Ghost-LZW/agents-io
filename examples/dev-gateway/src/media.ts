import type { FsBlobStore } from '@agents-io/session';
import type { FileResolver, ImageResolver } from '@agents-io/harness-claude-code';
import type { MediaResolver } from '@agents-io/harness-codex';

/**
 * Largest image handed to Claude inline. The Messages API refuses images over 5 MB
 * (base64), which would fail the whole turn, so larger ones are skipped with a notice.
 */
export const CLAUDE_IMAGE_MAX_BYTES = 3_750_000;

export interface MediaResolvers {
  /** Claude Code: blob → base64 image block. */
  resolveImage: ImageResolver;
  /** Claude Code: blob → local path for files and audio (the agent reads it with its tools). */
  resolveFile: FileResolver;
  /** Codex: blob → local path (`localImage` / `localAudio`, or a path line for files). */
  resolveMedia: MediaResolver;
}

/** Harness media resolution backed by the gateway's blob store. Refs it does not hold (e.g. `lark-file:`) resolve to nothing. */
export function blobResolvers(store: FsBlobStore): MediaResolvers {
  return {
    resolveImage: async (ref) => {
      const st = await store.stat(ref);
      if (!st) return undefined;
      if (st.size > CLAUDE_IMAGE_MAX_BYTES) throw new Error(`image is ${st.size} bytes, over the ${CLAUDE_IMAGE_MAX_BYTES}-byte inline limit (file at ${st.path})`);
      const b = await store.get(ref);
      return { base64: Buffer.from(b.bytes.buffer, b.bytes.byteOffset, b.bytes.byteLength).toString('base64'), mime: b.mime };
    },
    resolveFile: async (ref) => {
      const st = await store.stat(ref);
      return st ? { path: st.path } : undefined;
    },
    resolveMedia: async (block) => {
      const st = await store.stat(block.ref);
      return st ? { path: st.path } : null;
    },
  };
}
