import { authenticate, type AuthenticateResult } from 'mailauth';
import type { AuthVerdict, MailVerifier } from './types.js';

/**
 * Maps a mailauth result to evidence. `dkim_pass` requires a DKIM signature that
 * passes and is aligned with the From domain (via DMARC alignment, or a passing
 * signature flagged aligned for that domain). SPF alone never yields `dkim_pass`.
 */
export function verdictFromAuth(res: Pick<AuthenticateResult, 'dkim' | 'dmarc'>, fromDomain: string): AuthVerdict {
  const domain = fromDomain.toLowerCase();
  const headerFrom = res.dkim.headerFrom.map((d) => d.toLowerCase());
  if (headerFrom.length > 0 && !headerFrom.every((d) => d === domain)) {
    return { evidence: 'none', detail: 'from domain mismatch' };
  }
  const dmarc = res.dmarc;
  if (dmarc && dmarc.alignment.dkim.result === 'pass') {
    return { evidence: 'dkim_pass', detail: `dmarc dkim aligned (${dmarc.domain})` };
  }
  for (const r of res.dkim.results) {
    if (r.status.result === 'pass' && r.status.aligned && r.signingDomain.toLowerCase() === domain) {
      return { evidence: 'dkim_pass', detail: `dkim ${r.signingDomain}` };
    }
  }
  return { evidence: 'none', detail: dmarc ? `dmarc ${dmarc.status.result}` : 'no dmarc' };
}

/** Default verifier: DKIM/SPF/DMARC on the raw message. DNS errors degrade to `none`. */
export const mailauthVerifier: MailVerifier = async (raw, fromDomain) => {
  try {
    const res = await authenticate(raw, { trustReceived: true });
    return verdictFromAuth(res, fromDomain);
  } catch (err) {
    return { evidence: 'none', detail: `verify error: ${String(err)}` };
  }
};
