-- 0080 · Theme presets replace the old palettes.
--
-- The Settings picker now saves one of the four dashboard looks: violet,
-- cocoa, ember or plum. profiles_theme_check (0034) only allowed the old
-- palette names, so every save failed with 23514 ("Some of the submitted
-- values are not valid.").
--
-- Order matters: drop the old check first, then move rows that hold a retired
-- palette to violet (the default look), then add the new check.

alter table public.profiles drop constraint if exists profiles_theme_check;

update public.profiles
   set theme = 'violet'
 where theme in ('midnight', 'blossom', 'daylight');

alter table public.profiles
  add constraint profiles_theme_check
  check (theme is null or theme in ('violet', 'cocoa', 'ember', 'plum'));
