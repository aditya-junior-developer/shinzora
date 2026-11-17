-- 0081 · The five restored looks join the four presets.
--
-- Nebula and Grove (dark) and Blossom, Daylight and Porcelain (light) come back
-- as Settings looks. Midnight is the original default and is the same as
-- Violet, so it stays a retired name that resolves to violet (0080).
--
-- Drop the check before widening it, so the update order can never trip it.

alter table public.profiles drop constraint if exists profiles_theme_check;

alter table public.profiles
  add constraint profiles_theme_check
  check (theme is null or theme in (
    'violet', 'cocoa', 'ember', 'plum',
    'nebula', 'grove', 'blossom', 'daylight', 'porcelain'
  ));
