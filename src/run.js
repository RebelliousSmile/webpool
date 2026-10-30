import { query } from './db.js';

export async function startRun(kind, detail = {}) {
  const { rows } = await query(
    'INSERT INTO processing_run (kind, detail) VALUES ($1, $2) RETURNING id',
    [kind, JSON.stringify(detail)],
  );
  return rows[0].id;
}

// Patron unique d'un run : `fn(runId)` renvoie le détail du succès, enregistré
// avec le statut `done` et renvoyé au côté de `runId` ; une erreur clôt le run
// en `failed` puis est relancée.
export async function withRun(kind, detail, fn) {
  const runId = await startRun(kind, detail);
  let result;
  try {
    result = await fn(runId);
  } catch (err) {
    await finishRun(runId, 'failed', { error: String(err.message ?? err) }).catch(() => {});
    throw err;
  }
  await finishRun(runId, 'done', result);
  return { runId, ...result };
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
