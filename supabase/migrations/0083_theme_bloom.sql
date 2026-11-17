-- 0083 · Bloom (white with pink and purple) joins the Settings looks.

alter table public.profiles drop constraint if exists profiles_theme_check;

alter table public.profiles
  add constraint profiles_theme_check
  check (theme is null or theme in (
    'violet', 'cocoa', 'ember', 'plum',
    'nebula', 'grove', 'blossom', 'daylight', 'porcelain',
    'aurora', 'orchid', 'gilt', 'rose-dusk', 'sand', 'mint',
    'bloom'
  ));
