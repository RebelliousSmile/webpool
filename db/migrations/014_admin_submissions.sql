-- Soumissions d'un client admin (listes de liens ou recherches) : gratuites,
-- la maison ne se facture pas. Prix nul accepté, sans écriture au grand livre.
ALTER TABLE search_request DROP CONSTRAINT search_request_unit_price_check;
ALTER TABLE search_request ADD CONSTRAINT search_request_unit_price_check CHECK (unit_price >= 0);
ALTER TABLE search_request DROP CONSTRAINT search_request_price_check;
ALTER TABLE search_request ADD CONSTRAINT search_request_price_check CHECK (price >= 0);
