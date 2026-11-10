-- 0034 — the third theme
--
-- 0031 allowed two values. The brief asks for three: the original dark
-- purple/black, a white-pink-purple light theme, and the warm light one. This
-- widens the check constraint and nothing else — the column is still nullable,
-- and an account that never chose a theme still has no opinion on file.

alter table public.profiles drop constraint if exists profiles_theme_check;
alter table public.profiles
  add constraint profiles_theme_check
  check (theme is null or theme in ('midnight', 'blossom', 'daylight'));
