export interface QuoteSplit {
  body: string;
  quoted: string;
}

const MARKERS: RegExp[] = [
  /^-{2,}\s*(original message|forwarded message|原始邮件)\s*-{2,}\s*$/i,
  /^_{10,}\s*$/,
  /^on .{5,}wrote:\s*$/i,
  /^le .{5,}a écrit\s*:\s*$/i,
  /^am .{5,}schrieb .*:\s*$/i,
  /^.{3,}(写道|寫道)[:：]\s*$/,
];

/** Splits a plain-text mail body into the new content and the quoted reply history. */
export function splitQuote(text: string): QuoteSplit {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const next = lines[i + 1] ?? '';
    if (line.startsWith('>')) {
      cut = i;
      break;
    }
    if (MARKERS.some((m) => m.test(line.trim()))) {
      cut = i;
      break;
    }
    // "On Mon, 1 Jan 2026 at 10:00, Alice <a@x> \n wrote:" wrapped over two lines
    if (/^on .{5,}/i.test(line.trim()) && /^wrote:\s*$/i.test(next.trim()) ) {
      cut = i;
      break;
    }
    // Outlook style header block: From: / Sent: (or Date:) / To: / Subject:
    if (/^from:\s/i.test(line) && /^(sent|date):\s/i.test(next)) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return { body: text.trim(), quoted: '' };
  const body = lines.slice(0, cut).join('\n').trim();
  const quoted = lines.slice(cut).join('\n').trim();
  // A mail that is entirely quoted (top of file) keeps its text rather than becoming empty.
  if (!body) return { body: text.trim(), quoted: '' };
  return { body, quoted };
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n[... truncated ${s.length - max} chars]`;
}
