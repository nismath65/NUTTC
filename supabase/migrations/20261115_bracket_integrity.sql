-- NUTTC: bracket integrity guards
-- Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
--
-- Why: before the fix, generating a draw twice at the same moment (double click,
-- two jury devices, slow Wi-Fi) produced two complete brackets in one stage, so
-- every player appeared in two places and could "meet themselves" in the final.
-- The app now prevents this itself, but the database is the only place that can
-- guarantee it across several devices.

-- 0. Look for stages that are ALREADY affected (should return no rows).
select stage_id, bracket_type, round_number, coalesce(group_number, 0) as group_no, match_number, count(*)
from public.matches
group by 1, 2, 3, 4, 5
having count(*) > 1;

-- If the query above returns rows: open that tournament as jury and press
-- "Generate draw" again (or delete that stage's matches) BEFORE creating the index,
-- otherwise the index creation fails.

-- 1. A bracket position (stage + bracket + round + group + match #) can exist only once.
create unique index if not exists matches_unique_bracket_slot
  on public.matches (stage_id, bracket_type, round_number, coalesce(group_number, 0), match_number);

-- 2. A tournament can have only one "Stage 2" (protects the "Create Stage 2" button).
create unique index if not exists tournament_stages_unique_order
  on public.tournament_stages (tournament_id, stage_order);

-- 3. A player can never be put against themselves.
alter table public.matches
  drop constraint if exists matches_no_self_match;
alter table public.matches
  add constraint matches_no_self_match
  check (entry1_id is null or entry2_id is null or entry1_id <> entry2_id);
