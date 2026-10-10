import { daemon, type World } from './helpers.js';

export interface Res {
  status: number;
  body: any;
  headers: Headers;
}

/** A console daemon plus a fetch helper. */
export async function consoleDaemon(o: Parameters<typeof daemon>[0] = {}): Promise<World & { url: string; api(path: string, init?: RequestInit & { token?: string | null; json?: unknown }): Promise<Res> }> {
  const w = await daemon({ console: true, ...o });
  const url = w.gw.console!.url;
  const api = async (path: string, init: RequestInit & { token?: string | null; json?: unknown } = {}): Promise<Res> => {
    const { token, json, ...rest } = init;
    const headers = new Headers(rest.headers);
    const t = token === undefined ? w.gw.token : token;
    if (t !== null) headers.set('Authorization', `Bearer ${t}`);
    if (json !== undefined) headers.set('Content-Type', 'application/json');
    const r = await fetch(url + path, { ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined, headers: r.headers };
  };
  return { ...w, url, api };
}

/** Raw HTTP/1.1 (fetch cannot set Host or Origin freely). */
export async function rawGet(url: string, path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  const { request } = await import('node:http');
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method: headers.method ?? 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}
