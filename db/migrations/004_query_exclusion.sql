-- Empreinte des domaines exclus (-site:) au dernier passage d'une requête :
-- quand elle change, les pages changent de contenu et la pagination repart de 0.
ALTER TABLE search_query ADD COLUMN exclusion_hash TEXT;
