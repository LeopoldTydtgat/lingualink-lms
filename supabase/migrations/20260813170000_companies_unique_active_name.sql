-- Guard against duplicate live company names.
-- Partial on status = 'active' so an archived company does not hold its name.
-- Expression matches the trimmed, case-folded name written by the routes.
CREATE UNIQUE INDEX companies_unique_active_name
  ON public.companies (lower(trim(name)))
  WHERE status = 'active';
