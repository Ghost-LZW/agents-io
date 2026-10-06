import { CHANNEL_ID } from '../inbound.js';
import type { LarkClientLike } from '../types.js';

export type OwnerResult = { ok: true; key: string; unionId: string } | { ok: false; reason: string };

/**
 * Resolve the scanner's open_id (only meaningful to the new app) to a union_id through that
 * app's own tenant token, and return the principal key `defaultPolicy({ owners })` matches:
 * `${channel}:${channelUserId}` where channelUserId is the union_id (see `senderId` in inbound.ts).
 *
 * There is deliberately no fallback: an open_id the app could not verify is never turned into an owner.
 */
export async function resolveOwner(client: Pick<LarkClientLike, 'request'>, openId: string): Promise<OwnerResult> {
  if (!openId?.startsWith('ou_')) return { ok: false, reason: 'not an open_id' };
  let res: { code?: number; msg?: string; data?: { user?: { union_id?: string; open_id?: string } } };
  try {
    res = (await client.request({
      method: 'GET',
      url: `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`,
      params: { user_id_type: 'open_id' },
    })) as typeof res;
  } catch (err) {
    const code = (err as { response?: { data?: { code?: number } } })?.response?.data?.code;
    return { ok: false, reason: `contact lookup failed${code ? ` (code ${code})` : ''}` };
  }
  if (res?.code) return { ok: false, reason: `contact lookup refused (code ${res.code}): ${res.msg ?? ''}`.trim() };
  const unionId = res?.data?.user?.union_id;
  if (!unionId) return { ok: false, reason: 'the app could not resolve a union_id for this open_id (contact scope granted and visible to the app?)' };
  return { ok: true, key: `${CHANNEL_ID}:${unionId}`, unionId };
}
