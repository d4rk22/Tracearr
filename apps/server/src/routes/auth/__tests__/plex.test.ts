/**
 * Plex auth routes tests
 *
 * Tests the API endpoints for Plex server discovery and connection:
 * - GET /plex/available-servers - Discover available Plex servers
 * - POST /plex/add-server - Add an additional Plex server
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

// Mock dependencies before imports
vi.mock('../../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../../utils/crypto.js', () => ({
  encrypt: vi.fn((token: string) => `encrypted_${token}`),
  decrypt: vi.fn((token: string) => token.replace('encrypted_', '')),
}));

// Hoisted so a top-level beforeEach can re-establish defaults after
// vi.resetAllMocks() (which wipes implementations as well as call history).
// vi.hoisted() is required because vi.mock factories run before module-level
// const declarations — without it, the factories would capture `undefined`.
const { mockGetUsers, mockGetAllServerIds } = vi.hoisted(() => ({
  mockGetUsers: vi.fn(),
  mockGetAllServerIds: vi.fn(),
}));

vi.mock('../../../services/mediaServer/index.js', () => {
  class MockPlexClient {
    getUsers = mockGetUsers;
  }

  return {
    PlexClient: Object.assign(MockPlexClient, {
      getServers: vi.fn(),
      verifyServerAdmin: vi.fn(),
      checkOAuthPin: vi.fn(),
      AdminVerifyError: {
        CONNECTION_FAILED: 'CONNECTION_FAILED',
        NOT_ADMIN: 'NOT_ADMIN',
      },
    }),
  };
});

vi.mock('../../../services/sync.js', () => ({
  syncServer: vi.fn(),
}));

vi.mock('../../../services/userService.js', () => ({
  getUserById: vi.fn(),
  getOwnerUser: vi.fn(),
  getUserByPlexAccountId: vi.fn(),
}));

vi.mock('../../../utils/claimCode.js', () => ({
  isClaimCodeEnabled: vi.fn(),
  validateClaimCode: vi.fn(),
}));

vi.mock('../../../services/serverService.js', () => ({
  getAllServerIds: mockGetAllServerIds,
}));

// Import mocked modules
import { db } from '../../../db/client.js';
import {
  getUserById,
  getOwnerUser,
  getUserByPlexAccountId,
} from '../../../services/userService.js';
import { PlexClient } from '../../../services/mediaServer/index.js';
import { syncServer } from '../../../services/sync.js';
import { isClaimCodeEnabled, validateClaimCode } from '../../../utils/claimCode.js';
import { plexRoutes } from '../plex.js';

// Mock global fetch for connection testing
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock Redis client for unauthenticated endpoints
const mockRedis = {
  get: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
};

// Helper to create DB chain mocks (prefixed with _ as they're utility functions for future tests)
function _mockDbSelectWhere(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

// For queries that end with .limit()
function _mockDbSelectLimit(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

// Export to prevent unused warnings while keeping them available
void _mockDbSelectWhere;
void _mockDbSelectLimit;

function mockDbInsert(result: unknown[]) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.insert).mockReturnValue(chain as never);
  return chain;
}

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  // Mock authenticate
  app.decorate('authenticate', async (request: unknown) => {
    (request as { user: AuthUser }).user = authUser;
  });

  await app.register(plexRoutes);
  return app;
}

async function buildUnauthenticatedTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(cookie, { secret: 'test-cookie-secret' });
  await app.register(jwt, {
    secret: 'test-jwt-secret-must-be-32-chars-minimum',
    sign: { algorithm: 'HS256' },
  });

  // Mock authenticate (required even though unauthenticated endpoints don't use it)
  app.decorate('authenticate', async (request: unknown) => {
    (request as { user: AuthUser }).user = ownerUser;
  });

  // Decorate app with mock Redis
  app.decorate('redis', mockRedis as any);

  await app.register(plexRoutes);
  return app;
}

const ownerId = randomUUID();

const ownerUser: AuthUser = {
  userId: ownerId,
  username: 'admin',
  role: 'owner',
  serverIds: [randomUUID()],
};

// Mock DB user for getUserById
const mockDbUser = {
  id: ownerId,
  username: 'admin',
  role: 'owner',
  plexAccountId: 'plex-account-123',
};

const viewerUser: AuthUser = {
  userId: randomUUID(),
  username: 'viewer',
  role: 'viewer',
  serverIds: [randomUUID()],
};

const mockExistingServer = {
  id: randomUUID(),
  name: 'Existing Plex Server',
  type: 'plex' as const,
  url: 'http://localhost:32400',
  token: 'encrypted_test-token',
  machineIdentifier: 'existing-machine-id',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockPlexServer = {
  name: 'New Plex Server',
  product: 'Plex Media Server',
  platform: 'Linux',
  productVersion: '1.40.0',
  clientIdentifier: 'new-machine-id',
  owned: true,
  accessToken: 'server-access-token',
  publicAddress: '203.0.113.1',
  publicAddressMatches: true, // Same network, all connections reachable
  httpsRequired: false, // HTTP connections allowed
  connections: [
    {
      protocol: 'http',
      uri: 'http://192.168.1.100:32400',
      local: true,
      address: '192.168.1.100',
      port: 32400,
      relay: false,
    },
    {
      protocol: 'https',
      uri: 'https://plex.example.com:32400',
      local: false,
      address: 'plex.example.com',
      port: 32400,
      relay: false,
    },
  ],
};

describe('Plex Auth Routes', () => {
  let app: FastifyInstance;

  // Re-establish default mock implementations after each reset. These are
  // depended on by multiple suites (PlexClient instance method, generateTokens
  // server-id lookup, fire-and-forget background sync) — hoisting them here
  // keeps the resetAllMocks pattern free of order-dependent leaks across
  // describes.
  beforeEach(() => {
    mockGetUsers.mockResolvedValue([{ id: '1', username: 'admin', isAdmin: true }]);
    mockGetAllServerIds.mockResolvedValue([]);
    // syncServer is awaited via .then() in the route's fire-and-forget path.
    // Without a resolved value, the chained `.then` blows up.
    vi.mocked(syncServer).mockResolvedValue({
      usersAdded: 0,
      usersUpdated: 0,
      usersSkipped: 0,
      usersRemoved: 0,
      usersRestored: 0,
      librariesSynced: 0,
      errors: [],
    });
  });

  afterEach(async () => {
    await app?.close();
    vi.resetAllMocks();
  });

  describe('GET /plex/available-servers', () => {
    it('returns 403 for non-owner users', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/plex/available-servers',
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns hasPlexToken: false when no Plex accounts linked', async () => {
      app = await buildTestApp(ownerUser);

      // Mock getUserById to return the user
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);

      // Mock DB queries: no plex_accounts, no servers
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      const response = await app.inject({
        method: 'GET',
        url: '/plex/available-servers',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.hasPlexToken).toBe(false);
      expect(body.servers).toEqual([]);
    });

    // TODO: Fix this test - the DB mock chain is complex due to multiple query patterns
    it.skip('returns empty servers when all owned servers are connected', async () => {
      app = await buildTestApp(ownerUser);

      // Mock getUserById to return the user
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);

      // Create a flexible mock that handles various query chain patterns
      // Route queries: 1) servers for token, 2) servers for connected list
      const makeChain = (result: unknown[]) => ({
        limit: vi.fn().mockResolvedValue(result),
        // For queries that don't use limit (just .where())
        then: vi.fn((resolve: (v: unknown[]) => void) => resolve(result)),
        [Symbol.toStringTag]: 'Promise',
      });

      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation(() => {
          // First call for token, returns existing server token
          // Subsequent calls return connected servers list
          return Object.assign(
            Promise.resolve([
              {
                token: mockExistingServer.token,
                machineIdentifier: mockExistingServer.machineIdentifier,
              },
            ]),
            makeChain([{ token: mockExistingServer.token }])
          );
        }),
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      // Mock PlexClient.getServers to return only the existing server
      vi.mocked(PlexClient.getServers).mockResolvedValue([
        {
          ...mockPlexServer,
          clientIdentifier: mockExistingServer.machineIdentifier,
        },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/plex/available-servers',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.hasPlexToken).toBe(true);
      // All servers already connected, so empty list
      expect(body.servers).toEqual([]);
    });

    it('returns available servers with connection test results', async () => {
      app = await buildTestApp(ownerUser);

      // Mock getUserById to return the user
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);

      // Create a flexible mock
      const makeChain = (result: unknown[]) => ({
        limit: vi.fn().mockResolvedValue(result),
      });

      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation(() => {
          return Object.assign(
            Promise.resolve([{ machineIdentifier: 'other-machine-id' }]), // Connected server
            makeChain([{ token: mockExistingServer.token }]) // For limit() queries
          );
        }),
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      // Return a new server not yet connected
      vi.mocked(PlexClient.getServers).mockResolvedValue([mockPlexServer]);

      // Mock fetch for connection testing - first succeeds, second fails
      mockFetch
        .mockResolvedValueOnce({ ok: true }) // Local connection succeeds
        .mockRejectedValueOnce(new Error('timeout')); // Remote connection fails

      const response = await app.inject({
        method: 'GET',
        url: '/plex/available-servers',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.hasPlexToken).toBe(true);
      expect(body.servers).toHaveLength(1);
      expect(body.servers[0].name).toBe('New Plex Server');
      expect(body.servers[0].clientIdentifier).toBe('new-machine-id');
      expect(body.servers[0].connections).toHaveLength(2);
      // First connection should be reachable
      expect(body.servers[0].connections[0].reachable).toBe(true);
      // Second connection should be unreachable
      expect(body.servers[0].connections[1].reachable).toBe(false);
    });
  });

  describe('POST /plex/add-server', () => {
    it('returns 403 for non-owner users', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/plex/add-server',
        payload: {
          serverUri: 'http://192.168.1.100:32400',
          serverName: 'New Server',
          clientIdentifier: 'new-machine-id',
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 400 when no Plex accounts linked', async () => {
      app = await buildTestApp(ownerUser);

      // Mock getUserById to return the user
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);

      // Mock the DB query with limit() returning empty for both servers and plex_accounts
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([]) // No existing plex servers
          .mockResolvedValueOnce([]), // No plex accounts
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      const response = await app.inject({
        method: 'POST',
        url: '/plex/add-server',
        payload: {
          serverUri: 'http://192.168.1.100:32400',
          serverName: 'New Server',
          clientIdentifier: 'new-machine-id',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toContain('No Plex accounts linked');
    });

    it('returns 409 when server is already connected', async () => {
      app = await buildTestApp(ownerUser);

      // Mock getUserById to return the user
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);

      // Mock all limit() calls:
      // 1. Get existing Plex server (has token)
      // 2. Check machineIdentifier duplicate (found - conflict!)
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([{ token: mockExistingServer.token }]) // First - get token from existing server
          .mockResolvedValueOnce([{ id: mockExistingServer.id }]), // Second - duplicate found
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      const response = await app.inject({
        method: 'POST',
        url: '/plex/add-server',
        payload: {
          serverUri: 'http://192.168.1.100:32400',
          serverName: 'New Server',
          clientIdentifier: mockExistingServer.machineIdentifier,
        },
      });

      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.message).toContain('already connected');
    });

    it('successfully adds a new server', async () => {
      app = await buildTestApp(ownerUser);

      // Mock getUserById to return the user
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);

      const newServerId = randomUUID();
      const newServer = {
        id: newServerId,
        name: 'New Server',
        type: 'plex',
        url: 'http://192.168.1.100:32400',
        token: 'encrypted_test-token',
        machineIdentifier: 'new-machine-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Mock all limit() calls:
      // 1. Get existing Plex server (has token)
      // 2. Check machineIdentifier duplicate (not found)
      // 3. Check URL duplicate (not found)
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([{ token: mockExistingServer.token }]) // First - get token from existing server
          .mockResolvedValueOnce([]) // Second - no machineIdentifier duplicate
          .mockResolvedValueOnce([]), // Third - no URL duplicate
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      // Mock admin verification
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({ success: true });

      // Mock insert
      mockDbInsert([newServer]);

      // Mock sync
      vi.mocked(syncServer).mockResolvedValue({
        usersAdded: 5,
        usersUpdated: 0,
        usersSkipped: 0,
        usersRemoved: 0,
        usersRestored: 0,
        librariesSynced: 3,
        errors: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/plex/add-server',
        payload: {
          serverUri: 'http://192.168.1.100:32400',
          serverName: 'New Server',
          clientIdentifier: 'new-machine-id',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.server.id).toBe(newServerId);
      expect(body.success).toBe(true);
    });

    it('returns 403 when not admin on server', async () => {
      app = await buildTestApp(ownerUser);

      // Mock getUserById to return the user
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);

      // Mock all limit() calls
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([{ token: mockExistingServer.token }]) // Get token from existing server
          .mockResolvedValueOnce([]) // No machineIdentifier duplicate
          .mockResolvedValueOnce([]), // No URL duplicate
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      // Mock admin verification - not admin
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({
        success: false,
        code: 'NOT_ADMIN',
        message: 'You must be an admin on this Plex server',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/plex/add-server',
        payload: {
          serverUri: 'http://192.168.1.100:32400',
          serverName: 'New Server',
          clientIdentifier: 'new-machine-id',
        },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.message).toContain('admin');
    });
  });

  describe('POST /plex/check-pin - Claim Code Validation', () => {
    let app: FastifyInstance;

    afterEach(async () => {
      if (app) await app.close();
      vi.resetAllMocks();
      mockRedis.get.mockReset();
      mockRedis.setex.mockReset();
      mockRedis.del.mockReset();
    });

    const mockPlexAuthResult = {
      id: 'plex-account-123',
      username: 'plexuser',
      email: 'plex@example.com',
      thumb: 'https://example.com/avatar.jpg',
      token: 'plex-token-abc',
    };

    describe('when claim code is enabled', () => {
      beforeEach(() => {
        vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      });

      it('requires claim code for first user (no servers)', async () => {
        app = await buildUnauthenticatedTestApp();

        // Mock Plex OAuth success
        vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(mockPlexAuthResult);

        // Mock: no existing plex accounts
        const selectMock = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
        vi.mocked(db.select).mockReturnValue(selectMock as never);

        // Mock: no existing user by plexAccountId or externalId
        vi.mocked(getUserByPlexAccountId).mockResolvedValue(null);

        // Mock: no servers owned
        vi.mocked(PlexClient.getServers).mockResolvedValue([]);

        // Mock: first user (no owner)
        vi.mocked(getOwnerUser).mockResolvedValue(null);

        const response = await app.inject({
          method: 'POST',
          url: '/plex/check-pin',
          payload: { pinId: 'pin-123' },
          // Missing claimCode
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().message).toContain('Claim code required');
      });

      it('rejects invalid claim code for first user (no servers)', async () => {
        app = await buildUnauthenticatedTestApp();

        vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(mockPlexAuthResult);
        vi.mocked(validateClaimCode).mockReturnValue(false);

        const selectMock = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
        vi.mocked(db.select).mockReturnValue(selectMock as never);

        vi.mocked(getUserByPlexAccountId).mockResolvedValue(null);
        vi.mocked(PlexClient.getServers).mockResolvedValue([]);
        vi.mocked(getOwnerUser).mockResolvedValue(null);

        const response = await app.inject({
          method: 'POST',
          url: '/plex/check-pin',
          payload: { pinId: 'pin-123', claimCode: 'WRONG-CODE' },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().message).toContain('Claim code required');
        expect(validateClaimCode).toHaveBeenCalledWith('WRONG-CODE');
      });

      it('allows first user with valid claim code (no servers)', async () => {
        app = await buildUnauthenticatedTestApp();

        vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(mockPlexAuthResult);
        vi.mocked(validateClaimCode).mockReturnValue(true);

        const selectMock = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
        vi.mocked(db.select).mockReturnValue(selectMock as never);

        vi.mocked(getUserByPlexAccountId).mockResolvedValue(null);
        vi.mocked(PlexClient.getServers).mockResolvedValue([]);
        vi.mocked(getOwnerUser).mockResolvedValue(null);

        const newUser = {
          id: randomUUID(),
          username: 'plexuser',
          email: 'plex@example.com',
          role: 'owner' as const,
        };

        mockDbInsert([newUser]);

        // Mock second insert for plex_accounts
        vi.mocked(db.insert).mockReturnValueOnce({
          values: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue([{ id: randomUUID() }]),
        } as never);

        mockRedis.del.mockResolvedValue(1);

        const response = await app.inject({
          method: 'POST',
          url: '/plex/check-pin',
          payload: { pinId: 'pin-123', claimCode: 'ABCD-EFGH-JKLM' },
        });

        expect(response.statusCode).toBe(200);
        expect(validateClaimCode).toHaveBeenCalledWith('ABCD-EFGH-JKLM');
        expect(response.json()).toHaveProperty('accessToken');
      });
    });

    describe('when claim code is disabled', () => {
      beforeEach(() => {
        vi.mocked(isClaimCodeEnabled).mockReturnValue(false);
      });

      it('allows first user without claim code', async () => {
        app = await buildUnauthenticatedTestApp();

        vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(mockPlexAuthResult);

        const selectMock = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
        vi.mocked(db.select).mockReturnValue(selectMock as never);

        vi.mocked(getUserByPlexAccountId).mockResolvedValue(null);
        vi.mocked(PlexClient.getServers).mockResolvedValue([]);
        vi.mocked(getOwnerUser).mockResolvedValue(null);

        const newUser = {
          id: randomUUID(),
          username: 'plexuser',
          email: 'plex@example.com',
          role: 'owner' as const,
        };

        mockDbInsert([newUser]);

        vi.mocked(db.insert).mockReturnValueOnce({
          values: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue([{ id: randomUUID() }]),
        } as never);

        mockRedis.del.mockResolvedValue(1);

        const response = await app.inject({
          method: 'POST',
          url: '/plex/check-pin',
          payload: { pinId: 'pin-123' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toHaveProperty('accessToken');
      });
    });
  });

  describe('POST /plex/connect - Claim Code Validation', () => {
    let app: FastifyInstance;

    afterEach(async () => {
      if (app) await app.close();
      vi.resetAllMocks();
      mockRedis.get.mockReset();
      mockRedis.setex.mockReset();
      mockRedis.del.mockReset();
    });

    const tempToken = 'temp-token-123';
    const storedData = {
      plexAccountId: 'plex-account-123',
      plexUsername: 'plexuser',
      plexEmail: 'plex@example.com',
      plexThumb: 'https://example.com/avatar.jpg',
      plexToken: 'plex-token-abc',
      isFirstUser: true,
    };

    describe('when claim code is enabled', () => {
      beforeEach(() => {
        vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
        // verifyServerAdmin is called after the claim code check
        vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({
          success: true,
        });
      });

      // getOwnerUser() is mocked (vi.fn(), no db.select) so it runs before the
      // claim-code check with no DB side effects. This stub is only required
      // by the "allows" test which proceeds past both guards to verifyServerAdmin
      // and then into the server create/update path.
      const stubExistingServerLookupEmpty = () => {
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        } as never);
        vi.mocked(db.insert).mockReturnValue({
          values: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue([{ id: randomUUID() }]),
        } as never);
      };

      it('requires claim code for first user', async () => {
        app = await buildUnauthenticatedTestApp();

        stubExistingServerLookupEmpty();
        mockRedis.get.mockResolvedValue(JSON.stringify(storedData));
        mockRedis.del.mockResolvedValue(1);

        const response = await app.inject({
          method: 'POST',
          url: '/plex/connect',
          payload: {
            tempToken,
            serverUri: 'http://localhost:32400',
            serverName: 'My Plex Server',
          },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().message).toContain('Claim code required');
      });

      it('rejects invalid claim code for first user', async () => {
        app = await buildUnauthenticatedTestApp();

        stubExistingServerLookupEmpty();
        vi.mocked(validateClaimCode).mockReturnValue(false);
        mockRedis.get.mockResolvedValue(JSON.stringify(storedData));
        mockRedis.del.mockResolvedValue(1);

        const response = await app.inject({
          method: 'POST',
          url: '/plex/connect',
          payload: {
            tempToken,
            serverUri: 'http://localhost:32400',
            serverName: 'My Plex Server',
            claimCode: 'WRONG-CODE',
          },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().message).toContain('Claim code required');
        expect(validateClaimCode).toHaveBeenCalledWith('WRONG-CODE');
      });

      it('allows first user with valid claim code', async () => {
        app = await buildUnauthenticatedTestApp();

        vi.mocked(validateClaimCode).mockReturnValue(true);
        mockRedis.get.mockResolvedValue(JSON.stringify(storedData));
        mockRedis.del.mockResolvedValue(1);

        const serverId = randomUUID();
        const userId = randomUUID();
        const plexAccountId = randomUUID();

        // Mock DB operations in order they're called:
        // 1. Select existing server (returns empty - no existing server)
        // Note: Also handles getAllServerIds() call in generateTokens()
        let selectCallCount = 0;
        const selectMock = {
          from: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              // First call: check for existing server (has where/limit)
              return {
                where: vi.fn().mockReturnThis(),
                limit: vi.fn().mockResolvedValue([]),
              };
            } else {
              // Second call: getAllServerIds() (no where/limit, just resolves)
              return Promise.resolve([]);
            }
          }),
        };
        vi.mocked(db.select).mockReturnValue(selectMock as never);

        // 2-5. Four inserts: server, user, plex_account, server_user
        vi.mocked(db.insert)
          .mockReturnValueOnce({
            values: vi.fn().mockReturnThis(),
            returning: vi.fn().mockResolvedValue([{ id: serverId }]),
          } as never)
          .mockReturnValueOnce({
            values: vi.fn().mockReturnThis(),
            returning: vi
              .fn()
              .mockResolvedValue([{ id: userId, username: 'plexuser', role: 'owner' }]),
          } as never)
          .mockReturnValueOnce({
            values: vi.fn().mockReturnThis(),
            returning: vi.fn().mockResolvedValue([{ id: plexAccountId }]),
          } as never)
          .mockReturnValueOnce({
            values: vi.fn().mockResolvedValue(undefined),
          } as never);

        // 6-7. Two updates: server token, server plex_account FK
        vi.mocked(db.update)
          .mockReturnValueOnce({
            set: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue(undefined),
          } as never)
          .mockReturnValueOnce({
            set: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue(undefined),
          } as never);

        const response = await app.inject({
          method: 'POST',
          url: '/plex/connect',
          payload: {
            tempToken,
            serverUri: 'http://localhost:32400',
            serverName: 'My Plex Server',
            claimCode: 'ABCD-EFGH-JKLM',
          },
        });

        expect(response.statusCode).toBe(200);
        expect(validateClaimCode).toHaveBeenCalledWith('ABCD-EFGH-JKLM');
        expect(response.json()).toHaveProperty('accessToken');
      });
    });

    describe('when claim code is disabled', () => {
      beforeEach(() => {
        vi.mocked(isClaimCodeEnabled).mockReturnValue(false);
        vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({
          success: true,
        });
      });

      it('allows first user without claim code', async () => {
        app = await buildUnauthenticatedTestApp();

        mockRedis.get.mockResolvedValue(JSON.stringify(storedData));
        mockRedis.del.mockResolvedValue(1);

        const serverId = randomUUID();
        const userId = randomUUID();
        const plexAccountId = randomUUID();

        // Mock DB operations in order they're called:
        // 1. Select existing server (returns empty - no existing server)
        // Note: Also handles getAllServerIds() call in generateTokens()
        let selectCallCount = 0;
        const selectMock = {
          from: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              // First call: check for existing server (has where/limit)
              return {
                where: vi.fn().mockReturnThis(),
                limit: vi.fn().mockResolvedValue([]),
              };
            } else {
              // Second call: getAllServerIds() (no where/limit, just resolves)
              return Promise.resolve([]);
            }
          }),
        };
        vi.mocked(db.select).mockReturnValue(selectMock as never);

        // 2-5. Four inserts: server, user, plex_account, server_user
        vi.mocked(db.insert)
          .mockReturnValueOnce({
            values: vi.fn().mockReturnThis(),
            returning: vi.fn().mockResolvedValue([{ id: serverId }]),
          } as never)
          .mockReturnValueOnce({
            values: vi.fn().mockReturnThis(),
            returning: vi
              .fn()
              .mockResolvedValue([{ id: userId, username: 'plexuser', role: 'owner' }]),
          } as never)
          .mockReturnValueOnce({
            values: vi.fn().mockReturnThis(),
            returning: vi.fn().mockResolvedValue([{ id: plexAccountId }]),
          } as never)
          .mockReturnValueOnce({
            values: vi.fn().mockResolvedValue(undefined),
          } as never);

        // 6-7. Two updates: server token, server plex_account FK
        vi.mocked(db.update)
          .mockReturnValueOnce({
            set: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue(undefined),
          } as never)
          .mockReturnValueOnce({
            set: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue(undefined),
          } as never);

        const response = await app.inject({
          method: 'POST',
          url: '/plex/connect',
          payload: {
            tempToken,
            serverUri: 'http://localhost:32400',
            serverName: 'My Plex Server',
          },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toHaveProperty('accessToken');
      });
    });
  });

  /**
   * Security tests for GitHub Issue #392
   * Ensures only the owner can log in - no other users should have access
   */
  describe('Security: Owner-Only Access (Issue #392)', () => {
    const mockPlexAuthResult = {
      id: 'new-plex-account-456',
      username: 'attacker',
      email: 'attacker@example.com',
      thumb: 'https://example.com/attacker.jpg',
      token: 'attacker-plex-token',
    };

    const existingOwner = {
      id: randomUUID(),
      username: 'owner',
      email: 'owner@example.com',
      role: 'owner' as const,
      plexAccountId: 'owner-plex-123',
      name: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      thumbnail: null,
      passwordHash: null,
      apiToken: null,
      aggregateTrustScore: 100,
      totalViolations: 0,
    };

    const existingViewer = {
      id: randomUUID(),
      username: 'viewer',
      email: 'viewer@example.com',
      role: 'viewer' as const,
      plexAccountId: 'viewer-plex-456',
      name: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      thumbnail: null,
      passwordHash: null,
      apiToken: null,
      aggregateTrustScore: 100,
      totalViolations: 0,
    };

    beforeEach(() => {
      vi.mocked(isClaimCodeEnabled).mockReturnValue(false);
    });

    afterEach(async () => {
      if (app) await app.close();
      vi.resetAllMocks();
      mockRedis.get.mockReset();
      mockRedis.setex.mockReset();
      mockRedis.del.mockReset();
    });

    describe('POST /plex/check-pin - Blocks new users when owner exists', () => {
      it('rejects new Plex user with no servers when owner exists', async () => {
        app = await buildUnauthenticatedTestApp();

        vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(mockPlexAuthResult);

        // No existing plex accounts for this user
        const selectMock = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
        vi.mocked(db.select).mockReturnValue(selectMock as never);

        // No existing user
        vi.mocked(getUserByPlexAccountId).mockResolvedValue(null);

        // No servers owned by attacker
        vi.mocked(PlexClient.getServers).mockResolvedValue([]);

        // Owner already exists - THIS IS THE KEY CHECK
        vi.mocked(getOwnerUser).mockResolvedValue(existingOwner);

        const response = await app.inject({
          method: 'POST',
          url: '/plex/check-pin',
          payload: { pinId: 'attacker-pin' },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().message).toContain('already has an owner');
      });

      it('rejects new Plex user with servers when owner exists', async () => {
        app = await buildUnauthenticatedTestApp();

        vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(mockPlexAuthResult);

        const selectMock = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
        vi.mocked(db.select).mockReturnValue(selectMock as never);

        vi.mocked(getUserByPlexAccountId).mockResolvedValue(null);

        // Attacker owns a Plex server
        vi.mocked(PlexClient.getServers).mockResolvedValue([mockPlexServer]);

        // Owner already exists
        vi.mocked(getOwnerUser).mockResolvedValue(existingOwner);

        const response = await app.inject({
          method: 'POST',
          url: '/plex/check-pin',
          payload: { pinId: 'attacker-pin' },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().message).toContain('already has an owner');
      });

      it('rejects existing non-owner user via plex_accounts', async () => {
        app = await buildUnauthenticatedTestApp();

        vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue({
          ...mockPlexAuthResult,
          id: existingViewer.plexAccountId,
        });

        // Found in plex_accounts with allowLogin=true
        const selectMock = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi
            .fn()
            .mockResolvedValue([{ id: randomUUID(), userId: existingViewer.id, allowLogin: true }]),
        };
        vi.mocked(db.select).mockReturnValue(selectMock as never);

        // Return viewer user (not owner)
        vi.mocked(getUserById).mockResolvedValue(existingViewer);

        const response = await app.inject({
          method: 'POST',
          url: '/plex/check-pin',
          payload: { pinId: 'viewer-pin' },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().message).toContain('Only the owner can log in');
      });

      it('rejects existing non-owner user via legacy plexAccountId lookup', async () => {
        app = await buildUnauthenticatedTestApp();

        vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue({
          ...mockPlexAuthResult,
          id: existingViewer.plexAccountId,
        });

        // Not found in plex_accounts
        const selectMock = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
        vi.mocked(db.select).mockReturnValue(selectMock as never);

        // Found via legacy lookup - viewer role
        vi.mocked(getUserByPlexAccountId).mockResolvedValue(existingViewer);

        const response = await app.inject({
          method: 'POST',
          url: '/plex/check-pin',
          payload: { pinId: 'viewer-pin' },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().message).toContain('Only the owner can log in');
      });

      it('allows existing owner user to log in', async () => {
        app = await buildUnauthenticatedTestApp();

        vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue({
          ...mockPlexAuthResult,
          id: existingOwner.plexAccountId,
        });

        let selectCallCount = 0;
        const selectMock = {
          from: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              return {
                where: vi.fn().mockReturnThis(),
                limit: vi
                  .fn()
                  .mockResolvedValue([
                    { id: randomUUID(), userId: existingOwner.id, allowLogin: true },
                  ]),
              };
            } else {
              return Promise.resolve([]);
            }
          }),
        };
        vi.mocked(db.select).mockReturnValue(selectMock as never);

        // Return owner user
        vi.mocked(getUserById).mockResolvedValue(existingOwner);

        // Mock the update calls
        vi.mocked(db.update).mockReset();
        vi.mocked(db.update).mockReturnValue({
          set: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            const result = Promise.resolve(undefined);
            (result as unknown as Record<string, unknown>).returning = vi
              .fn()
              .mockResolvedValue([]);
            return result;
          }),
        } as never);

        const response = await app.inject({
          method: 'POST',
          url: '/plex/check-pin',
          payload: { pinId: 'owner-pin' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toHaveProperty('accessToken');
      });
    });

    describe('POST /plex/connect - Re-validates owner at connection time', () => {
      const tempToken = 'attacker-temp-token';
      const storedData = {
        plexAccountId: 'attacker-plex-456',
        plexUsername: 'attacker',
        plexEmail: 'attacker@example.com',
        plexThumb: 'https://example.com/attacker.jpg',
        plexToken: 'attacker-plex-token',
        // Note: isFirstUser is NOT stored anymore - we re-check at connect time
      };

      it('rejects connection if owner was created after check-pin (race condition fix)', async () => {
        app = await buildUnauthenticatedTestApp();

        // Temp token exists (was created when no owner existed)
        mockRedis.get.mockResolvedValue(JSON.stringify(storedData));
        mockRedis.del.mockResolvedValue(1);

        // Admin verification succeeds
        vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({ success: true });

        // Server doesn't exist yet
        const selectMock = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
        vi.mocked(db.select).mockReturnValue(selectMock as never);

        // Mock server insert
        vi.mocked(db.insert).mockReturnValue({
          values: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue([{ id: randomUUID() }]),
        } as never);

        // KEY: Owner now exists (created by another user in the meantime)
        vi.mocked(getOwnerUser).mockResolvedValue(existingOwner);

        const response = await app.inject({
          method: 'POST',
          url: '/plex/connect',
          payload: {
            tempToken,
            serverUri: 'http://localhost:32400',
            serverName: 'Attacker Server',
          },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().message).toContain('already has an owner');
      });
    });
  });

  describe('POST /plex/test-connection', () => {
    beforeEach(() => {
      mockRedis.get.mockReset();
      mockRedis.del.mockReset();
      mockFetch.mockReset();
    });

    it('returns reachable: true on successful test (tempToken auth)', async () => {
      app = await buildUnauthenticatedTestApp();
      mockRedis.get.mockResolvedValue(JSON.stringify({ plexToken: 'plex-tok-from-temp' }));
      mockFetch.mockResolvedValueOnce({ ok: true });

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400', tempToken: 'temp-123' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.connection.reachable).toBe(true);
      expect(body.connection.custom).toBe(true);
      expect(body.connection.uri).toBe('http://192.168.1.100:32400');
      expect(body.connection.address).toBe('192.168.1.100');
      expect(body.connection.port).toBe(32400);
      // Critical: tempToken must not be consumed by the test endpoint —
      // the user retains it until /plex/connect succeeds.
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('returns 401 when tempToken is invalid/expired', async () => {
      app = await buildUnauthenticatedTestApp();
      mockRedis.get.mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400', tempToken: 'expired' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 400 for invalid URL', async () => {
      app = await buildUnauthenticatedTestApp();

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'not-a-url', tempToken: 'temp-123' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('does NOT consume tempToken even when test fails', async () => {
      app = await buildUnauthenticatedTestApp();
      mockRedis.get.mockResolvedValue(JSON.stringify({ plexToken: 'plex-tok' }));
      mockFetch.mockRejectedValueOnce(new Error('network'));

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400', tempToken: 'temp-123' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().connection.reachable).toBe(false);
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('categorizes DNS failures (ENOTFOUND) as code: dns', async () => {
      app = await buildUnauthenticatedTestApp();
      mockRedis.get.mockResolvedValue(JSON.stringify({ plexToken: 'plex-tok' }));
      const dnsError = new Error('fetch failed');
      (dnsError as Error & { cause?: unknown }).cause = {
        code: 'ENOTFOUND',
        message: 'getaddrinfo ENOTFOUND nope.invalid',
      };
      mockFetch.mockRejectedValueOnce(dnsError);

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://nope.invalid:32400', tempToken: 'temp-123' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.connection.reachable).toBe(false);
      expect(body.connection.error.code).toBe('dns');
      expect(body.connection.error.message).toContain('ENOTFOUND');
    });

    it('categorizes ECONNREFUSED as code: refused', async () => {
      app = await buildUnauthenticatedTestApp();
      mockRedis.get.mockResolvedValue(JSON.stringify({ plexToken: 'plex-tok' }));
      const refusedError = new Error('fetch failed');
      (refusedError as Error & { cause?: unknown }).cause = {
        code: 'ECONNREFUSED',
        message: 'connect ECONNREFUSED 192.168.1.100:32400',
      };
      mockFetch.mockRejectedValueOnce(refusedError);

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400', tempToken: 'temp-123' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().connection.error.code).toBe('refused');
    });

    it('categorizes non-OK responses as code: http with status', async () => {
      app = await buildUnauthenticatedTestApp();
      mockRedis.get.mockResolvedValue(JSON.stringify({ plexToken: 'plex-tok' }));
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400', tempToken: 'temp-123' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.connection.reachable).toBe(false);
      expect(body.connection.error.code).toBe('http');
      expect(body.connection.error.status).toBe(401);
    });

    it('returns 403 for non-owner authenticated user (no tempToken)', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('owner auth path uses fallback Plex token when no accountId provided', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);

      // First select: existing plex servers (returns one with token)
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValueOnce([{ token: 'fallback-tok' }]),
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      mockFetch.mockResolvedValueOnce({ ok: true });

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().connection.reachable).toBe(true);
    });
  });

  describe('POST /plex/test-connection - Claim Code Guard', () => {
    afterEach(() => {
      mockRedis.get.mockReset();
      mockFetch.mockReset();
    });

    it('returns 403 in tempToken branch when claim code is enabled and missing', async () => {
      app = await buildUnauthenticatedTestApp();
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      mockRedis.get.mockResolvedValue(JSON.stringify({ plexToken: 'plex-tok' }));

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400', tempToken: 'temp-abc' },
        // no claimCode
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Claim code required');
      // The outbound probe must not have fired
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns 403 in tempToken branch when claim code is enabled and invalid', async () => {
      app = await buildUnauthenticatedTestApp();
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      vi.mocked(validateClaimCode).mockReturnValue(false);
      mockRedis.get.mockResolvedValue(JSON.stringify({ plexToken: 'plex-tok' }));

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400', tempToken: 'temp-abc', claimCode: 'WRONG' },
      });

      expect(response.statusCode).toBe(403);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('allows tempToken branch when claim code is enabled and valid', async () => {
      app = await buildUnauthenticatedTestApp();
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      vi.mocked(validateClaimCode).mockReturnValue(true);
      mockRedis.get.mockResolvedValue(JSON.stringify({ plexToken: 'plex-tok' }));
      mockFetch.mockResolvedValueOnce({ ok: true });

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: {
          uri: 'http://192.168.1.100:32400',
          tempToken: 'temp-abc',
          claimCode: 'VALID-CODE',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().connection.reachable).toBe(true);
      expect(validateClaimCode).toHaveBeenCalledWith('VALID-CODE');
    });
  });

  describe('POST /plex/connect - Guard ordering', () => {
    let app: FastifyInstance;

    afterEach(async () => {
      if (app) await app.close();
      vi.resetAllMocks();
      mockRedis.get.mockReset();
      mockRedis.del.mockReset();
    });

    const tempToken = 'temp-guard-test';
    const storedData = {
      plexAccountId: 'plex-account-x',
      plexUsername: 'user',
      plexEmail: 'u@e.com',
      plexThumb: 'https://e.com/u.jpg',
      plexToken: 'plex-token-x',
    };

    it('does not call verifyServerAdmin or create a server row when claim code is missing', async () => {
      app = await buildUnauthenticatedTestApp();
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      mockRedis.get.mockResolvedValue(JSON.stringify(storedData));
      // getOwnerUser returns undefined (no existing owner) so first-user check passes
      vi.mocked(getOwnerUser).mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: '/plex/connect',
        payload: {
          tempToken,
          serverUri: 'http://192.168.1.100:32400',
          serverName: 'My Server',
          // no claimCode
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Claim code required');
      expect(PlexClient.verifyServerAdmin).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('GET /plex/server-connections/:serverId', () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('injects saved URL as custom: true when not in plex.tv connections', async () => {
      app = await buildTestApp(ownerUser);

      const customUrl = 'http://192.168.1.99:9999';
      const serverId = randomUUID();

      // First (and only) select: server row by id
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          {
            id: serverId,
            token: 'srv-tok',
            name: 'Home',
            url: customUrl, // saved URL not in plex.tv connections
            machineIdentifier: 'mid-abc',
          },
        ]),
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      vi.mocked(PlexClient.getServers).mockResolvedValue([
        {
          ...mockPlexServer,
          clientIdentifier: 'mid-abc',
          // None of these connections match the saved customUrl
        },
      ]);

      // Order: testServerConnections first (2 plex.tv connections), then the custom URL test
      mockFetch
        .mockResolvedValueOnce({ ok: true }) // local plex.tv conn
        .mockResolvedValueOnce({ ok: true }) // remote plex.tv conn
        .mockResolvedValueOnce({ ok: true }); // custom URL test

      const response = await app.inject({
        method: 'GET',
        url: `/plex/server-connections/${serverId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.server).not.toBeNull();
      // Custom URL row is prepended (unshift), so it's first
      expect(body.server.connections[0].uri).toBe(customUrl);
      expect(body.server.connections[0].custom).toBe(true);
      expect(body.server.connections[0].address).toBe('192.168.1.99');
      expect(body.server.connections[0].port).toBe(9999);
    });

    it('does NOT inject when saved URL matches a plex.tv connection', async () => {
      app = await buildTestApp(ownerUser);

      const matchingUrl = 'http://192.168.1.100:32400'; // matches mockPlexServer.connections[0].uri
      const serverId = randomUUID();

      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          {
            id: serverId,
            token: 'srv-tok',
            name: 'Home',
            url: matchingUrl,
            machineIdentifier: 'mid-abc',
          },
        ]),
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      vi.mocked(PlexClient.getServers).mockResolvedValue([
        { ...mockPlexServer, clientIdentifier: 'mid-abc' },
      ]);

      mockFetch.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true });

      const response = await app.inject({
        method: 'GET',
        url: `/plex/server-connections/${serverId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.server.connections).toHaveLength(2);
      expect(body.server.connections.every((c: { custom?: boolean }) => !c.custom)).toBe(true);
    });
  });

  describe('POST /plex/connect - Temp token consumption', () => {
    let app: FastifyInstance;

    afterEach(async () => {
      if (app) await app.close();
      vi.resetAllMocks();
      mockRedis.get.mockReset();
      mockRedis.setex.mockReset();
      mockRedis.del.mockReset();
    });

    const tempToken = 'temp-token-survives';
    const storedData = {
      plexAccountId: 'plex-account-x',
      plexUsername: 'user',
      plexEmail: 'u@e.com',
      plexThumb: 'https://e.com/u.jpg',
      plexToken: 'plex-token-x',
    };

    it('does NOT delete tempToken when verifyServerAdmin fails (allows retry)', async () => {
      app = await buildUnauthenticatedTestApp();

      mockRedis.get.mockResolvedValue(JSON.stringify(storedData));
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({
        success: false,
        code: 'CONNECTION_FAILED',
        message: 'Cannot reach Plex server',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/plex/connect',
        payload: {
          tempToken,
          serverUri: 'http://localhost:32400',
          serverName: 'My Plex Server',
        },
      });

      expect(response.statusCode).toBe(503);
      // Critical: token survives failure so the user can retry
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('deletes tempToken on successful connect', async () => {
      app = await buildUnauthenticatedTestApp();
      vi.mocked(isClaimCodeEnabled).mockReturnValue(false);

      mockRedis.get.mockResolvedValue(JSON.stringify(storedData));
      mockRedis.del.mockResolvedValue(1);

      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({ success: true });

      const serverId = randomUUID();
      const userId = randomUUID();
      const plexAccountId = randomUUID();

      let selectCallCount = 0;
      const selectMock = {
        from: vi.fn().mockImplementation(() => {
          selectCallCount++;
          if (selectCallCount === 1) {
            return {
              where: vi.fn().mockReturnThis(),
              limit: vi.fn().mockResolvedValue([]),
            };
          }
          return Promise.resolve([]);
        }),
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      vi.mocked(db.insert)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue([{ id: serverId }]),
        } as never)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue([{ id: userId, username: 'user', role: 'owner' }]),
        } as never)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue([{ id: plexAccountId }]),
        } as never)
        .mockReturnValueOnce({
          values: vi.fn().mockResolvedValue(undefined),
        } as never);

      vi.mocked(db.update)
        .mockReturnValueOnce({
          set: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue(undefined),
        } as never)
        .mockReturnValueOnce({
          set: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue(undefined),
        } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/plex/connect',
        payload: {
          tempToken,
          serverUri: 'http://localhost:32400',
          serverName: 'My Plex Server',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining(tempToken));
    });
  });
});
