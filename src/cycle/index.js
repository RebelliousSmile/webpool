// Cycle de la tâche planifiée : explore, puis normalize, classify et media par
// lots jusqu'à vider la file, puis refresh de tous les pools. Une étape en échec
// n'arrête pas les suivantes ; le cycle échoue si une étape échoue entièrement.
import { explore } from '../explore/index.js';
import { listPools } from '../pools/index.js';
import { withPipelineLock } from '../lock.js';
import { processPending, refreshPools, runStep } from '../pipeline/index.js';

// Sous le verrou du pipeline, partagé avec `requests run` : le cycle attend
// qu'une exécution de recherches payées se termine.
export function cycle(options) {
  return withPipelineLock(() => runCycle(options), { wait: true });
}

async function runCycle({ budget, provider, offline = false, batch = 100, exploreOptions = {} }) {
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

  steps.push(...(await processPending({ offline, batch })));
  steps.push(await refreshPools((await listPools()).map((p) => p.slug)));

  return { ok: steps.every((s) => s.ok), steps };
}
