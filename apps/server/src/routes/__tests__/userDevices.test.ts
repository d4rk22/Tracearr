import { randomUUID } from 'node:crypto';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AuthUser } from '@tracearr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
  },
}));

import { db } from '../../db/client.js';
import { devicesRoutes } from '../users/devices.js';

function authUser(role: AuthUser['role'], serverIds: string[]): AuthUser {
  return { userId: randomUUID(), username: role, role, serverIds };
}

async function buildApp(user: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = user;
  });
  await app.register(devicesRoutes, { prefix: '/users' });
  return app;
}

function selectResult(value: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(value) }),
    }),
  };
}

describe('user device location routes', () => {
  let app: FastifyInstance;
  const mockDb = db as unknown as {
    select: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    vi.unstubAllGlobals();
    await app?.close();
  });

  it('maps city search results into editable override fields', async () => {
    const serverId = randomUUID();
    const serverUserId = randomUUID();
    app = await buildApp(authUser('admin', [serverId]));
    mockDb.select.mockReturnValueOnce(selectResult([{ id: serverUserId, serverId }]));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              id: 5072006,
              name: 'Lincoln',
              latitude: 40.8,
              longitude: -96.67,
              country_code: 'US',
              country: 'United States',
              admin1: 'Nebraska',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.inject({
      method: 'GET',
      url: `/users/${serverUserId}/devices/location-search?q=Lincoln`,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data[0]).toEqual({
      id: 5072006,
      city: 'Lincoln',
      region: 'Nebraska',
      country: 'US',
      countryName: 'United States',
      latitude: 40.8,
      longitude: -96.67,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'geocoding-api.open-meteo.com' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('allows an admin with server access to create or update an override', async () => {
    const serverId = randomUUID();
    const serverUserId = randomUUID();
    const deviceId = 'stable-device-guid';
    app = await buildApp(authUser('admin', [serverId]));
    mockDb.select.mockReturnValueOnce(selectResult([{ id: serverUserId, serverId }]));

    const returning = vi.fn().mockResolvedValue([
      {
        city: 'Lincoln',
        region: 'Nebraska',
        country: 'US',
        latitude: 40.8136,
        longitude: -96.7026,
      },
    ]);
    const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    mockDb.insert.mockReturnValue({ values });

    const response = await app.inject({
      method: 'PUT',
      url: `/users/${serverUserId}/devices/${deviceId}/location`,
      payload: {
        city: 'Lincoln',
        region: 'Nebraska',
        country: 'us',
        latitude: 40.8136,
        longitude: -96.7026,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUserId,
        deviceId,
        city: 'Lincoln',
        country: 'US',
      })
    );
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it('rejects a viewer before reading or changing override data', async () => {
    const serverId = randomUUID();
    app = await buildApp(authUser('viewer', [serverId]));

    const response = await app.inject({
      method: 'PUT',
      url: `/users/${randomUUID()}/devices/device-guid/location`,
      payload: {
        city: 'Lincoln',
        region: null,
        country: 'US',
        latitude: 40.8136,
        longitude: -96.7026,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('rejects an admin without access to the user server', async () => {
    const userServerId = randomUUID();
    const serverUserId = randomUUID();
    app = await buildApp(authUser('admin', [randomUUID()]));
    mockDb.select.mockReturnValueOnce(selectResult([{ id: serverUserId, serverId: userServerId }]));

    const response = await app.inject({
      method: 'DELETE',
      url: `/users/${serverUserId}/devices/device-guid/location`,
    });

    expect(response.statusCode).toBe(403);
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('clears an override for an authorized owner', async () => {
    const serverId = randomUUID();
    const serverUserId = randomUUID();
    app = await buildApp(authUser('owner', [serverId]));
    mockDb.select.mockReturnValueOnce(selectResult([{ id: serverUserId, serverId }]));
    const where = vi.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where });

    const response = await app.inject({
      method: 'DELETE',
      url: `/users/${serverUserId}/devices/device-guid/location`,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ success: true });
    expect(mockDb.delete).toHaveBeenCalledOnce();
    expect(where).toHaveBeenCalledOnce();
  });
});
