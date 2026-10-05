-- A chosen accent color per workspace, shown in the top-bar indicator.
-- Null falls back to an automatic color by position.
alter table public.workspaces
  add column color text
    check (color in ('black', 'purple', 'blue', 'green', 'amber', 'pink', 'slate'));
