/** Shared User Query Functions **/

import type { UserDevice } from '@tracearr/shared';
import { eq, sql } from 'drizzle-orm';
import type { db as defaultDb } from '../../db/client.js';
import { deviceLocationOverrides } from '../../db/schema.js';

// Accept either the default db or a transaction context
type DbOrTx = typeof defaultDb;

interface DeviceSessionRow {
  device_id: string | null;
  player_name: string | null;
  product: string | null;
  device: string | null;
  platform: string | null;
  started_at: Date;
  geo_city: string | null;
  geo_region: string | null;
  geo_country: string | null;
}

/**
 * Query deduplicated device sessions and aggregate into UserDevice[].
 * Uses DISTINCT ON to collapse pause/resume chains into one row per play,
 * then groups by device key with per-device location breakdowns.
 */
export async function queryUserDevices(
  dbOrTx: DbOrTx,
  serverUserId: string
): Promise<UserDevice[]> {
  const [result, overrides] = await Promise.all([
    dbOrTx.execute(sql`
      SELECT DISTINCT ON (COALESCE(reference_id, id))
        device_id, player_name, product, device, platform, started_at,
        geo_city, geo_region, geo_country
      FROM sessions
      WHERE server_user_id = ${serverUserId}
      ORDER BY COALESCE(reference_id, id), started_at DESC
    `),
    dbOrTx
      .select({
        deviceId: deviceLocationOverrides.deviceId,
        city: deviceLocationOverrides.city,
        region: deviceLocationOverrides.region,
        country: deviceLocationOverrides.country,
        latitude: deviceLocationOverrides.latitude,
        longitude: deviceLocationOverrides.longitude,
      })
      .from(deviceLocationOverrides)
      .where(eq(deviceLocationOverrides.serverUserId, serverUserId)),
  ]);
  const overridesByDeviceId = new Map(overrides.map((override) => [override.deviceId, override]));

  // Raw SQL returns timestamps as strings — coerce to Date for comparisons
  const sessionData = (result.rows as unknown as DeviceSessionRow[]).map((r) => ({
    ...r,
    started_at: new Date(r.started_at),
  }));

  const deviceMap = new Map<
    string,
    {
      deviceId: string | null;
      playerName: string | null;
      product: string | null;
      device: string | null;
      platform: string | null;
      sessionCount: number;
      lastSeenAt: Date;
      locationMap: Map<
        string,
        {
          city: string | null;
          region: string | null;
          country: string | null;
          sessionCount: number;
          lastSeenAt: Date;
        }
      >;
    }
  >();

  for (const session of sessionData) {
    const key =
      session.device_id ??
      session.player_name ??
      `${session.product ?? 'unknown'}-${session.device ?? 'unknown'}-${session.platform ?? 'unknown'}`;

    const existing = deviceMap.get(key);
    if (existing) {
      existing.sessionCount++;
      if (session.started_at > existing.lastSeenAt) {
        existing.lastSeenAt = session.started_at;
        existing.playerName = session.player_name ?? existing.playerName;
        existing.product = session.product ?? existing.product;
        existing.device = session.device ?? existing.device;
        existing.platform = session.platform ?? existing.platform;
      }

      const locKey = `${session.geo_city ?? ''}-${session.geo_region ?? ''}-${session.geo_country ?? ''}`;
      const existingLoc = existing.locationMap.get(locKey);
      if (existingLoc) {
        existingLoc.sessionCount++;
        if (session.started_at > existingLoc.lastSeenAt) {
          existingLoc.lastSeenAt = session.started_at;
        }
      } else {
        existing.locationMap.set(locKey, {
          city: session.geo_city,
          region: session.geo_region,
          country: session.geo_country,
          sessionCount: 1,
          lastSeenAt: session.started_at,
        });
      }
    } else {
      const locationMap = new Map<
        string,
        {
          city: string | null;
          region: string | null;
          country: string | null;
          sessionCount: number;
          lastSeenAt: Date;
        }
      >();
      const locKey = `${session.geo_city ?? ''}-${session.geo_region ?? ''}-${session.geo_country ?? ''}`;
      locationMap.set(locKey, {
        city: session.geo_city,
        region: session.geo_region,
        country: session.geo_country,
        sessionCount: 1,
        lastSeenAt: session.started_at,
      });

      deviceMap.set(key, {
        deviceId: session.device_id,
        playerName: session.player_name,
        product: session.product,
        device: session.device,
        platform: session.platform,
        sessionCount: 1,
        lastSeenAt: session.started_at,
        locationMap,
      });
    }
  }

  return Array.from(deviceMap.values())
    .map((dev) => ({
      deviceId: dev.deviceId,
      playerName: dev.playerName,
      product: dev.product,
      device: dev.device,
      platform: dev.platform,
      sessionCount: dev.sessionCount,
      lastSeenAt: dev.lastSeenAt,
      locations: Array.from(dev.locationMap.values()).sort(
        (a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime()
      ),
      locationOverride: dev.deviceId ? (overridesByDeviceId.get(dev.deviceId) ?? null) : null,
    }))
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
}
