import { query } from './db.js';

export async function startRun(kind, detail = {}) {
  const { rows } = await query(
    'INSERT INTO processing_run (kind, detail) VALUES ($1, $2) RETURNING id',
    [kind, JSON.stringify(detail)],
  );
  return rows[0].id;
}

export async function finishRun(id, status = 'done', extraDetail = null) {
  await query(
    `UPDATE processing_run
        SET status = $2,
            finished_at = now(),
            detail = CASE WHEN $3::jsonb IS NULL THEN detail ELSE detail || $3::jsonb END
      WHERE id = $1`,
    [id, status, extraDetail ? JSON.stringify(extraDetail) : null],
  );
}
