// Étapes du pipeline partagées par `cycle` et `requests run` : normalize,
// classify et media par lots jusqu'à vider la file, puis refresh de pools.
// Chaque étape est isolée : une étape en échec n'arrête pas les suivantes et
// revient sous la forme { name, ok: false, line }.
import { query } from '../db.js';
import { normalizePending } from '../normalize/index.js';
import { classifyPending } from '../classify/index.js';
import { cacheMedia } from '../media/index.js';
import { refreshPool } from '../pools/index.js';

export const message = (err) => String(err?.message ?? err);

// Un lot plus court que `batch` signale une file vide : les URLs en erreur
// quittent l'état pending, la boucle se termine toujours. `maxBatches` borne
// le nombre de lots.
export async function drain(step, batch, { maxBatches = Infinity } = {}) {
  const totals = { batches: 0 };
  for (;;) {
    const res = await step(batch);
    totals.batches += 1;
    for (const [key, value] of Object.entries(res)) {
      if (key !== 'runId' && typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
    }
    if (res.processed < batch || totals.batches >= maxBatches) return totals;
  }
}

export async function runStep(name, fn) {
  try {
    return { name, ...(await fn()) };
  } catch (err) {
    return { name, ok: false, line: `erreur — ${message(err)}` };
  }
}

// normalize, classify et media. `ids` restreint normalize et classify à ces
// URLs (null : toute la file) ; `mediaBatches` borne les lots de médias.
export async function processPending({ offline = false, batch = 100, ids = null, mediaBatches = Infinity } = {}) {
  const steps = [];
  steps.push(
    await runStep('normalize', async () => {
      const t = await drain(async (limit) => {
        const res = await normalizePending({ limit, offline, ids });
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
        const res = await classifyPending({ limit, onlyIds: ids });
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
      }, batch, { maxBatches: mediaBatches });
      return {
        ok: true,
        line: `${t.thumbs} vignettes, ${t.favicons} favicons, ${t.failed} échecs (${t.batches} lots)`,
        result: t,
      };
    }),
  );
  return steps;
}

// Refresh des pools nommés ; l'étape n'échoue que si tous échouent.
export function refreshPools(slugs) {
  return runStep('pools', async () => {
    const parts = [];
    const results = [];
    let failures = 0;
    for (const slug of slugs) {
      try {
        const { count } = await refreshPool(slug);
        parts.push(`${slug} ${count}`);
        results.push({ slug, count });
      } catch (err) {
        failures += 1;
        parts.push(`${slug} erreur — ${message(err)}`);
        results.push({ slug, error: message(err) });
      }
    }
    return {
      ok: slugs.length === 0 || failures < slugs.length,
      line: slugs.length ? `${slugs.length - failures}/${slugs.length} rafraîchis : ${parts.join(', ')}` : 'aucun pool',
      result: { pools: slugs.length, failures, items: results },
    };
  });
}
