-- ===========================================================================
-- 0029 · A business's public face, for the pitch panel
-- ---------------------------------------------------------------------------
-- The Businesses tab listed a name, a category and a project count. Before a
-- freelancer invests a pitch they want to see who they would be working for:
-- the logo, the website, the socials, and — most usefully — the roles that are
-- actually open and the screening questions attached to each.
--
-- One RPC, deliberately: the panel needs all of it at once, and a second round
-- trip per role would make opening a card feel slow. The list query stays as
-- cheap as it was.
--
-- What is never returned: phone, email, target audience, brand colours, goals,
-- or anything else the owner entered for their own planning. Those columns are
-- private even though the row is "public".
-- ===========================================================================

create or replace function public.marketplace_business_profile(p_business uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $fn$
declare
  actor uuid := auth.uid();
  biz public.businesses%rowtype;
  result jsonb;
begin
  if actor is null then
    raise exception 'Sign in to view a business.' using errcode = '42501';
  end if;

  select * into biz from public.businesses b where b.id = p_business;
  if biz.id is null then
    raise exception 'That business no longer exists.' using errcode = 'P0002';
  end if;
  /* Same rule as the directory: discoverable, or your own. */
  if not biz.discoverable and biz.owner_id <> actor then
    raise exception 'That business is not listed publicly.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'businessId', biz.id,
    'name', biz.name,
    'category', biz.category,
    'description', biz.description,
    'location', biz.location,
    'websiteUrl', biz.website_url,
    'logoUrl', biz.logo_url,
    'stage', biz.stage,
    /* Only well-formed links survive: a socials blob is owner-entered text. */
    'socials', coalesce((
      select jsonb_object_agg(e.key, e.value)
        from jsonb_each_text(coalesce(biz.socials, '{}'::jsonb)) e
       where btrim(e.value) ~* '^https?://'
    ), '{}'::jsonb),
    'ownerName', coalesce(nullif(p.full_name, ''), p.username),
    'ownerUsername', p.username,
    'ownerAvatarUrl', p.avatar_url,
    'isOwn', biz.owner_id = actor,
    'createdAt', biz.created_at,
    'stats', jsonb_build_object(
      'openProjects', (select count(*) from public.marketplace_jobs j where j.business_id = biz.id and j.status = 'open'),
      'totalProjects', (select count(*) from public.marketplace_jobs j where j.business_id = biz.id),
      'completedContracts', (
        select count(*) from public.marketplace_contracts c
          join public.marketplace_jobs j on j.id = c.job_id
         where j.business_id = biz.id and c.status = 'completed'
      )
    ),
    /* The roles they are hiring for, with the questions a pitch has to answer. */
    'roles', coalesce((
      select jsonb_agg(role order by role_created desc)
      from (
        select
          j.created_at as role_created,
          jsonb_build_object(
            'jobId', j.id,
            'title', j.title,
            'description', j.description,
            'requirements', j.requirements,
            'skills', j.skills,
            'budgetMin', j.budget_min,
            'budgetMax', j.budget_max,
            'currency', j.currency,
            'deliveryDays', j.delivery_days,
            'createdAt', j.created_at,
            'proposals', (select count(*) from public.marketplace_proposals p where p.job_id = j.id and p.status <> 'withdrawn'),
            'mine', j.owner_id = actor,
            'myProposal', (
              select jsonb_build_object('proposalId', p.id, 'status', p.status)
                from public.marketplace_proposals p
               where p.job_id = j.id and p.freelancer_id = actor
               limit 1
            ),
            'questions', coalesce((
              select jsonb_agg(jsonb_build_object('questionId', q.id, 'prompt', q.prompt) order by q.position)
                from public.marketplace_job_questions q where q.job_id = j.id
            ), '[]'::jsonb)
          ) as role
        from public.marketplace_jobs j
        where j.business_id = biz.id and j.status = 'open'
      ) x
    ), '[]'::jsonb)
  )
  into result
  from public.profiles p
  where p.id = biz.owner_id;

  return result;
end;
$fn$;

grant execute on function public.marketplace_business_profile(uuid) to authenticated;
revoke all on function public.marketplace_business_profile(uuid) from anon;

-- The panel opens by business id for anyone who can see the directory, so the
-- listing needs the id it already returns and nothing more. Keeping this index
-- makes the per-role counts cheap once a business has a history.
create index if not exists marketplace_jobs_business_status_idx
  on public.marketplace_jobs (business_id, status);
