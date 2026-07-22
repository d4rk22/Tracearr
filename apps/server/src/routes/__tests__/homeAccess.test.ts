import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockActiveSession } from '../../test/fixtures.js';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getAllActiveSessions: vi.fn(),
  getServerLastSuccessfulPollAt: vi.fn(),
}));

vi.mock('../../db/client.js', () => ({ db: { execute: mocks.execute } }));
vi.mock('../../services/cache.js', () => ({
  getCacheService: vi.fn(() => ({
    getAllActiveSessions: mocks.getAllActiveSessions,
    getServerLastSuccessfulPollAt: mocks.getServerLastSuccessfulPollAt,
  })),
}));

import {
  buildHistoryAggregateQuery,
  homeAccessRoutes,
  verifyHomeAccessToken,
} from '../internal/homeAccess.js';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SERVER_ID = '22222222-2222-4222-8222-222222222222';
const VALID_TOKEN = `trr_home_${'a'.repeat(43)}`;
const AUTHORIZATION = `Bearer ${VALID_TOKEN}`;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(rateLimit, { global: false });
  await app.register(homeAccessRoutes, { prefix: '/api/v1/internal/home-access' });
  return app;
}

function mockPlexServer(): void {
  mocks.execute.mockResolvedValueOnce({ rows: [{ id: SERVER_ID, type: 'plex' }] });
}

function expectOnlyKeys(value: Record<string, unknown>, keys: string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

describe('Home-access internal API', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TRACEARR_HOME_ACCESS_API_TOKEN = VALID_TOKEN;
    mocks.getAllActiveSessions.mockResolvedValue([]);
    mocks.getServerLastSuccessfulPollAt.mockResolvedValue(null);
  });

  afterEach(async () => {
    delete process.env.TRACEARR_HOME_ACCESS_API_TOKEN;
    await app?.close();
    app = undefined;
    vi.useRealTimers();
  });

  describe('dedicated authentication and response controls', () => {
    it('fails closed when the runtime token is unset or malformed', () => {
      delete process.env.TRACEARR_HOME_ACCESS_API_TOKEN;
      expect(verifyHomeAccessToken(AUTHORIZATION)).toBe(false);
      expect(verifyHomeAccessToken(AUTHORIZATION, 'short')).toBe(false);
      expect(verifyHomeAccessToken('Bearer trr_pub_not-the-right-surface', VALID_TOKEN)).toBe(
        false
      );
      expect(verifyHomeAccessToken(AUTHORIZATION, VALID_TOKEN)).toBe(true);
    });

    it('rejects missing credentials without touching data and sets no-store', async () => {
      app = await buildApp();
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/internal/home-access/viewers?serverId=${SERVER_ID}`,
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(mocks.execute).not.toHaveBeenCalled();
    });

    it('keeps the route disabled when the runtime credential is unset', async () => {
      delete process.env.TRACEARR_HOME_ACCESS_API_TOKEN;
      app = await buildApp();
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/internal/home-access/viewers?serverId=${SERVER_ID}`,
        headers: { authorization: AUTHORIZATION },
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(mocks.execute).not.toHaveBeenCalled();
    });

    it('rejects public API and JWT-shaped bearer credentials', async () => {
      app = await buildApp();
      for (const token of ['trr_pub_abc', 'eyJhbGciOiJIUzI1NiJ9.payload.signature']) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/internal/home-access/viewers?serverId=${SERVER_ID}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(401);
      }
    });

    it('enforces the bounded history rate limit', async () => {
      app = await buildApp();
      let response;
      for (let i = 0; i < 11; i++) {
        response = await app.inject({
          method: 'POST',
          url: '/api/v1/internal/home-access/history-query',
          headers: { authorization: AUTHORIZATION },
          payload: {},
        });
      }
      expect(response?.statusCode).toBe(429);
      expect(response?.headers['cache-control']).toBe('no-store');
    });
  });

  describe('GET /viewers', () => {
    it('returns only reliable, selected-server Plex observations and trustworthy freshness', async () => {
      const direct = createMockActiveSession({
        id: 'session-direct',
        serverId: SERVER_ID,
        serverUserId: 'server-user-1',
        ipAddress: '203.0.113.10',
        isLocal: false,
        connectionKind: 'direct',
      });
      const relay = createMockActiveSession({
        id: 'session-relay',
        serverId: SERVER_ID,
        serverUserId: 'server-user-2',
        ipAddress: '198.51.100.20',
        isLocal: false,
        connectionKind: 'relay',
      });
      const unknown = createMockActiveSession({
        id: 'session-unknown',
        serverId: SERVER_ID,
        serverUserId: 'server-user-3',
        ipAddress: '192.168.1.30',
        isLocal: true,
        connectionKind: null,
      });
      const wrongServer = createMockActiveSession({
        serverId: OTHER_SERVER_ID,
        serverUserId: 'server-user-other',
        ipAddress: '192.0.2.99',
      });
      mocks.getAllActiveSessions.mockResolvedValue([direct, relay, unknown, wrongServer]);
      mocks.getServerLastSuccessfulPollAt.mockResolvedValue(new Date('2026-07-22T12:00:00.000Z'));
      mockPlexServer();
      mocks.execute.mockResolvedValueOnce({
        rows: [
          { server_user_id: 'server-user-1', subject_id: 'plex-subject-1' },
          { server_user_id: 'server-user-2', subject_id: 'plex-subject-2' },
          { server_user_id: 'server-user-3', subject_id: 'plex-subject-3' },
        ],
      });

      app = await buildApp();
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/internal/home-access/viewers?serverId=${SERVER_ID}`,
        headers: { authorization: AUTHORIZATION },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.json();
      expectOnlyKeys(body, ['schemaVersion', 'snapshotAt', 'serverFreshness', 'observations']);
      expect(body.serverFreshness).toEqual({
        serverId: SERVER_ID,
        lastSuccessfulPollAt: '2026-07-22T12:00:00.000Z',
      });
      expect(body.observations).toEqual([
        {
          subjectId: 'plex-subject-1',
          serverId: SERVER_ID,
          ipAddress: '203.0.113.10',
          isLocal: false,
          connectionKind: 'direct',
        },
        {
          subjectId: 'plex-subject-2',
          serverId: SERVER_ID,
          ipAddress: '198.51.100.20',
          isLocal: false,
          connectionKind: 'relay',
        },
        {
          subjectId: 'plex-subject-3',
          serverId: SERVER_ID,
          ipAddress: '192.168.1.30',
          isLocal: true,
          connectionKind: 'unknown',
        },
      ]);
      for (const observation of body.observations as Record<string, unknown>[]) {
        expectOnlyKeys(observation, [
          'subjectId',
          'serverId',
          'ipAddress',
          'isLocal',
          'connectionKind',
        ]);
      }
      expect(JSON.stringify(body)).not.toMatch(
        /media|username|email|device|player|geo|session-direct|session-relay/i
      );
    });

    it('omits null Plex-account mappings and rolling-upgrade cache rows without locality', async () => {
      const noSubject = createMockActiveSession({
        serverId: SERVER_ID,
        serverUserId: 'server-user-null',
      });
      const noLocality = createMockActiveSession({
        serverId: SERVER_ID,
        serverUserId: 'server-user-old-cache',
      });
      delete (noLocality as Partial<typeof noLocality>).isLocal;
      mocks.getAllActiveSessions.mockResolvedValue([noSubject, noLocality]);
      mockPlexServer();
      mocks.execute.mockResolvedValueOnce({
        rows: [
          { server_user_id: 'server-user-null', subject_id: null },
          { server_user_id: 'server-user-old-cache', subject_id: 'plex-subject' },
        ],
      });

      app = await buildApp();
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/internal/home-access/viewers?serverId=${SERVER_ID}`,
        headers: { authorization: AUTHORIZATION },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().observations).toEqual([]);
    });

    it('rejects non-Plex servers', async () => {
      mocks.execute.mockResolvedValueOnce({ rows: [{ id: SERVER_ID, type: 'jellyfin' }] });
      app = await buildApp();
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/internal/home-access/viewers?serverId=${SERVER_ID}`,
        headers: { authorization: AUTHORIZATION },
      });
      expect(response.statusCode).toBe(400);
      expect(mocks.getAllActiveSessions).not.toHaveBeenCalled();
    });
  });

  describe('POST /history-query', () => {
    it('returns only bounded aggregate rows for stable Plex subjects', async () => {
      mockPlexServer();
      mocks.execute.mockResolvedValueOnce({
        rows: [{ server_user_id: 'server-user-1', subject_id: 'plex-subject-1' }],
      });
      mocks.execute.mockResolvedValueOnce({
        rows: [
          {
            subject_id: 'plex-subject-1',
            server_id: SERVER_ID,
            ip_address: '203.0.113.10',
            first_seen_at: '2026-07-01T10:00:00.000Z',
            last_seen_at: '2026-07-20T11:00:00.000Z',
            play_count: 3,
            active_days: 2,
          },
        ],
      });

      app = await buildApp();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/home-access/history-query',
        headers: { authorization: AUTHORIZATION },
        payload: {
          serverId: SERVER_ID,
          subjectIds: ['plex-subject-1'],
          window: {
            start: '2026-06-22T12:00:00.000Z',
            end: '2026-07-22T12:00:00.000Z',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expectOnlyKeys(body, ['schemaVersion', 'generatedAt', 'windowStart', 'windowEnd', 'rows']);
      expect(body.windowStart).toBe('2026-06-22T12:00:00.000Z');
      expect(body.windowEnd).toBe('2026-07-22T12:00:00.000Z');
      expect(body.rows).toEqual([
        {
          subjectId: 'plex-subject-1',
          serverId: SERVER_ID,
          ipAddress: '203.0.113.10',
          firstSeenAt: '2026-07-01T10:00:00.000Z',
          lastSeenAt: '2026-07-20T11:00:00.000Z',
          playCount: 3,
          activeDays: 2,
        },
      ]);
      expectOnlyKeys(body.rows[0], [
        'subjectId',
        'serverId',
        'ipAddress',
        'firstSeenAt',
        'lastSeenAt',
        'playCount',
        'activeDays',
      ]);
      expect(JSON.stringify(body)).not.toMatch(/media|username|email|device|player|geo/i);
    });

    it('rejects unknown or cross-server subject IDs', async () => {
      mockPlexServer();
      mocks.execute.mockResolvedValueOnce({ rows: [] });
      app = await buildApp();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/home-access/history-query',
        headers: { authorization: AUTHORIZATION },
        payload: { serverId: SERVER_ID, subjectIds: ['out-of-scope'] },
      });
      expect(response.statusCode).toBe(400);
      expect(mocks.execute).toHaveBeenCalledTimes(2);
    });

    it('rejects reversed, future, excessive, duplicate, and overlarge inputs', async () => {
      app = await buildApp();
      const futureEnd = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const futureStart = new Date(futureEnd.getTime() - 60 * 60 * 1000);
      const invalidPayloads = [
        {
          serverId: SERVER_ID,
          subjectIds: ['one'],
          window: { start: '2026-07-20T00:00:00.000Z', end: '2026-07-19T00:00:00.000Z' },
        },
        {
          serverId: SERVER_ID,
          subjectIds: ['one'],
          window: { start: futureStart.toISOString(), end: futureEnd.toISOString() },
        },
        {
          serverId: SERVER_ID,
          subjectIds: ['one'],
          window: { start: '2026-04-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' },
        },
        { serverId: SERVER_ID, subjectIds: ['one', 'one'] },
        { serverId: SERVER_ID, subjectIds: Array.from({ length: 51 }, (_, i) => `subject-${i}`) },
        { serverId: SERVER_ID, subjectIds: ['one'], resultLimit: 501 },
      ];

      for (const payload of invalidPayloads) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/internal/home-access/history-query',
          headers: { authorization: AUTHORIZATION },
          payload,
        });
        expect(response.statusCode).toBe(400);
      }
      expect(mocks.execute).not.toHaveBeenCalled();
    });

    it('rejects aggregate result sets over the requested cap', async () => {
      mockPlexServer();
      mocks.execute.mockResolvedValueOnce({
        rows: [{ server_user_id: 'server-user-1', subject_id: 'plex-subject-1' }],
      });
      mocks.execute.mockResolvedValueOnce({ rows: [{}, {}] });
      app = await buildApp();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/home-access/history-query',
        headers: { authorization: AUTHORIZATION },
        payload: {
          serverId: SERVER_ID,
          subjectIds: ['plex-subject-1'],
          resultLimit: 1,
        },
      });
      expect(response.statusCode).toBe(422);
    });

    it('aggregates in SQL by exact IP with distinct plays and UTC active days', () => {
      const dialect = new PgDialect();
      const query = dialect.sqlToQuery(
        buildHistoryAggregateQuery({
          serverId: SERVER_ID,
          subjectIds: ['plex-subject-1'],
          windowStart: new Date('2026-07-01T00:00:00.000Z'),
          windowEnd: new Date('2026-07-22T00:00:00.000Z'),
          resultLimit: 25,
        })
      );

      expect(query.sql).toMatch(/GROUP BY su\.plex_account_id, s\.server_id, s\.ip_address/i);
      expect(query.sql).toMatch(
        /COUNT\(DISTINCT COALESCE\(s\.reference_id, s\.id\)\)::int AS play_count/i
      );
      expect(query.sql).toMatch(
        /COUNT\(DISTINCT \(s\.started_at AT TIME ZONE 'UTC'\)::date\)::int AS active_days/i
      );
      expect(query.sql).toMatch(/s\.started_at >= \$\d+/i);
      expect(query.sql).toMatch(/s\.started_at < \$\d+/i);
      expect(query.params.at(-1)).toBe(26);
    });
  });
});
