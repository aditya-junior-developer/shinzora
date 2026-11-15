-- 0064 · Written by Experts costs ₹30 and is paid before the brief is sent.
--
-- The customer insert policy for service_requests refused any payment_id (0055,
-- widened 0062). An expert brief now carries the member's own payment for the
-- 'deck_expert' purpose, so that one shape is allowed and nothing else changes:
--   - the payment must belong to the caller, and be for 'deck_expert'
--   - the request must be an investor_deck_expert request
--   - the payment must still be open (not refused, refunded or cancelled)
-- The amount is still never set by the customer; the payments function sets it.

drop policy if exists service_requests_customer_insert on public.service_requests;
create policy service_requests_customer_insert on public.service_requests
  for insert to authenticated
  with check (
    owner_id = auth.uid()
    and status = 'submitted'
    and coalesce(amount, 0) = 0
    and assigned_to is null
    and admin_note is null
    and (
      deck_id is null
      or exists (
        select 1 from public.investor_decks d
         where d.id = service_requests.deck_id and d.owner_id = auth.uid()
      )
    )
    and (
      payment_id is null
      or (
        service_type = 'investor_deck_expert'
        and exists (
          select 1 from public.payments p
           where p.id = service_requests.payment_id
             and p.owner_id = auth.uid()
             and p.purpose = 'deck_expert'
             and p.status in ('pending', 'awaiting_verification', 'verified')
        )
      )
    )
  );
