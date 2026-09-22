-- 007_table_notes.sql — internal notes on a dining table (PRD FR-011).
--
-- For staff only ("wobbly leg", "next to the kitchen door"). Customers never see
-- them: app.resolve_table_qr does not return this column, and nothing public reads
-- dining_tables directly. Additive and idempotent, like every migration here.

alter table dining_tables add column if not exists notes text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'dining_tables'::regclass and conname = 'dining_tables_notes_check'
  ) then
    alter table dining_tables add constraint dining_tables_notes_check
      check (notes = btrim(notes) and length(notes) between 1 and 500);
  end if;
end$$;
