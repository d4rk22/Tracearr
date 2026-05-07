import { sql, type SQL } from 'drizzle-orm';
import type { libraryItems } from '../../db/schema.js';

type LibraryItemsTable = typeof libraryItems;

export function buildExternalIdMatchKey(table: LibraryItemsTable): SQL {
  return sql`COALESCE(
    CASE WHEN ${table.imdbId} IS NOT NULL AND ${table.imdbId} <> '' THEN 'imdb:' || ${table.imdbId} END,
    CASE WHEN ${table.tmdbId} IS NOT NULL AND ${table.tmdbId} <> '' THEN 'tmdb:' || ${table.tmdbId} END,
    CASE WHEN ${table.tvdbId} IS NOT NULL AND ${table.tvdbId} <> '' THEN 'tvdb:' || ${table.tvdbId} END,
    'title:' || LOWER(REGEXP_REPLACE(COALESCE(${table.title}, ''), '[^a-zA-Z0-9]', '', 'g'))
  )`;
}
