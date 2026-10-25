import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHarness, fakeEnvelope } from '@agents-io/testkit';
import type { InputRecord, Origin } from '@agents-io/protocol';
import {
  Hub,
  Ingress,
  Lane,
  MemorySessionLog,
  Router,
  SqliteSessionLog,
  TOPIC_TOOLS_HINT,
  TopicError,
  TopicRegistry,
  defaultBindings,
  defaultPolicy,
  ownersTable,
  type AgentSpec,
  type IngressOptions,
  type SessionPolicy,
} from '../src/index.js';
import { RUN, bodies, until } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDb = () => {
  const d = mkdtempSync(join(tmpdir(), 'aio-topics-'));
  dirs.push(d);
  return join(d, 'log.sqlite');
};

const CONV = 'fake:default:c1';
const key = ({ topicId, first }: { topicId: string; first: boolean }) => (first ? CONV : `${CONV}#${topicId}`);
let ids = 0;
const newId = () => `tp_${++ids}`;

// Moved from topics.test.ts: feature-path tests with no promise in docs/INVARIANTS.md (decision 14: local tier).

describe('topic-titles', () => {
  it('refines only auto titles and protects explicit names from late results', () => {
    const r = new TopicRegistry({ newId });
    const auto = r.ensureCurrent(CONV, 'default', key, { title: 'A long first question', titleSource: 'auto' }).topic;
    expect(r.setAutoTitle(auto.id, auto.title, 'Concise task')).toBe(true);
    expect(r.get(auto.id)?.sessionKey).toBe(CONV);
    expect(r.setAutoTitle(auto.id, 'A long first question', 'Stale result')).toBe(false);
    const named = r.create(CONV, 'default', key, { title: 'My project' }, 'user').topic;
    expect(r.titleSource(named.id)).toBe('explicit');
    expect(r.setAutoTitle(named.id, named.title, 'Changed')).toBe(false);
    r.setTitle(auto.id, 'Manual name');
    expect(r.setAutoTitle(auto.id, 'Manual name', 'Changed')).toBe(false);
  });

  it('migrates an old inferred title but preserves a named topic', () => {
    const path = tempDb();
    const log = new SqliteSessionLog({ path });
    const hub = new Hub(log);
    log.db.exec(`CREATE TABLE topics (id TEXT PRIMARY KEY, conversation TEXT NOT NULL, agent TEXT NOT NULL, session_key TEXT NOT NULL UNIQUE, title TEXT, summary TEXT, native_id TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL)`);
    log.db.prepare('INSERT INTO topics VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 1, 1)').run('tp_old', CONV, 'default', CONV, 'First question', 'current');
    log.db.prepare('INSERT INTO topics VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 2, 2)').run('tp_named', CONV, 'default', `${CONV}#tp_named`, 'Named topic', 'parked');
    hub.append(CONV, { ts: 1, level: 'primary', audience: 'status', durability: 'durable', body: { t: 'input.admitted', inputId: 'i1', disposition: 'new_turn', input: {
      inputId: 'i1', origin: { kind: 'human', principal: null, evidence: 'platform_signed', via: CONV, adapter: 'fake' },
      content: [{ type: 'text', text: 'First question' }], replyRoute: null, channelContext: {},
    } } });
    const r = new TopicRegistry({ db: log.db, hub });
    expect(r.titleSource('tp_old')).toBe('auto');
    expect(r.titleSource('tp_named')).toBe('explicit');
    expect(r.setAutoTitle('tp_old', 'First question', 'Better title')).toBe(true);
    log.close();
  });
});
