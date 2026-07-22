import type { CacheService } from './cache.js';

/** Record only completed, successful full session polls. */
export async function recordSuccessfulPoll(
  cache: Pick<CacheService, 'setServerLastSuccessfulPollAt'>,
  serverId: string,
  succeeded: boolean,
  observedAt = new Date()
): Promise<void> {
  if (!succeeded) return;
  await cache.setServerLastSuccessfulPollAt(serverId, observedAt);
}
