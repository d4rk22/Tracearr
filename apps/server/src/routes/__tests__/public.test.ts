/**
 * Public API route tests
 */

import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { isIP } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockActiveSession } from '../../test/fixtures.js';

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn(),
  },
}));

const mockGetAllActiveSessions = vi.fn().mockResolvedValue([]);
vi.mock('../../services/cache.js', () => ({
  getCacheService: vi.fn(() => ({
    getAllActiveSessions: mockGetAllActiveSessions,
  })),
}));

import { publicRoutes, sanitizePublicPayload } from '../public.js';

function expectNoRawIp(value: unknown): void {
  if (typeof value === 'string') {
    expect(isIP(value)).toBe(0);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(expectNoRawIp);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      expect(key.toLowerCase()).not.toMatch(
        /^(ip|ipaddress|ipaddresses|clientip|sourceip|remoteip|previousip|currentip)$/
      );
      expectNoRawIp(item);
    }
  }
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorate(
    'authenticatePublicApi',
    vi.fn(async () => undefined)
  );
  await app.register(publicRoutes, { prefix: '/api/v1/public' });

  return app;
}

describe('Public API Routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('GET /streams', () => {
    it('omits location fields by default', async () => {
      const activeSessions = [
        createMockActiveSession({
          serverId: randomUUID(),
          geoCity: 'Lincoln',
          geoRegion: 'NE',
          geoCountry: 'US',
          geoLat: 40.8136,
          geoLon: -96.7026,
          ipAddress: '203.0.113.10',
        }),
      ];
      mockGetAllActiveSessions.mockResolvedValueOnce(activeSessions);
      app = await buildTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/public/streams',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).not.toHaveProperty('geoCity');
      expect(body.data[0]).not.toHaveProperty('geoRegion');
      expect(body.data[0]).not.toHaveProperty('geoCountry');
      expect(body.data[0]).not.toHaveProperty('geoLat');
      expect(body.data[0]).not.toHaveProperty('geoLon');
      expect(body.data[0]).not.toHaveProperty('ipAddress');
      expectNoRawIp(body);
    });

    it('includes sanitized location fields when requested', async () => {
      const activeSessions = [
        createMockActiveSession({
          serverId: randomUUID(),
          geoCity: 'Lincoln',
          geoRegion: 'NE',
          geoCountry: 'US',
          geoLat: 40.8136,
          geoLon: -96.7026,
          ipAddress: '203.0.113.10',
        }),
      ];
      mockGetAllActiveSessions.mockResolvedValueOnce(activeSessions);
      app = await buildTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/public/streams?includeLocation=true',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        geoCity: 'Lincoln',
        geoRegion: 'NE',
        geoCountry: 'US',
        geoLat: 40.8136,
        geoLon: -96.7026,
      });
      expect(body.data[0]).not.toHaveProperty('ipAddress');
      expectNoRawIp(body);
    });
  });

  it('recursively removes raw IPs from extensible public payloads', () => {
    const result = sanitizePublicPayload({
      safe: 'kept',
      ipAddress: '203.0.113.10',
      evidence: {
        previousIp: '198.51.100.2',
        values: ['allowed', '2001:db8::1', { sourceIp: '192.0.2.4', count: 2 }],
      },
    });

    expect(result).toEqual({
      safe: 'kept',
      evidence: { values: ['allowed', { count: 2 }] },
    });
    expectNoRawIp(result);
  });
});
