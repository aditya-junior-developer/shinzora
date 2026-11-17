-- 0082 · Six new looks join the Settings choices.
--
-- Aurora, Orchid and Gilt (dark) and Rose Dusk (dark), Sand and Mint (light).
-- Drop the check before widening it, so the update order can never trip it.

alter table public.profiles drop constraint if exists profiles_theme_check;

alter table public.profiles
  add constraint profiles_theme_check
  check (theme is null or theme in (
    'violet', 'cocoa', 'ember', 'plum',
    'nebula', 'grove', 'blossom', 'daylight', 'porcelain',
    'aurora', 'orchid', 'gilt', 'rose-dusk', 'sand', 'mint'
  ));
