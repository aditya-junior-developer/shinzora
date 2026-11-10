-- 0031 · The theme preference lives on the profile.
--
-- Stored per account rather than per device so somebody who signed in on their
-- phone in a bright room and on a laptop at night keeps one choice. The browser
-- also keeps a copy, which is what the pre-paint script reads — this column is
-- only what seeds a new device.

alter table public.profiles add column if not exists theme text;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.profiles'::regclass
       and conname = 'profiles_theme_check'
  ) then
    alter table public.profiles
      add constraint profiles_theme_check
      check (theme is null or theme in ('midnight', 'daylight'));
  end if;
end $$;
