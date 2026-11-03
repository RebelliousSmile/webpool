# Codebase Audit: webpool et datapool (7 piliers)

Base saine. Les droits d'accès de l'API, le grand livre (solde = somme des
écritures dans tous les scénarios), la concurrence des achats, CORS, `/media`,
le SQL paramétré et la CSP de datapool tiennent tous aux tests. Les constats de
l'audit du 2026-10-30 sont fermés, sauf le défaut de `DATABASE_URL`. Les risques
restants touchent les recherches payantes : post-traitement fragile, double achat
côté interface, normalisation concurrente hors verrou, et deux surfaces
d'injection de contenu (DNS rebinding, liens Markdown).

- **Date**: 2026_10_31
- **Scope**: webpool `ccr-936abb88-3jmekc` @ 0311572, datapool @ 1a1478e (recherches payantes), puis revus au regard des corrections a77ea0c (webpool) et 106a00a (datapool)
- **Health**: good — aucun constat critique ouvert
- **Findings**: 0 critical, 13 warning, 25 minor relevés, 4 autres fermés par les corrections de la revue du plan
- **Suivi (2026-10-31)**: tous corrigés (webpool b9a1ac3 et la fusion `secu-audit` qui suit, datapool e7f6682), sauf deux points résiduels listés en fin de rapport

Méthode : quatre audits parallèles (sécurité webpool ; code-quality et
architecture webpool ; dependencies, performance et tests webpool ; datapool sur
les 7 piliers). Les preuves sont des scripts sur schémas jetables, des sondes curl
sur un `webpool serve`, des `EXPLAIN` sur une base remplie (300 000 URLs, 550 000
écritures), des parcours Playwright, avec la CSP réelle sur le build. Les
constats « suspecté » sont marqués.

## Findings

### Fermés par les corrections de la revue (a77ea0c, 106a00a)

| Sev | Category | Location | Issue | Fix |
| --- | -------- | -------- | ----- | --- |
| ✅ | security | `src/pools/criteria.js` | Empoisonnement d'un pool partagé : avec `include_requests`, un client `read` y faisait entrer des URLs de son choix (phishing, `.exe`, titre `<img onerror>`) pour 1 giri sur son portefeuille personnel. Les seuils de qualité ne l'arrêtaient pas (quality 0,8 hors ligne). | Seules les recherches payées par une communauté propriétaire du pool comptent ; test d'intégration dédié. |
| ✅ | architecture | `db/migrations/009_billing.sql` | Une migration publiée modifiée en place (pendant les corrections). | 009 restaurée, `010_ledger_retention_public_pools.sql`. |
| ✅ | code-quality | `src/billing/index.js` (`setMember`) | `community join` écrasait le plafond quand on changeait le rôle, et rétrogradait un propriétaire sans `--role` ; `--monthly 0` était refusé. | Upsert partiel (un champ absent garde sa valeur), `--monthly 0` et `none` acceptés ; même règle pour `PUT /communities/{slug}/members/{name}`. |
| ✅ | code-quality | `db/migrations/009_billing.sql` | Supprimer un client ou une communauté effaçait le grand livre en cascade. | `ON DELETE RESTRICT` (migration 010). |

### Relevés — tous corrigés depuis (voir *Suivi*)

| Sev | Category | Location | Issue | Suggested fix | Effort |
| --- | -------- | -------- | ----- | ------------- | ------ |
| 🟡 | code-quality | `src/requests/index.js` (`runRequests`, après `execute`) | Si `normalize` ou `classify` lève, les recherches sont déjà `done` et payées, mais aucun pool n'est rafraîchi et `in_pool` reste NULL. Le run suivant ne reprend rien s'il n'y a pas de nouvelle recherche : les résultats payés attendent le `cycle` du lundi. Vérifié (taxonomie invalide). | Marque `processed_at` ; reprendre au début de chaque run les recherches `done` non traitées ; étapes isolées comme `runStep`, refresh et `in_pool` toujours exécutés. | M |
| 🟡 | security | datapool `src/routes/recherches/+page.svelte` (`buy`) | Achat sans garde `sending` ni clé d'idempotence : 3 clics dans la même tâche produisent 3 POST, donc 3 débits (vérifié). Un vrai double clic n'envoie qu'un POST. | `if (sending) return;` ; en-tête `Idempotency-Key` côté API. | S (M avec l'API) |
| 🟡 | ui | datapool `recherches/+page.svelte` | Si le rechargement de `/billing` échoue après un achat réussi, la page entière est remplacée par l'erreur et la confirmation disparaît : l'utilisateur peut racheter. `loadError` n'est jamais remis à zéro (vérifié). | Erreur pleine page au premier chargement seulement, sinon alerte en ligne ; remettre `loadError` à `''`. | S |
| 🟡 | ui | datapool `recherches/+page.svelte` (`cancel`) | Annulation sans état en cours : un double clic envoie 2 DELETE, et la page affiche à la fois « annulée » et l'erreur « déjà cancelled » (statut en anglais). | État `cancelling` par ligne, bouton désactivé. | S |
| 🟡 | ui | datapool `recherches/+page.svelte` | Après un 402 ou un 429, les soldes affichés ne sont pas rechargés : la tuile reste périmée (vérifié). | `reload += 1` dans le `catch` sur 402 et 429. | S |
| 🟡 | security | `src/normalize/fetcher.js:130`, `hostGuard.js:59` | DNS rebinding : la garde SSRF résout le nom, puis `fetch` le résout à nouveau. Le risque était accepté, mais il est maintenant pilotable par une recherche payante (`site:attaquant`), et le titre ou l'image d'une ressource interne finit dans un pool lisible. Suspecté (pas de serveur DNS pour l'exploiter). | `undici.Agent` avec `connect.lookup` qui applique `isBlockedAddress` et fixe l'IP. | M |
| 🟡 | security | `src/pools/export.js:65` | Injection de lien Markdown : l'antislash n'est pas échappé, donc un titre `Doc\](https://evil…)` produit un lien vers evil. Même faille pour `\|`. Vérifié sur la sortie. | Échapper `\` d'abord, puis `[ ] ( ) | * _ \` ! <`. | S |
| 🟡 | architecture | `src/normalize/index.js:92,140`, `src/classify/index.js:143` | `normalizePending` et `classifyPending` ne réservent pas leurs lignes. Deux exécutions traitent les mêmes URLs (vérifié : 40 traitements pour 20 URLs), et un normalize lent peut faire repasser une URL `classified` en `normalized`. Le verrou partagé couvre maintenant `cycle` et `requests run`, mais pas les commandes manuelles `normalize` et `classify`. | `UPDATE … WHERE status = 'pending'` (ou `FOR UPDATE SKIP LOCKED`) ; verrou du pipeline dans les commandes manuelles. | M |
| 🟡 | code-quality | `src/requests/index.js` (`in_pool`) | `in_pool` n'est calculé que par `requests run`, jamais par `refreshPool` ni par `cycle` : la valeur se fige (vérifié). | Calcul à la lecture (sous-requête) ou dans `refreshPool`. | S |
| 🟡 | code-quality | `src/pools/criteria.js` (`include_requests` et `limit`) | Les URLs payées concourent pour `limit` : selon l'ordre, une recherche payée peut n'apporter aucune URL au pool (vérifié : `limit: 1`, `in_pool = 0`). | Ajouter ces URLs au-delà de `limit` (UNION, rang après), ou le documenter. | S |
| 🟡 | performance | `src/billing/index.js` (`spentLast30Days`, `walletsFor`) | Pas d'index adapté, et une requête par communauté (N+1) à chaque `GET /billing`. La même requête tourne sous `FOR UPDATE` du portefeuille dans `createRequest`. Mesuré : 17 ms par appel, 437 ms pour 50 communautés ; 0,04 ms avec l'index. | Index `wallet_entry (wallet_id, api_client_id, created_at) WHERE kind IN ('debit','refund')` ; une seule requête agrégée. | S |
| 🟡 | tests | `test/integration/billing.test.js` | Les tests s'enchaînent : lancé seul, chacun échoue (identifiants en dur, état hérité). | Données propres à chaque test (`beforeEach`), sans identifiant en dur. | M |
| 🟡 | tests | `test/cli.test.js`, `src/requests/index.js` | Rien ne teste les nouvelles commandes CLI (`community`, `wallet`, `pricing`, `requests`, `billing`) ni leur code de sortie. La concurrence (deux `credit` de même référence, deux `requests run`) et plusieurs branches de `requests` ne sont pas couvertes non plus. | Tests `execFile` ; `Promise.all` sur les cas concurrents. | M |
| 🟢 | security | `README.md` (GRANT), `src/requests/index.js` (`createRequest`) | Le rôle PostgreSQL minimal documenté casse `POST /requests` : `SELECT … FROM api_client FOR UPDATE` exige `UPDATE` sur `api_client` (vérifié), ce qui pousse à donner le droit de réécrire `token_hash`. | `pg_advisory_xact_lock(clientId)` à la place ; tester ce rôle en intégration. | S |
| 🟢 | security | `src/normalize/hostGuard.js:15-23` | Liste de blocage incomplète : NAT64 `64:ff9b::/96`, 6to4, `::/96` IPv4-compatible, multicast, `240/4`, `198.18/15`, `fec0::/10` (vérifié sur `isBlockedAddress`). | N'accepter que l'unicast global ; décoder NAT64 et 6to4. | S |
| 🟢 | security | `src/requests/index.js` (`execute`) | Les erreurs brutes des providers remontent aux clients dans `GET /requests` (par exemple « BRAVE_API_KEY manquante… », vérifié). | Code générique côté client, détail réservé à l'admin. | S |
| 🟢 | security | `src/api/server.js` | Un octet NUL dans un paramètre ou un corps donne une 500 avec la pile complète dans le journal, déclenchable par un client `read` (vérifié). | 400 sur `\u0000`, ou code PostgreSQL 22021 traité en `bad_request`. | S |
| 🟢 | security | `src/api/server.js` | Ni `requestTimeout`/`headersTimeout` propres, ni plafond de connexions, ni limitation par jeton. Suspecté. | Les fixer, et limiter le débit par jeton. | S |
| 🟢 | security | `scripts/deploy.mjs:153,223` | `DATABASE_URL`, mot de passe compris, passe sur la ligne de commande de `psql` et `pg_dump` (hôte mutualisé). | `PGPASSWORD` par l'environnement, ou `.pgpass` en 600. | S |
| 🟢 | security | `src/config.js:20` | Toujours ouvert depuis l'audit précédent : le défaut `webpool:webpool` s'applique hors développement. Atténué par le déploiement, qui exige la variable. | Défaut réservé au développement. | S |
| 🟢 | security | `src/billing/index.js` (`ownerSetMember`) | Un propriétaire peut inscrire n'importe quel client par son nom, sans son accord, et énumérer les noms (« inconnu » vs succès). Le plafond par défaut est nul (illimité). | Invitation à accepter, ou rattachement par l'admin ; plafond par défaut configurable. | M |
| 🟢 | code-quality | `src/billing/index.js` (`credit`) | Deux crédits concurrents de même référence donnent une erreur PostgreSQL 23505 brute au lieu d'une `BillingError`. L'invariant tient (contrainte UNIQUE). Vérifié. | Intercepter 23505. | S |
| 🟢 | code-quality | `src/api/handlers.js` (`deleteRequest`) | L'admin ne peut annuler par l'API que ses propres recherches (le CLI peut tout annuler). | Passer `isAdmin`. | S |
| 🟢 | code-quality | `src/requests/index.js` (`recoverStale`, `claim`) | Sous verrou, un `running` trouvé au démarrage est forcément orphelin, et pourtant on attend 60 min. Si `loadSaturated` échoue après `claim`, les recherches restent bloquées une heure. | `staleMinutes = 0` sous verrou, ou remettre en `queued` sur erreur avant `execute`. | S |
| 🟢 | code-quality | `src/requests/index.js` (`execute`) | Un échec en base après un appel provider facturé rembourse l'appel et omet son coût dans `cost_usd`. Suspecté. | Distinguer l'échec provider de l'échec d'écriture. | S |
| 🟢 | code-quality | `src/billing/index.js` (`walletsFor`) | `GET /billing` écrit (création de portefeuille, séquence consommée à chaque appel). | Lecture seule, solde 0 par défaut. | S |
| 🟢 | architecture | `src/requests/index.js` | `requests` recopie les étapes du cycle (7 imports, médias en `.catch(() => {})` muet) : deux pipelines qui divergent. Les règles de visibilité d'un pool existent en double (handlers et requests). | Module `src/pipeline/` partagé ; fragment SQL de visibilité unique. | M |
| 🟢 | performance | `src/pools/criteria.js` (`include_requests`) | `OR EXISTS` empêche la semi-jointure ; `search_request.pool_id` n'a pas d'index. Mesuré : 362 ms contre 122 ms en `id IN (… UNION …)`. | Réécriture en `IN (… UNION …)`, et index sur `pool_id`. | S |
| 🟢 | performance | `src/api/handlers.js` (`listPools`) | Agrège tous les `pool_item` quel que soit le nombre de pools visibles (56 ms pour 200 000 lignes). | Compter après filtrage, ou garder un `item_count`. | S |
| 🟢 | performance | `src/requests/index.js` (`runRequests`) | Vide tout l'arriéré de normalize, classify et media sous verrou, sans borne. Suspecté. | Limiter aux URLs des recherches réservées. | M |
| 🟢 | performance | `db/migrations/009_billing.sql` | `wallet_entry.search_request_id`, `api_client_id` et le filtre de `billingReport` n'ont pas d'index (30 ms en scan sur 550 000 lignes). | Index ciblés. | S |
| 🟢 | dependencies | `package.json` (deux dépôts) | Advisories en développement uniquement : `minimatch` < 11.0.1 (ReDoS, via eslint), `deepmerge` (via vite-plugin-svelte, sans correctif). Montées majeures disponibles : vitest 5, vite 8, TypeScript 7. Production : 0 vulnérabilité. | `pnpm.overrides` pour minimatch ; montées groupées dans une PR. | S/M |
| 🟢 | dependencies | `src/media/thumbnail.js:9` | `sharp` et libvips sont à jour, mais les décodeurs heif et tiff restent acceptés pour des images non fiables. CVE libvips non vérifiées (OSV refusé par le proxy). La notice LGPL de libvips est à joindre. | Limiter aux formats jpeg, png, webp, gif et avif ; surveiller les versions (Renovate). | S |
| 🟢 | tests | datapool `vitest.config.js` | `src/routes` est hors tests et hors couverture : la logique d'achat n'est pas testée (99,5 % mesurés sur `src/lib` seulement). | Extraire la logique de la page, ou smoke test Playwright. | M |
| 🟢 | architecture | datapool `src/lib/session.svelte.ts`, `api/client.ts` | Un 401 en cours de session (jeton révoqué) ne déconnecte pas : chaque page affiche son erreur (vérifié). Aucun délai d'expiration sur `fetch`. | Callback `onUnauthorized`, `AbortSignal.timeout`. | S |
| 🟢 | ui | datapool `recherches/+page.svelte`, `ui.css` | À 390 px, « Annuler » est hors écran dans le tableau défilant. La navigation admin est coupée sans indice. `?pool=inconnu` envoie un slug invisible. | Action dans la cellule Requête sur mobile ; fondu de bord ; remettre `form.pool` à vide s'il est hors liste. | S |
| 🟢 | performance | datapool `recherches/+page.svelte` | Chaque action recharge `/pools` inutilement et démonte l'historique. Aucune garde contre les réponses dans le désordre. | Charger `/pools` une fois ; garder la valeur précédente. | S |
| 🟢 | security | datapool `scripts/deploy-lib.mjs` | Ni HSTS ni `Permissions-Policy`. `style-src 'unsafe-inline'` est requis par des `style=""`. | Ajouter les en-têtes ; passer les styles en classes. | S |

## Top actions

1. **Rendre l'achat sûr côté interface** (S) : garde `sending`, état d'annulation,
   rechargement des soldes sur 402 et 429, erreur en ligne après un achat réussi.
   Puis `Idempotency-Key` dans l'API (M). C'est de l'argent : à faire avant
   d'ouvrir les recherches.
2. **Fiabiliser `requests run`** (M) : reprise du post-traitement (`processed_at`),
   `in_pool` calculé à la lecture, réservation des lignes dans
   `normalizePending` et `classifyPending`, verrou dans les commandes manuelles.
3. **Fermer les injections de contenu** : échappement Markdown (S), garde SSRF à
   la connexion contre le DNS rebinding (M), liste de blocage en unicast global
   (S).
4. **Rendre le rôle PostgreSQL minimal utilisable** (S) : verrou consultatif à la
   place de `FOR UPDATE` sur `api_client`, et test d'intégration avec ce rôle.
5. **Index et requête unique pour `GET /billing`** (S), puis tests isolés et tests
   CLI des recherches payantes (M).

## Coverage

- **Scanned**: les 7 piliers sur les deux dépôts.
  - Suites : webpool 350/350 après les corrections (unitaires et intégration ; couverture 97,2 % d'instructions, 92 % de branches) ; datapool 108/108 (99,6 % sur `src/lib`).
  - `pnpm audit` et `outdated` dans les deux dépôts, licences de production.
  - `EXPLAIN` sur une base remplie, concurrence (20 achats et 5 annulations simultanés : correct).
  - CSP réelle sur le build : 0 violation.
  - Accessibilité : libellés, focus, contrastes en sombre et en clair, mobile à 390 px.
- **Skipped**:
  - exploitation réelle du DNS rebinding et accessibilité IPv6 (ni DNS ni IPv6 dans le bac à sable) ;
  - CVE libvips (OSV refusé par le proxy) ;
  - providers réels (pas de clés) ;
  - `/proc` chez alwaysdata.

## Suivi des corrections (2026-10-31)

Tous les constats ouverts ci-dessus sont corrigés, avec leurs tests :

- **webpool, recherches et architecture** (b9a1ac3) : reprise du post-traitement (`processed_at`), `src/pipeline/` partagé, réservation des lignes de `normalize` et `classify` et verrou dans les commandes manuelles, `in_pool` à la lecture, `include_requests` en deux parties (au-delà de `limit`, semi-jointure), index du grand livre, `GET /billing` en lecture seule et en une requête, idempotence (`Idempotency-Key`), verrous consultatifs (rôle PostgreSQL minimal testé), erreurs génériques pour les clients, annulation par l'admin, 23505 en erreur métier, recherches orphelines closes aussitôt, coût d'un appel non enregistré compté, invitations et plafond par défaut, tests isolés, concurrents et CLI, vitest 5, vite 8, override `minimatch`.
- **webpool, sécurité** (fusion `secu-audit`) : garde SSRF à la connexion (undici), unicast global seul, échappement Markdown, octet NUL en 400, délais, plafond de connexions et limitation de débit (hors `/media`), `PGPASSWORD` au déploiement, `DATABASE_URL` obligatoire hors développement, décodeurs d'images restreints et notice LGPL.
- **datapool** (e7f6682) : achat gardé et idempotent, erreur de rechargement en ligne, annulation sans double envoi, soldes relus sur 402/429, déconnexion sur 401 et délai de 15 s, mobile (Annuler visible, ombre de navigation, `?pool=` inconnu), `/pools` chargé une fois et historique gardé pendant le rechargement, logique d'achat extraite et testée (`purchase.svelte.ts`), HSTS et `Permissions-Policy`, `style-src 'self'` avec `style-src-attr 'unsafe-inline'`, composant `<Async>`, mouvements du portefeuille, filtre de statut, vue admin, invitations.

Résiduels assumés :

- `deepmerge` 4.3.1 (datapool, via `@sveltejs/vite-plugin-svelte`, développement seulement) : aucune version corrigée publiée.
- `style-src-attr 'unsafe-inline'` (datapool) : requis par l'annonceur de navigation de SvelteKit, seul attribut `style` restant ; les `<style>` en ligne sont interdits.
- Un propriétaire peut savoir si un nom de client existe (404 sur un nom inconnu) : les noms ne sont pas des secrets, et l'inscription exige désormais le consentement du client.
- À vérifier en production : qu'alwaysdata pose `X-Forwarded-For`, puis activer `WEBPOOL_API_TRUST_PROXY`, sans quoi les requêtes sans jeton partagent un compteur (les vignettes `/media` en sont exemptes). Exploitation réelle du DNS rebinding et accès IPv6 non testables dans le bac à sable ; Node 24 non testé localement (la CI le couvre).
