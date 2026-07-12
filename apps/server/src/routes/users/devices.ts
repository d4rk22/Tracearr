/**
 * User Devices Routes
 *
 * Device history is aggregated from sessions. Admins can also manage an exact,
 * user-scoped location override for stable device GUIDs.
 */

import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { userIdParamSchema } from '@tracearr/shared';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { deviceLocationOverrides, serverUsers } from '../../db/schema.js';
import { queryUserDevices } from './queries.js';

const deviceParamsSchema = userIdParamSchema.extend({
  deviceId: z.string().trim().min(1).max(255),
});

const locationOverrideSchema = z.object({
  city: z.string().trim().min(1).max(255),
  region: z.string().trim().max(255).nullable(),
  country: z.string().trim().min(1).max(100),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

const locationSearchSchema = z.object({
  q: z.string().trim().min(3).max(100),
});

const openMeteoResultSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.number(),
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        country_code: z.string(),
        country: z.string(),
        admin1: z.string().optional(),
      })
    )
    .optional(),
});

function canManageDeviceLocations(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

async function findServerUser(id: string) {
  const rows = await db
    .select({ id: serverUsers.id, serverId: serverUsers.serverId })
    .from(serverUsers)
    .where(eq(serverUsers.id, id))
    .limit(1);
  return rows[0];
}

export const devicesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:id/devices', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid user ID');

    const serverUser = await findServerUser(params.data.id);
    if (!serverUser) return reply.notFound('User not found');
    if (!request.user.serverIds.includes(serverUser.serverId)) {
      return reply.forbidden('You do not have access to this user');
    }

    return { data: await queryUserDevices(db, serverUser.id) };
  });

  app.get(
    '/:id/devices/location-search',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = userIdParamSchema.safeParse(request.params);
      const query = locationSearchSchema.safeParse(request.query);
      if (!params.success) return reply.badRequest('Invalid user ID');
      if (!query.success) return reply.badRequest('Enter at least 3 characters to search');
      if (!canManageDeviceLocations(request.user.role)) {
        return reply.forbidden('Only administrators can manage device locations');
      }

      const serverUser = await findServerUser(params.data.id);
      if (!serverUser) return reply.notFound('User not found');
      if (!request.user.serverIds.includes(serverUser.serverId)) {
        return reply.forbidden('You do not have access to this user');
      }

      try {
        const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
        url.searchParams.set('name', query.data.q);
        url.searchParams.set('count', '10');
        url.searchParams.set('language', 'en');
        url.searchParams.set('format', 'json');
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Open-Meteo returned ${response.status}`);

        const parsed = openMeteoResultSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error('Open-Meteo returned an invalid response');

        return {
          data: (parsed.data.results ?? []).map((result) => ({
            id: result.id,
            city: result.name,
            region: result.admin1?.trim() || null,
            country: result.country_code.toUpperCase(),
            countryName: result.country,
            latitude: result.latitude,
            longitude: result.longitude,
          })),
        };
      } catch (error) {
        request.log.warn({ error }, 'Device location search failed');
        return reply.code(502).send({ error: 'Location search is temporarily unavailable' });
      }
    }
  );

  app.get(
    '/:id/devices/:deviceId/location',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = deviceParamsSchema.safeParse(request.params);
      if (!params.success) return reply.badRequest('Invalid user or device ID');
      if (!canManageDeviceLocations(request.user.role)) {
        return reply.forbidden('Only administrators can manage device locations');
      }

      const serverUser = await findServerUser(params.data.id);
      if (!serverUser) return reply.notFound('User not found');
      if (!request.user.serverIds.includes(serverUser.serverId)) {
        return reply.forbidden('You do not have access to this user');
      }

      const [override] = await db
        .select({
          city: deviceLocationOverrides.city,
          region: deviceLocationOverrides.region,
          country: deviceLocationOverrides.country,
          latitude: deviceLocationOverrides.latitude,
          longitude: deviceLocationOverrides.longitude,
        })
        .from(deviceLocationOverrides)
        .where(
          and(
            eq(deviceLocationOverrides.serverUserId, serverUser.id),
            eq(deviceLocationOverrides.deviceId, params.data.deviceId)
          )
        )
        .limit(1);

      return { data: override ?? null };
    }
  );

  app.put(
    '/:id/devices/:deviceId/location',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = deviceParamsSchema.safeParse(request.params);
      const body = locationOverrideSchema.safeParse(request.body);
      if (!params.success) return reply.badRequest('Invalid user or device ID');
      if (!body.success) return reply.badRequest('Invalid device location');
      if (!canManageDeviceLocations(request.user.role)) {
        return reply.forbidden('Only administrators can manage device locations');
      }

      const serverUser = await findServerUser(params.data.id);
      if (!serverUser) return reply.notFound('User not found');
      if (!request.user.serverIds.includes(serverUser.serverId)) {
        return reply.forbidden('You do not have access to this user');
      }

      const values = {
        serverUserId: serverUser.id,
        deviceId: params.data.deviceId,
        ...body.data,
        country: body.data.country.toUpperCase(),
        updatedAt: new Date(),
      };
      const [override] = await db
        .insert(deviceLocationOverrides)
        .values(values)
        .onConflictDoUpdate({
          target: [deviceLocationOverrides.serverUserId, deviceLocationOverrides.deviceId],
          set: {
            city: values.city,
            region: values.region,
            country: values.country,
            latitude: values.latitude,
            longitude: values.longitude,
            updatedAt: values.updatedAt,
          },
        })
        .returning({
          city: deviceLocationOverrides.city,
          region: deviceLocationOverrides.region,
          country: deviceLocationOverrides.country,
          latitude: deviceLocationOverrides.latitude,
          longitude: deviceLocationOverrides.longitude,
        });

      return { data: override };
    }
  );

  app.delete(
    '/:id/devices/:deviceId/location',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = deviceParamsSchema.safeParse(request.params);
      if (!params.success) return reply.badRequest('Invalid user or device ID');
      if (!canManageDeviceLocations(request.user.role)) {
        return reply.forbidden('Only administrators can manage device locations');
      }

      const serverUser = await findServerUser(params.data.id);
      if (!serverUser) return reply.notFound('User not found');
      if (!request.user.serverIds.includes(serverUser.serverId)) {
        return reply.forbidden('You do not have access to this user');
      }

      await db
        .delete(deviceLocationOverrides)
        .where(
          and(
            eq(deviceLocationOverrides.serverUserId, serverUser.id),
            eq(deviceLocationOverrides.deviceId, params.data.deviceId)
          )
        );
      return { success: true };
    }
  );
};
