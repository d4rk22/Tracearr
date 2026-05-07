import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildExternalIdMatchKey } from '../buildExternalIdMatchKey.js';
import { libraryItems } from '../../../db/schema.js';

const dialect = new PgDialect();

function compile(table = libraryItems) {
  return dialect.sqlToQuery(buildExternalIdMatchKey(table)).sql;
}

describe('buildExternalIdMatchKey', () => {
  it('compiles to SQL referencing imdb_id, tmdb_id, and tvdb_id', () => {
    const text = compile();
    expect(text).toMatch(/imdb_id/);
    expect(text).toMatch(/tmdb_id/);
    expect(text).toMatch(/tvdb_id/);
  });

  it('falls back to a normalized title via LOWER + REGEXP_REPLACE', () => {
    const text = compile();
    expect(text).toMatch(/LOWER/i);
    expect(text).toMatch(/REGEXP_REPLACE/i);
  });

  it('prefixes external ids with their kind so an imdb_id never collides with a tmdb_id of the same value', () => {
    const text = compile();
    expect(text).toContain("'imdb:'");
    expect(text).toContain("'tmdb:'");
    expect(text).toContain("'tvdb:'");
  });

  it('orders the COALESCE branches imdb → tmdb → tvdb → title', () => {
    const text = compile();
    const imdb = text.indexOf('imdb_id');
    const tmdb = text.indexOf('tmdb_id');
    const tvdb = text.indexOf('tvdb_id');
    const titleFallback = text.search(/LOWER/i);
    expect(imdb).toBeLessThan(tmdb);
    expect(tmdb).toBeLessThan(tvdb);
    expect(tvdb).toBeLessThan(titleFallback);
  });
});
