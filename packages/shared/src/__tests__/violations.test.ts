import { describe, it, expect } from 'vitest';
import { formatUserList, formatEvidenceDescription } from '../violations.js';
import type { GroupEvidence } from '../types.js';

describe('formatUserList', () => {
  it('returns "no users" for empty input', () => {
    expect(formatUserList([], {})).toBe('no users');
  });

  it('joins resolved names with ", "', () => {
    const names = { 'id-1': 'Alice', 'id-2': 'Bob' };
    expect(formatUserList(['id-1', 'id-2'], names)).toBe('Alice, Bob');
  });

  it('falls back to "unknown user" for missing id', () => {
    expect(formatUserList(['id-missing'], {})).toBe('unknown user');
  });

  it('mixes resolved and unresolved names', () => {
    const names = { 'id-1': 'Alice' };
    expect(formatUserList(['id-1', 'id-missing'], names)).toBe('Alice, unknown user');
  });

  it('shows all names when count is at the max', () => {
    const names = { a: 'A', b: 'B', c: 'C' };
    expect(formatUserList(['a', 'b', 'c'], names, { max: 3 })).toBe('A, B, C');
  });

  it('truncates with "+N more" when count exceeds max', () => {
    const names = { a: 'A', b: 'B', c: 'C', d: 'D' };
    expect(formatUserList(['a', 'b', 'c', 'd'], names, { max: 2 })).toBe('A, B +2 more');
  });

  it('works with a single id', () => {
    expect(formatUserList(['x'], { x: 'Xavier' })).toBe('Xavier');
  });
});

describe('formatEvidenceDescription (count behavior preserved)', () => {
  it('emits count text for user_id not_in condition', () => {
    const evidence: GroupEvidence[] = [
      {
        groupIndex: 0,
        matched: true,
        conditions: [
          {
            field: 'user_id',
            operator: 'not_in',
            threshold: ['id-1', 'id-2', 'id-3'],
            actual: 'some-id',
            matched: true,
          },
        ],
      },
    ];

    const result = formatEvidenceDescription(evidence);
    expect(result).toContain('3 excluded users');
    expect(result).not.toContain('id-1');
  });

  it('emits singular for one excluded user', () => {
    const evidence: GroupEvidence[] = [
      {
        groupIndex: 0,
        matched: true,
        conditions: [
          {
            field: 'user_id',
            operator: 'in',
            threshold: ['id-1'],
            actual: 'other-id',
            matched: true,
          },
        ],
      },
    ];

    const result = formatEvidenceDescription(evidence);
    expect(result).toContain('1 excluded user');
  });
});
