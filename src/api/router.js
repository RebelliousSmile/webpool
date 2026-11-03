// Routage de l'API — fonctions pures. Un motif `/pools/:slug` capture un segment.

export function compileRoute({ method, path, ...rest }) {
  const names = [];
  const source = path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { method, path, names, regex: new RegExp(`^${source}$`), ...rest };
}

// { route, params } si la route existe ; { allowed } si le chemin existe pour
// d'autres méthodes (toujours pour OPTIONS : les méthodes du prévol) ; null
// sinon. Un segment mal encodé lève URIError.
export function matchRoute(routes, method, pathname) {
  const allowed = [];
  for (const route of routes) {
    const m = route.regex.exec(pathname);
    if (!m) continue;
    if (route.method !== method) {
      allowed.push(route.method);
      continue;
    }
    const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(m[i + 1])]));
    return { route, params };
  }
  return allowed.length ? { allowed } : null;
}
