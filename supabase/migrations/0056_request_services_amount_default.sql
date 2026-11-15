-- ============================================================================
-- 0056 — Request Services: the customer insert must accept the column default
--
-- public.service_requests.amount defaults to 0 (set when the table was first
-- created, and kept so existing payment grants still read correctly). The
-- 0055 customer insert policy tested `amount is null`, so a plain insert that
-- omits amount — which is what the Request Services form sends — was refused.
-- The test that caught it passed amount explicitly as null and missed this.
--
-- The rule is unchanged in intent: a customer may not set an amount. Zero is
-- the default and means "no amount set", so both null and 0 are accepted.
-- ============================================================================

drop policy if exists service_requests_customer_insert on public.service_requests;

create policy service_requests_customer_insert on public.service_requests
  for insert to authenticated
  with check (
    owner_id = auth.uid()
    and status = 'submitted'
    and coalesce(amount, 0) = 0
    and payment_id is null
    and assigned_to is null
    and admin_note is null
  );
