import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { deviceLocationOverrides } from '../db/schema.js';
import type { GeoLocation } from './geoip.js';

export type DeviceLocationOverrideRow = Pick<
  typeof deviceLocationOverrides.$inferSelect,
  'city' | 'region' | 'country' | 'latitude' | 'longitude'
>;

export function applyDeviceLocationOverride(
  geo: GeoLocation,
  override: DeviceLocationOverrideRow | null
): GeoLocation {
  if (!override) return geo;

  return {
    ...geo,
    city: override.city,
    region: override.region,
    country: override.country,
    countryCode: override.country,
    continent: null,
    postal: null,
    lat: override.latitude,
    lon: override.longitude,
  };
}

export async function resolveDeviceLocation(
  serverUserId: string,
  deviceId: string | null | undefined,
  geo: GeoLocation
): Promise<GeoLocation> {
  if (!deviceId) return geo;

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
        eq(deviceLocationOverrides.serverUserId, serverUserId),
        eq(deviceLocationOverrides.deviceId, deviceId)
      )
    )
    .limit(1);

  return applyDeviceLocationOverride(geo, override ?? null);
}
