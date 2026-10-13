-- Date-only deadlines inherit the notes table's existing ownership policies.
alter table public.notes add column due_date date
  check (due_date is null or due_date between date '0001-01-01' and date '9999-12-31');
