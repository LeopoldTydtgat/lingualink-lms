-- Revoke dead write grants on invoices from authenticated and drop the two
-- unused teacher write policies. Every invoice write in the app runs through
-- service-role server code (upload route, mark-paid route, recomputeAmounts,
-- billing page ensureCurrentInvoice); the browser anon key only ever SELECTs.
-- The old grants let a teacher forge their own invoice row (amount_eur,
-- status, paid_at) from the browser console during the RLS upload window.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.invoices FROM authenticated;

DROP POLICY "Teachers can insert own invoices" ON public.invoices;

DROP POLICY "Teachers and admins can update invoices" ON public.invoices;
