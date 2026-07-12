import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeoLocation } from '../geoip.js';

vi.mock('../../db/client.js', () => ({ db: {} }));

import { applyDeviceLocationOverride } from '../deviceLocationOverrides.js';

const ipLocation: GeoLocation = {
  city: 'New York',
  region: 'New York',
  country: 'United States',
  countryCode: 'US',
  continent: 'North America',
  postal: '10001',
  lat: 40.7128,
  lon: -74.006,
  asnNumber: 64500,
  asnOrganization: 'Example ISP',
};

describe('device location overrides', () => {
  beforeEach(() => vi.clearAllMocks());

  it('takes precedence over IP-derived location fields', () => {
    const result = applyDeviceLocationOverride(ipLocation, {
      city: 'Lincoln',
      region: 'Nebraska',
      country: 'US',
      latitude: 40.8136,
      longitude: -96.7026,
    });

    expect(result).toMatchObject({
      city: 'Lincoln',
      region: 'Nebraska',
      country: 'US',
      countryCode: 'US',
      lat: 40.8136,
      lon: -96.7026,
      continent: null,
      postal: null,
    });
    expect(result.asnNumber).toBe(64500);
  });

  it('leaves GeoIP unchanged when no override exists', () => {
    expect(applyDeviceLocationOverride(ipLocation, null)).toBe(ipLocation);
  });
});
