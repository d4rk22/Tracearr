import { describe, expect, it, vi } from 'vitest';
import { recordSuccessfulPoll } from '../serverPollFreshness.js';

describe('recordSuccessfulPoll', () => {
  it('records the supplied observation time after success', async () => {
    const setServerLastSuccessfulPollAt = vi.fn();
    const observedAt = new Date('2026-07-22T12:00:00.000Z');

    await recordSuccessfulPoll({ setServerLastSuccessfulPollAt }, 'server-1', true, observedAt);

    expect(setServerLastSuccessfulPollAt).toHaveBeenCalledWith('server-1', observedAt);
  });

  it('does not advance freshness after a failed poll', async () => {
    const setServerLastSuccessfulPollAt = vi.fn();

    await recordSuccessfulPoll({ setServerLastSuccessfulPollAt }, 'server-1', false);

    expect(setServerLastSuccessfulPollAt).not.toHaveBeenCalled();
  });
});
