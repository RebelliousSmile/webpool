// Limitation de débit de l'API — en mémoire, sans base : une fenêtre glissante
// par clé (un jeton, ou une IP pour les routes publiques). Un processus = un
// compteur : suffisant pour l'unique instance de `webpool serve`.

export const RATE_WINDOW_MS = 60_000;

// `limit` appels par `windowMs` et par clé ; `limit` 0 désactive la limitation.
export function createRateLimiter({ limit, windowMs = RATE_WINDOW_MS, now = Date.now } = {}) {
  const hits = new Map(); // clé → horodatages des appels acceptés, du plus ancien au plus récent
  let lastSweep = now();

  function recent(key, t) {
    const list = hits.get(key);
    if (!list) return [];
    while (list.length && list[0] <= t - windowMs) list.shift();
    if (!list.length) hits.delete(key);
    return list;
  }

  // Une fois par fenêtre, oublie les clés inactives : la mémoire reste bornée
  // par le nombre de clés actives dans la dernière minute.
  function sweep(t) {
    if (t - lastSweep < windowMs) return;
    lastSweep = t;
    for (const key of [...hits.keys()]) recent(key, t);
  }

  const verdict = (list, t) =>
    list.length < limit ? { ok: true } : { ok: false, retryAfter: Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)) };

  return {
    limit,
    windowMs,
    // Compte un appel s'il est accepté. { ok } ou { ok: false, retryAfter } (secondes).
    take(key) {
      if (!limit) return { ok: true };
      const t = now();
      sweep(t);
      const list = recent(key, t);
      const result = verdict(list, t);
      if (result.ok) {
        if (!hits.has(key)) hits.set(key, list);
        list.push(t);
      }
      return result;
    },
    // Même verdict que take, sans compter l'appel.
    peek(key) {
      if (!limit) return { ok: true };
      const t = now();
      return verdict(recent(key, t), t);
    },
    size: () => hits.size,
  };
}
