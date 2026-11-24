import type { BlobAccess } from '@agents-io/protocol';
import type { FileResolver, ImageResolver } from './types.js';

/**
 * Largest image handed to Claude inline. The Messages API refuses images over 5 MB
 * (base64), which would fail the whole turn, so larger ones are skipped with a notice.
 */
export const CLAUDE_IMAGE_MAX_BYTES = 3_750_000;

/**
 * Media from the host's blob store (`HarnessFactoryInit.blobs`): an image as a base64 block (up to
 * `CLAUDE_IMAGE_MAX_BYTES`), a file or audio as its local path (the agent reads it with its tools).
 * Refs the store does not hold (e.g. `lark-file:`) resolve to nothing.
 */
export function blobResolvers(blobs: BlobAccess): { resolveImage: ImageResolver; resolveFile: FileResolver } {
  return {
    resolveImage: async (ref) => {
      const st = await blobs.stat(ref);
      if (!st) return undefined;
      if (st.size > CLAUDE_IMAGE_MAX_BYTES) throw new Error(`image is ${st.size} bytes, over the ${CLAUDE_IMAGE_MAX_BYTES}-byte inline limit (file at ${st.path})`);
      const b = await blobs.get(ref);
      return { base64: Buffer.from(b.bytes.buffer, b.bytes.byteOffset, b.bytes.byteLength).toString('base64'), mime: b.mime };
    },
    resolveFile: async (ref) => {
      const st = await blobs.stat(ref);
      return st ? { path: st.path } : undefined;
    },
  };
}
