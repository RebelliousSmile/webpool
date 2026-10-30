import { query } from './db.js';

// webpool stats : répartition des URLs par statut et des runs par type.
export async function stats() {
  const { rows: byStatus } = await query(
    'SELECT status, count(*)::int AS n FROM url_item GROUP BY status ORDER BY status',
  );
  const { rows: runs } = await query(
    `SELECT kind, status, count(*)::int AS n FROM processing_run GROUP BY kind, status ORDER BY kind`,
  );
  return { url_item: byStatus, processing_run: runs };
}
