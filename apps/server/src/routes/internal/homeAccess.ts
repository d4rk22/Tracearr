/**
 * Private, least-data contract for the Home-access integration.
 *
 * These routes intentionally use a dedicated runtime bearer credential and
 * return only stable Plex subject/network observations. They are not part of
 * the public API token or owner JWT authentication surfaces.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { getCacheService } from '../../services/cache.js';

const HOME_TOKEN_PREFIX = 'trr_home_';
const HOME_TOKEN_PATTERN = /^trr_home_[A-Za-z0-9_-]{32,128}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HISTORY_DAYS = 30;
const MAX_HISTORY_DAYS = 90;
const MAX_SUBJECT_IDS = 50;
const DEFAULT_RESULT_LIMIT = 200;
const MAX_RESULT_LIMIT = 500;

const liveQuerySchema = z
  .object({
    serverId: z.uuid(),
  })
  .strict();

const historyQuerySchema = z
  .object({
    serverId: z.uuid(),
    subjectIds: z
      .array(z.string().trim().min(1).max(255))
      .min(1)
      .max(MAX_SUBJECT_IDS)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'subjectIds must not contain duplicates',
      }),
    window: z
      .object({
        start: z.iso.datetime(),
        end: z.iso.datetime(),
      })
      .strict()
      .optional(),
    resultLimit: z.number().int().positive().max(MAX_RESULT_LIMIT).default(DEFAULT_RESULT_LIMIT),
  })
  .strict();

interface PlexServerRow {
  id: string;
  type: string;
}

interface SubjectMappingRow {
  server_user_id: string;
  subject_id: string | null;
}

interface HistoryAggregateRow {
  subject_id: string;
  server_id: string;
  ip_address: string;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  play_count: number | string;
  active_days: number | string;
}

export interface HistoryAggregateQueryInput {
  serverId: string;
  subjectIds: string[];
  windowStart: Date;
  windowEnd: Date;
  resultLimit: number;
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Verify the dedicated credential without short-circuiting the digest compare.
 * An unset or malformed runtime value always fails closed.
 */
export function verifyHomeAccessToken(
  authorization: string | undefined,
  configuredToken = process.env.TRACEARR_HOME_ACCESS_API_TOKEN
): boolean {
  const configuredIsValid =
    typeof configuredToken === 'string' && HOME_TOKEN_PATTERN.test(configuredToken);
  const candidate = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const candidateIsValid = HOME_TOKEN_PATTERN.test(candidate);
  const comparisonToken = configuredIsValid
    ? configuredToken
    : `${HOME_TOKEN_PREFIX}${'0'.repeat(32)}`;

  const matches = timingSafeEqual(tokenDigest(candidate), tokenDigest(comparisonToken));
  return configuredIsValid && candidateIsValid && matches;
}

async function authenticateHomeAccess(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!verifyHomeAccessToken(request.headers.authorization)) {
    await reply.unauthorized('Invalid Home-access credential');
  }
}

async function loadPlexServer(serverId: string): Promise<PlexServerRow | null> {
  const result = await db.execute(sql`
    SELECT id, type
    FROM servers
    WHERE id = ${serverId}
    LIMIT 1
  `);
  const server = result.rows[0] as PlexServerRow | undefined;
  return server ?? null;
}

async function loadSubjectMappings(
  serverId: string,
  serverUserIds?: string[],
  subjectIds?: string[]
): Promise<SubjectMappingRow[]> {
  const conditions: SQL[] = [sql`server_id = ${serverId}`, sql`removed_at IS NULL`];

  if (serverUserIds) {
    if (serverUserIds.length === 0) return [];
    conditions.push(
      sql`id IN (${sql.join(
        serverUserIds.map((id) => sql`${id}`),
        sql`, `
      )})`
    );
  }

  if (subjectIds) {
    conditions.push(
      sql`plex_account_id IN (${sql.join(
        subjectIds.map((id) => sql`${id}`),
        sql`, `
      )})`
    );
  }

  const result = await db.execute(sql`
    SELECT id AS server_user_id, plex_account_id AS subject_id
    FROM server_users
    WHERE ${sql.join(conditions, sql` AND `)}
  `);
  return result.rows as unknown as SubjectMappingRow[];
}

export function buildHistoryAggregateQuery(input: HistoryAggregateQueryInput): SQL {
  const { serverId, subjectIds, windowStart, windowEnd, resultLimit } = input;

  return sql`
    SELECT
      su.plex_account_id AS subject_id,
      s.server_id,
      s.ip_address,
      MIN(s.started_at) AS first_seen_at,
      MAX(s.last_seen_at) AS last_seen_at,
      COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int AS play_count,
      COUNT(DISTINCT (s.started_at AT TIME ZONE 'UTC')::date)::int AS active_days
    FROM sessions s
    INNER JOIN server_users su ON su.id = s.server_user_id
    WHERE s.server_id = ${serverId}
      AND su.plex_account_id IN (${sql.join(
        subjectIds.map((id) => sql`${id}`),
        sql`, `
      )})
      AND s.started_at >= ${windowStart}
      AND s.started_at < ${windowEnd}
    GROUP BY su.plex_account_id, s.server_id, s.ip_address
    ORDER BY su.plex_account_id ASC, s.ip_address ASC
    LIMIT ${resultLimit + 1}
  `;
}

function resolveHistoryWindow(
  window: { start: string; end: string } | undefined,
  now: Date
): { start: Date; end: Date } | null {
  const end = window ? new Date(window.end) : now;
  const start = window
    ? new Date(window.start)
    : new Date(end.getTime() - DEFAULT_HISTORY_DAYS * DAY_MS);

  if (start >= end || end > now || end.getTime() - start.getTime() > MAX_HISTORY_DAYS * DAY_MS) {
    return null;
  }

  return { start, end };
}

const privateRouteOptions = {
  logLevel: 'silent' as const,
  preHandler: [authenticateHomeAccess],
};

export const homeAccessRoutes: FastifyPluginAsync = async (app) => {
  // Apply to success and error responses, including authentication/rate-limit failures.
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  app.get(
    '/viewers',
    {
      ...privateRouteOptions,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = liveQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.badRequest('A valid Plex serverId is required');
      }

      const { serverId } = parsed.data;
      const server = await loadPlexServer(serverId);
      if (!server) return reply.notFound('Server not found');
      if (server.type !== 'plex') return reply.badRequest('Home access requires a Plex server');

      const cache = getCacheService();
      if (!cache) return reply.serviceUnavailable('Active-session cache unavailable');

      const activeSessions = (await cache.getAllActiveSessions()).filter(
        (session) => session.serverId === serverId && session.server.type === 'plex'
      );
      const serverUserIds = [...new Set(activeSessions.map((session) => session.serverUserId))];
      const mappings = await loadSubjectMappings(serverId, serverUserIds);
      const subjectByServerUser = new Map(
        mappings
          .filter((row): row is SubjectMappingRow & { subject_id: string } => !!row.subject_id)
          .map((row) => [row.server_user_id, row.subject_id])
      );

      const observations = new Map<
        string,
        {
          subjectId: string;
          serverId: string;
          ipAddress: string;
          isLocal: boolean;
          connectionKind: 'direct' | 'relay' | 'unknown';
        }
      >();

      for (const session of activeSessions) {
        const subjectId = subjectByServerUser.get(session.serverUserId);
        // Older cache entries may lack isLocal during a rolling upgrade. Omit
        // them instead of fabricating a locality classification.
        if (!subjectId || typeof session.isLocal !== 'boolean') continue;
        const connectionKind: 'direct' | 'relay' | 'unknown' =
          session.connectionKind === 'direct' || session.connectionKind === 'relay'
            ? session.connectionKind
            : 'unknown';
        const observation = {
          subjectId,
          serverId,
          ipAddress: session.ipAddress,
          isLocal: session.isLocal,
          connectionKind,
        };
        observations.set(
          `${subjectId}\u0000${session.ipAddress}\u0000${String(session.isLocal)}\u0000${connectionKind}`,
          observation
        );
      }

      const snapshotAt = new Date();
      const lastSuccessfulPollAt = await cache.getServerLastSuccessfulPollAt(serverId);

      return {
        schemaVersion: 1,
        snapshotAt: snapshotAt.toISOString(),
        serverFreshness: {
          serverId,
          lastSuccessfulPollAt: lastSuccessfulPollAt?.toISOString() ?? null,
        },
        observations: [...observations.values()],
      };
    }
  );

  app.post(
    '/history-query',
    {
      ...privateRouteOptions,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = historyQuerySchema.safeParse(request.body);
      if (!parsed.success) return reply.badRequest('Invalid history query');

      const now = new Date();
      const window = resolveHistoryWindow(parsed.data.window, now);
      if (!window)
        return reply.badRequest('History window must be valid, non-future, and at most 90 days');

      const { serverId, subjectIds, resultLimit } = parsed.data;
      const server = await loadPlexServer(serverId);
      if (!server) return reply.notFound('Server not found');
      if (server.type !== 'plex') return reply.badRequest('Home access requires a Plex server');

      const mappings = await loadSubjectMappings(serverId, undefined, subjectIds);
      const knownSubjectIds = new Set(
        mappings.map((row) => row.subject_id).filter((id): id is string => !!id)
      );
      if (subjectIds.some((id) => !knownSubjectIds.has(id))) {
        return reply.badRequest('One or more subjects are unknown or outside the selected server');
      }

      const result = await db.execute(
        buildHistoryAggregateQuery({
          serverId,
          subjectIds,
          windowStart: window.start,
          windowEnd: window.end,
          resultLimit,
        })
      );
      const rows = result.rows as unknown as HistoryAggregateRow[];
      if (rows.length > resultLimit) {
        return reply.unprocessableEntity('History result exceeds the requested resultLimit');
      }

      return {
        schemaVersion: 1,
        generatedAt: now.toISOString(),
        windowStart: window.start.toISOString(),
        windowEnd: window.end.toISOString(),
        rows: rows.map((row) => ({
          subjectId: row.subject_id,
          serverId: row.server_id,
          ipAddress: row.ip_address,
          firstSeenAt: new Date(row.first_seen_at).toISOString(),
          lastSeenAt: new Date(row.last_seen_at).toISOString(),
          playCount: Number(row.play_count),
          activeDays: Number(row.active_days),
        })),
      };
    }
  );
};
