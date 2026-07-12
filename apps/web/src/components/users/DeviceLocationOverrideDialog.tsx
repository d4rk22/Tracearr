import { useEffect, useState } from 'react';
import type { ChangeEvent, SyntheticEvent } from 'react';
import type {
  DeviceLocationOverride,
  DeviceLocationSearchResult,
  UserDevice,
} from '@tracearr/shared';
import { Loader2, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { useClearDeviceLocation, useSetDeviceLocation } from '@/hooks/queries/useUsers';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  device: UserDevice;
  deviceName: string;
}

const emptyLocation: DeviceLocationOverride = {
  city: '',
  region: null,
  country: '',
  latitude: 0,
  longitude: 0,
};

export function DeviceLocationOverrideDialog({
  open,
  onOpenChange,
  userId,
  device,
  deviceName,
}: Props) {
  const [location, setLocation] = useState<DeviceLocationOverride>(emptyLocation);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<DeviceLocationSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const setMutation = useSetDeviceLocation();
  const clearMutation = useClearDeviceLocation();

  useEffect(() => {
    if (!open) return;
    setLocation(device.locationOverride ?? emptyLocation);
    setSearch('');
    setResults([]);
    setSearchError(null);
  }, [device.locationOverride, open]);

  useEffect(() => {
    const query = search.trim();
    if (!open || query.length < 3) {
      setResults([]);
      setIsSearching(false);
      setSearchError(null);
      return;
    }

    let cancelled = false;
    setIsSearching(true);
    setSearchError(null);
    const timer = setTimeout(() => {
      void api.users
        .searchDeviceLocations(userId, query)
        .then((data) => {
          if (!cancelled) setResults(data);
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setResults([]);
            setSearchError(error instanceof Error ? error.message : 'Location search failed');
          }
        })
        .finally(() => {
          if (!cancelled) setIsSearching(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, search, userId]);

  const selectResult = (result: DeviceLocationSearchResult) => {
    setLocation({
      city: result.city,
      region: result.region,
      country: result.country,
      latitude: result.latitude,
      longitude: result.longitude,
    });
    setSearch(`${result.city}, ${result.region ? `${result.region}, ` : ''}${result.countryName}`);
    setResults([]);
  };

  const isValid =
    !!device.deviceId &&
    location.city.trim().length > 0 &&
    location.country.trim().length > 0 &&
    Number.isFinite(location.latitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    Number.isFinite(location.longitude) &&
    location.longitude >= -180 &&
    location.longitude <= 180;

  const save = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!device.deviceId || !isValid) return;
    setMutation.mutate(
      {
        userId,
        deviceId: device.deviceId,
        location: {
          ...location,
          city: location.city.trim(),
          region: location.region?.trim() || null,
          country: location.country.trim().toUpperCase(),
        },
      },
      { onSuccess: () => onOpenChange(false) }
    );
  };

  const clear = () => {
    if (!device.deviceId) return;
    clearMutation.mutate(
      { userId, deviceId: device.deviceId },
      { onSuccess: () => onOpenChange(false) }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Known device location</DialogTitle>
          <DialogDescription>
            New sessions from {deviceName} will use this exact location instead of GeoIP.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="device-location-search">Find a city</Label>
            <div className="relative">
              <Search className="text-muted-foreground absolute top-2.5 left-3 h-4 w-4" />
              <Input
                id="device-location-search"
                value={search}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setSearch(event.currentTarget.value as string)
                }
                placeholder="Search city or postal code"
                className="pr-9 pl-9"
              />
              {isSearching && (
                <Loader2 className="text-muted-foreground absolute top-2.5 right-3 h-4 w-4 animate-spin" />
              )}
            </div>
            {(results.length > 0 || searchError) && (
              <div className="bg-popover max-h-48 overflow-y-auto rounded-md border p-1 shadow-md">
                {searchError ? (
                  <p className="text-destructive px-2 py-2 text-sm">{searchError}</p>
                ) : (
                  results.map((result) => (
                    <button
                      key={result.id}
                      type="button"
                      className="hover:bg-accent w-full rounded-sm px-2 py-2 text-left text-sm"
                      onClick={() => selectResult(result)}
                    >
                      <span className="font-medium">{result.city}</span>
                      <span className="text-muted-foreground">
                        {result.region ? `, ${result.region}` : ''}, {result.countryName}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
            <p className="text-muted-foreground text-xs">
              Search provided by{' '}
              <a
                href="https://open-meteo.com/"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Open-Meteo
              </a>
              . You can also edit every field manually.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="device-location-city">City</Label>
              <Input
                id="device-location-city"
                value={location.city}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setLocation({ ...location, city: event.currentTarget.value as string })
                }
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-location-region">Region</Label>
              <Input
                id="device-location-region"
                value={location.region ?? ''}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setLocation({
                    ...location,
                    region: (event.currentTarget.value as string) || null,
                  })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-location-country">Country code</Label>
              <Input
                id="device-location-country"
                value={location.country}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setLocation({ ...location, country: event.currentTarget.value as string })
                }
                placeholder="US"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-location-latitude">Latitude</Label>
              <Input
                id="device-location-latitude"
                type="number"
                step="any"
                min={-90}
                max={90}
                value={location.latitude}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setLocation({
                    ...location,
                    latitude: Number(event.currentTarget.value as string),
                  })
                }
                required
              />
            </div>
            <div className="space-y-2 sm:col-start-2">
              <Label htmlFor="device-location-longitude">Longitude</Label>
              <Input
                id="device-location-longitude"
                type="number"
                step="any"
                min={-180}
                max={180}
                value={location.longitude}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setLocation({
                    ...location,
                    longitude: Number(event.currentTarget.value as string),
                  })
                }
                required
              />
            </div>
          </div>

          <DialogFooter className="sm:justify-between">
            <div>
              {device.locationOverride && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={clear}
                  disabled={clearMutation.isPending || setMutation.isPending}
                >
                  Clear override
                </Button>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!isValid || setMutation.isPending}>
                {setMutation.isPending ? 'Saving…' : 'Save location'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
