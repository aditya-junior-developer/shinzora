-- ============================================================================
-- 0062 — "Written by Experts": an investor deck request goes to the team
--
-- The Investor Deck's "Write it yourself" option becomes "Written by Experts".
-- Choosing it creates a Request Services record (service_requests) of type
-- 'investor_deck_expert'. The admin desk sees it next to every other request,
-- tracks its status, and the team delivers the finished file to the member's
-- registered email.
--
-- The budget stays optional for this type: the brief asks for no budget here.
-- The request keeps a link to the deck it is about, so the member can see its
-- status from the deck, and the link clears if the deck is deleted.
-- ============================================================================

alter table public.service_requests
  add column if not exists deck_id uuid references public.investor_decks(id) on delete set null;

create index if not exists service_requests_deck_idx
  on public.service_requests (deck_id) where deck_id is not null;

comment on column public.service_requests.deck_id is
  'The investor deck an expert request is about (service type investor_deck_expert). Null for every other request.';

alter table public.service_requests drop constraint if exists service_requests_service_type_check;
alter table public.service_requests
  add constraint service_requests_service_type_check
  check (service_type in (
    'business_cards', 'meta_ads', 'video_maker', 'post_maker', 'nfc_cards',
    'custom_packaging', 'export_international', 'business_audits', 'ai_calling', 'others',
    'plan_upgrade', 'account_deletion', 'domain_registration',
    'website_setup', 'brand_kit', 'store_setup', 'investor_deck_expert'
  ));

-- A deck link is only meaningful for the deck request type.
alter table public.service_requests drop constraint if exists service_requests_deck_type;
alter table public.service_requests
  add constraint service_requests_deck_type
  check (deck_id is null or service_type = 'investor_deck_expert');

-- A member may attach a deck only if the deck is theirs. The 0056 insert rule is
-- kept as it was, with this check added. The subquery runs under the member's
-- own row-level security, so another member's deck is simply not visible to it.
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
    and (
      deck_id is null
      or exists (
        select 1 from public.investor_decks d
         where d.id = service_requests.deck_id and d.owner_id = auth.uid()
      )
    )
  );
