// Cycle de la tâche planifiée : explore, puis normalize, classify et media par
// lots jusqu'à vider la file, puis refresh de tous les pools. Une étape en échec
// n'arrête pas les suivantes ; le cycle échoue si une étape échoue entièrement.
import { query } from '../db.js';
import { explore } from '../explore/index.js';
import { normalizePending } from '../normalize/index.js';
import { classifyPending } from '../classify/index.js';
import { cacheMedia } from '../media/index.js';
import { listPools, refreshPool } from '../pools/index.js';

const message = (err) => String(err?.message ?? err);

// Un lot plus court que `batch` signale une file vide : les URLs en erreur
// quittent l'état pending, la boucle se termine toujours.
export async function drain(step, batch) {
  const totals = { batches: 0 };
  for (;;) {
    const res = await step(batch);
    totals.batches += 1;
    for (const [key, value] of Object.entries(res)) {
      if (key !== 'runId' && typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
    }
    if (res.processed < batch) return totals;
  }
}

async function runStep(name, fn) {
  try {
    return { name, ...(await fn()) };
  } catch (err) {
    return { name, ok: false, line: `erreur — ${message(err)}` };
  }
}

export async function cycle({ budget, provider, offline = false, batch = 100, exploreOptions = {} }) {
  const steps = [];

  steps.push(
    await runStep('explore', async () => {
      const res = await explore({ budget, provider, ...exploreOptions });
      const failed = res.queries.filter((q) => q.error);
      const detail = failed.map((q) => ` ; #${q.id} en échec : ${q.error}`).join('');
      return {
        ok: res.calls === 0 || failed.length < res.calls,
        line: `${res.calls} appels, ${res.newUrls} URLs nouvelles, ${res.newDomains} domaines nouveaux, ${res.errors} erreurs${detail}`,
        result: res,
      };
    }),
  );

  steps.push(
    await runStep('normalize', async () => {
      const t = await drain(async (limit) => {
        const res = await normalizePending({ limit, offline });
        return { ...res, processed: res.total };
      }, batch);
      return {
        ok: true,
        line: `${t.normalized} normalisées, ${t.duplicate} doublons, ${t.error} erreurs (${t.batches} lots)`,
        result: t,
      };
    }),
  );

  steps.push(
    await runStep('classify', async () => {
      const t = await drain(async (limit) => {
        const res = await classifyPending({ limit });
        return { ...res, processed: res.classified };
      }, batch);
      const { rows } = await query('SELECT count(*)::int AS n FROM domain_profile WHERE usage_commercial IS NULL');
      return {
        ok: true,
        line: `${t.classified} classées, dont ${t.unthemed} sans thème ; ${rows[0].n} domaines à qualifier`,
        result: { ...t, toQualify: rows[0].n },
      };
    }),
  );

  // Hors ligne, aucune image n'est téléchargée : l'étape est sautée.
  steps.push(
    await runStep('media', async () => {
      if (offline) return { ok: true, line: 'sautée (hors ligne)', result: null };
      const t = await drain(async (limit) => {
        const res = await cacheMedia({ limit });
        return { ...res, processed: res.total };
      }, batch);
      return {
        ok: true,
        line: `${t.thumbs} vignettes, ${t.favicons} favicons, ${t.failed} échecs (${t.batches} lots)`,
        result: t,
      };
    }),
  );

  steps.push(
    await runStep('pools', async () => {
      const pools = await listPools();
      const parts = [];
      let failures = 0;
      for (const p of pools) {
        try {
          parts.push(`${p.slug} ${(await refreshPool(p.slug)).count}`);
        } catch (err) {
          failures += 1;
          parts.push(`${p.slug} erreur — ${message(err)}`);
        }
      }
      return {
        ok: pools.length === 0 || failures < pools.length,
        line: pools.length ? `${pools.length - failures}/${pools.length} rafraîchis : ${parts.join(', ')}` : 'aucun pool',
        result: { pools: pools.length, failures },
      };
    }),
  );

  return { ok: steps.every((s) => s.ok), steps };
}
