import { supabase } from './supabase';
import {
  TournamentEntry,
  Match,
  StageFormat,
  MatchType,
  TournamentStatus,
} from '@/types/database';
import {
  MatchRow,
  buildSingleElimination,
  buildDoubleElimination,
  buildRoundRobin,
  buildSwissRound,
} from './bracketBuilder';

export { findStageIntegrityIssues } from './bracketBuilder';

export type SeedingMode = 'elo' | 'manual' | 'random';

export interface StandingRow {
  entry: TournamentEntry;
  groupNumber: number;
  played: number;
  wins: number;
  losses: number;
  setsWon: number;
  setsLost: number;
  setDiff: number;
  points: number;
  rankInGroup: number;
}

export function computeStageStandings(
  stageMatches: Match[],
  entries: TournamentEntry[],
  isSwiss: boolean
): StandingRow[] {
  const entryMap = new Map<string, TournamentEntry>();
  entries.forEach((e) => entryMap.set(e.id, e));

  const statsMap = new Map<string, StandingRow>();

  stageMatches.forEach((m) => {
    const gNum = isSwiss ? 1 : m.group_number || 1;
    [m.entry1_id, m.entry2_id].forEach((eid) => {
      if (eid && entryMap.has(eid) && !statsMap.has(eid)) {
        statsMap.set(eid, {
          entry: entryMap.get(eid)!,
          groupNumber: gNum,
          played: 0,
          wins: 0,
          losses: 0,
          setsWon: 0,
          setsLost: 0,
          setDiff: 0,
          points: 0,
          rankInGroup: 1,
        });
      }
    });
  });

  stageMatches.forEach((m) => {
    if (m.status !== 'completed' && m.status !== 'walkover') return;

    if (m.status === 'walkover' && m.winner_entry_id && statsMap.has(m.winner_entry_id)) {
      const row = statsMap.get(m.winner_entry_id)!;
      row.played += 1;
      row.wins += 1;
      row.setsWon += m.entry1_score || 1;
      row.setDiff = row.setsWon - row.setsLost;
      row.points += 2;
      return;
    }

    if (m.entry1_id && m.entry2_id) {
      const r1 = statsMap.get(m.entry1_id);
      const r2 = statsMap.get(m.entry2_id);
      if (r1) {
        r1.played += 1;
        r1.setsWon += m.entry1_score;
        r1.setsLost += m.entry2_score;
        r1.setDiff = r1.setsWon - r1.setsLost;
        if (m.winner_entry_id === m.entry1_id) {
          r1.wins += 1;
          r1.points += 2;
        } else {
          r1.losses += 1;
          r1.points += 1;
        }
      }
      if (r2) {
        r2.played += 1;
        r2.setsWon += m.entry2_score;
        r2.setsLost += m.entry1_score;
        r2.setDiff = r2.setsWon - r2.setsLost;
        if (m.winner_entry_id === m.entry2_id) {
          r2.wins += 1;
          r2.points += 2;
        } else {
          r2.losses += 1;
          r2.points += 1;
        }
      }
    }
  });

  const allRows = Array.from(statsMap.values());
  const groups = Array.from(new Set(allRows.map((r) => r.groupNumber))).sort((a, b) => a - b);

  const result: StandingRow[] = [];
  for (const g of groups) {
    const gRows = allRows
      .filter((r) => r.groupNumber === g)
      .sort(
        (a, b) =>
          b.wins - a.wins ||
          b.setDiff - a.setDiff ||
          b.setsWon - a.setsWon ||
          b.entry.seed_elo - a.entry.seed_elo
      );
    gRows.forEach((row, idx) => {
      row.rankInGroup = idx + 1;
      result.push(row);
    });
  }

  return result;
}

/**
 * Generates or resets a stage draw using Elo, Manual Seed Order, Random Shuffle, or Stage 1 Performance Order.
 *
 * The whole draw is built in memory first and written with ONE bulk insert
 * (see bracketBuilder.ts). After writing, the stage is re-read: if rows from a
 * concurrent generation are found, this run removes its own rows and reports it,
 * so the stage never ends up with two interleaved brackets.
 */
export async function generateStageDraw(
  tournamentId: string,
  stageId: string,
  format: StageFormat,
  entriesToUse: TournamentEntry[],
  groupCount: number = 2,
  preserveOrder: boolean = false,
  seedingMode: SeedingMode = 'elo',
  options?: { preliminary?: boolean }
) {
  if (entriesToUse.length < 2) {
    throw new Error('Минимум 2 участника / Need at least 2 entries');
  }

  const sorted = [...entriesToUse];

  if (!preserveOrder) {
    if (seedingMode === 'manual') {
      sorted.sort(
        (a, b) => (a.seed_number ?? 9999) - (b.seed_number ?? 9999) || b.seed_elo - a.seed_elo
      );
    } else if (seedingMode === 'random') {
      // Fisher-Yates unbiased shuffle
      for (let i = sorted.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
      }
    } else {
      sorted.sort((a, b) => b.seed_elo - a.seed_elo);
    }
  }

  // 1. Build everything in memory (pure, no DB writes yet)
  let rows: MatchRow[];
  if (format === 'single_elimination') {
    rows = buildSingleElimination(tournamentId, stageId, sorted, true);
  } else if (format === 'double_elimination') {
    rows = buildDoubleElimination(tournamentId, stageId, sorted);
  } else if (format === 'round_robin') {
    rows = buildRoundRobin(tournamentId, stageId, sorted, groupCount);
  } else {
    rows = buildSwissRound(tournamentId, stageId, sorted, []);
  }

  // 2. Replace the stage's matches
  const { error: delError } = await supabase.from('matches').delete().eq('stage_id', stageId);
  if (delError) throw new Error(delError.message);

  const { error: insError } = await supabase.from('matches').insert(rows);
  if (insError) {
    if (isUniqueViolation(insError)) throw new Error(CONCURRENT_DRAW_MSG);
    throw new Error(insError.message);
  }

  // 3. Verify nobody else generated at the same time (defence when the DB unique index is missing)
  const { data: after } = await supabase.from('matches').select('id').eq('stage_id', stageId);
  const mine = new Set(rows.map((r) => r.id));
  const foreign = ((after as { id: string }[]) || []).filter((r) => !mine.has(r.id));
  if (foreign.length > 0) {
    await supabase.from('matches').delete().in('id', Array.from(mine));
    throw new Error(CONCURRENT_DRAW_MSG);
  }

  await Promise.all(
    sorted.map((e, i) =>
      supabase.from('tournament_entries').update({ seed_number: i + 1 }).eq('id', e.id)
    )
  );

  if (options?.preliminary) {
    await supabase.from('tournament_stages').update({ status: 'pending' }).eq('id', stageId);
  } else {
    await supabase.from('tournament_stages').update({ status: 'in_progress' }).eq('id', stageId);
    await supabase.from('tournaments').update({ status: 'in_progress' }).eq('id', tournamentId);
  }
}

const CONCURRENT_DRAW_MSG =
  'Сетка уже формируется с другого устройства/клика — обновите страницу / Draw was generated concurrently — refresh the page';

function isUniqueViolation(err: { code?: string; message?: string }) {
  return err.code === '23505' || /duplicate key/i.test(err.message || '');
}

export async function generateNextSwissRound(
  tournamentId: string,
  stageId: string,
  checkedInEntries: TournamentEntry[],
  // kept for backwards compatibility – the DB is the source of truth now
  _existingMatches: Match[] = []
) {
  void _existingMatches;
  const { data, error } = await supabase.from('matches').select('*').eq('stage_id', stageId);
  if (error) throw new Error(error.message);
  const stageMatches = (data as Match[]) || [];

  const unfinished = stageMatches.filter(
    (m) => m.status === 'scheduled' || m.status === 'in_progress'
  );
  if (unfinished.length > 0) {
    throw new Error(
      `Сначала завершите текущий тур (${unfinished.length} матч.) / Finish the current round first`
    );
  }

  const rows = buildSwissRound(tournamentId, stageId, checkedInEntries, stageMatches);
  if (rows.length === 0) return;
  const { error: insError } = await supabase.from('matches').insert(rows);
  if (insError) {
    if (isUniqueViolation(insError)) throw new Error(CONCURRENT_DRAW_MSG);
    throw new Error(insError.message);
  }
}

// ---------------------------------------------------------------------------
// Bracket progression helpers
// ---------------------------------------------------------------------------

async function fetchMatch(id: string): Promise<Match | null> {
  const { data } = await supabase.from('matches').select('*').eq('id', id).maybeSingle();
  return (data as Match) || null;
}

/** LB pass-through: a 'walkover' match that can only ever get one player. */
function isPassThrough(m: Match) {
  return m.status === 'walkover' && m.bracket_type === 'losers';
}

/** Puts an entry into a slot and auto-advances it through pass-through (BYE) matches. */
async function advanceInto(targetId: string, slot: 1 | 2, entryId: string) {
  const col = slot === 1 ? { entry1_id: entryId } : { entry2_id: entryId };
  await supabase.from('matches').update(col).eq('id', targetId);

  const target = await fetchMatch(targetId);
  if (target && isPassThrough(target)) {
    await supabase
      .from('matches')
      .update({
        winner_entry_id: entryId,
        entry1_score: slot === 1 ? 1 : 0,
        entry2_score: slot === 2 ? 1 : 0,
      })
      .eq('id', targetId);
    if (target.next_match_id && target.next_match_slot) {
      await advanceInto(target.next_match_id, target.next_match_slot, entryId);
    }
  }
}

/** Reverse of advanceInto. */
async function retractFrom(targetId: string, slot: 1 | 2) {
  const target = await fetchMatch(targetId);
  if (!target) return;
  const col = slot === 1 ? { entry1_id: null } : { entry2_id: null };
  await supabase.from('matches').update(col).eq('id', targetId);

  if (isPassThrough(target) && target.winner_entry_id) {
    await supabase
      .from('matches')
      .update({ winner_entry_id: null, entry1_score: 0, entry2_score: 0 })
      .eq('id', targetId);
    if (target.next_match_id && target.next_match_slot) {
      await retractFrom(target.next_match_id, target.next_match_slot);
    }
  }
}

/** First real (non pass-through) match a player would be sent to. */
async function firstRealDownstream(targetId: string | null): Promise<Match | null> {
  let id = targetId;
  for (let guard = 0; id && guard < 64; guard++) {
    const m = await fetchMatch(id);
    if (!m) return null;
    if (!isPassThrough(m)) return m;
    id = m.next_match_id;
  }
  return null;
}

async function assertDownstreamNotStarted(match: Match) {
  for (const target of [match.next_match_id, match.loser_next_match_id]) {
    const d = await firstRealDownstream(target);
    if (d && (d.status === 'completed' || d.status === 'in_progress')) {
      throw new Error(
        `Сначала отмените следующий матч (#${d.match_number}, раунд ${d.round_number}) / Undo the following match first`
      );
    }
  }
}

export async function submitMatchResult(
  match: Match,
  score1: number,
  score2: number,
  bestOf: number,
  isRated: boolean
) {
  const setsToWin = Math.ceil(bestOf / 2);
  const maxScore = Math.max(score1, score2);
  const minScore = Math.min(score1, score2);

  if (score1 === score2 || maxScore !== setsToWin || minScore < 0 || minScore >= setsToWin) {
    throw new Error(
      `Недопустимый счёт для Bo${bestOf}. Победитель должен набрать ${setsToWin} сета.`
    );
  }

  // Always work on the database state, never on a possibly stale UI copy
  let fresh = await fetchMatch(match.id);
  if (!fresh) throw new Error('Матч не найден / Match not found');
  if (!fresh.entry1_id || !fresh.entry2_id) {
    throw new Error('Оба участника должны быть известны / Both match slots must be filled');
  }
  if (fresh.entry1_id === fresh.entry2_id) {
    throw new Error('Игрок не может играть сам с собой / An entry cannot play itself');
  }

  const winnerId = score1 > score2 ? fresh.entry1_id : fresh.entry2_id;
  const loserId = score1 > score2 ? fresh.entry2_id : fresh.entry1_id;

  if (fresh.status === 'completed') {
    if (fresh.winner_entry_id === winnerId) {
      // Same winner, just a score correction: nothing moves in the bracket, Elo unchanged.
      await supabase
        .from('matches')
        .update({ entry1_score: score1, entry2_score: score2 })
        .eq('id', fresh.id);
      return;
    }
    // Winner changed -> full undo (bracket + Elo) and record again.
    await undoMatchResult(fresh);
    fresh = await fetchMatch(match.id);
    if (!fresh) throw new Error('Матч не найден / Match not found');
  }

  // Atomically claim the match: only one click / device can complete it
  const { data: claimed, error } = await supabase
    .from('matches')
    .update({
      entry1_score: score1,
      entry2_score: score2,
      winner_entry_id: winnerId,
      table_number: null,
      status: 'completed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', fresh.id)
    .in('status', ['scheduled', 'in_progress'])
    .select();

  if (error) throw new Error(error.message);
  if (!claimed || (claimed as unknown[]).length === 0) {
    throw new Error('Результат уже внесён (другой клик/устройство) / Result was already recorded');
  }

  if (fresh.next_match_id && fresh.next_match_slot) {
    await advanceInto(fresh.next_match_id, fresh.next_match_slot, winnerId);
  }
  if (fresh.loser_next_match_id && fresh.loser_next_match_slot) {
    await advanceInto(fresh.loser_next_match_id, fresh.loser_next_match_slot, loserId);
  }

  if (isRated) {
    const { data: entryRows } = await supabase
      .from('tournament_entries')
      .select('*')
      .in('id', [fresh.entry1_id, fresh.entry2_id]);
    const list = (entryRows as TournamentEntry[]) || [];
    const e1 = list.find((e) => e.id === fresh!.entry1_id);
    const e2 = list.find((e) => e.id === fresh!.entry2_id);
    if (!e1 || !e2) return;

    const K = 32;
    const rA = e1.seed_elo;
    const rB = e2.seed_elo;
    const expectedA = 1 / (1 + Math.pow(10, (rB - rA) / 400));
    const actualA = score1 > score2 ? 1 : 0;
    const deltaA = Math.round(K * (actualA - expectedA));
    const deltaB = -deltaA;

    const updateEntryPlayers = async (entry: TournamentEntry, delta: number, won: boolean) => {
      const playerIds = [entry.player1_id, entry.player2_id].filter(Boolean) as string[];
      for (const pid of playerIds) {
        const { data: p } = await supabase.from('players').select('*').eq('id', pid).single();
        if (p) {
          const newElo = Math.max(100, p.elo_rating + delta);
          await supabase
            .from('players')
            .update({
              elo_rating: newElo,
              wins: won ? p.wins + 1 : p.wins,
              losses: won ? p.losses : p.losses + 1,
            })
            .eq('id', pid);

          await supabase.from('rating_logs').insert({
            player_id: pid,
            match_id: fresh!.id,
            elo_before: p.elo_rating,
            elo_after: newElo,
            reason: won ? `Match win (+${delta})` : `Match loss (${delta})`,
          });
        }
      }
    };

    await updateEntryPlayers(e1, deltaA, score1 > score2);
    await updateEntryPlayers(e2, deltaB, score2 > score1);
  }
}

/**
 * UNDO / RESET COMPLETED MATCH:
 * Reverts Elo changes from rating_logs, clears advanced slots in next matches, and resets match to 'scheduled'.
 * Refuses if the match the winner/loser went to has already started or finished.
 */
export async function undoMatchResult(match: Match) {
  const fresh = await fetchMatch(match.id);
  if (!fresh || fresh.status !== 'completed') return;

  await assertDownstreamNotStarted(fresh);

  // 1. Atomically claim the undo so a double click can't revert Elo twice
  const { data: claimed } = await supabase
    .from('matches')
    .update({
      entry1_score: 0,
      entry2_score: 0,
      winner_entry_id: null,
      status: 'scheduled',
    })
    .eq('id', fresh.id)
    .eq('status', 'completed')
    .select();
  if (!claimed || (claimed as unknown[]).length === 0) return;

  // 2. Revert Elo and W/L using rating_logs for this match
  const { data: logs } = await supabase
    .from('rating_logs')
    .select('*')
    .eq('match_id', fresh.id);

  if (logs && logs.length > 0) {
    for (const log of logs) {
      const delta = log.elo_after - log.elo_before;
      const won = log.reason.includes('win');
      const { data: p } = await supabase
        .from('players')
        .select('*')
        .eq('id', log.player_id)
        .single();
      if (p) {
        await supabase
          .from('players')
          .update({
            elo_rating: Math.max(100, p.elo_rating - delta),
            wins: won ? Math.max(0, p.wins - 1) : p.wins,
            losses: !won ? Math.max(0, p.losses - 1) : p.losses,
          })
          .eq('id', p.id);
      }
    }
    await supabase.from('rating_logs').delete().eq('match_id', fresh.id);
  }

  // 3. Pull winner / loser back out of the following matches
  if (fresh.next_match_id && fresh.next_match_slot) {
    await retractFrom(fresh.next_match_id, fresh.next_match_slot);
  }
  if (fresh.loser_next_match_id && fresh.loser_next_match_slot) {
    await retractFrom(fresh.loser_next_match_id, fresh.loser_next_match_slot);
  }
}

/**
 * CUSTOM JURY PLACEMENT 1: Swap two entries across all unplayed matches in a stage (Groups or Bracket)
 */
export async function swapTwoEntriesInStage(
  stageId: string,
  entryAId: string,
  entryBId: string
) {
  if (!entryAId || !entryBId || entryAId === entryBId) return;

  const { data: stageMatches } = await supabase
    .from('matches')
    .select('*')
    .eq('stage_id', stageId);

  if (!stageMatches) return;

  const hasCompleted = (stageMatches as Match[]).some(
    (m) =>
      m.status === 'completed' &&
      (m.entry1_id === entryAId ||
        m.entry2_id === entryAId ||
        m.entry1_id === entryBId ||
        m.entry2_id === entryBId)
  );
  if (hasCompleted) {
    throw new Error(
      'Нельзя менять игроков, которые уже сыграли матч в этом этапе / Cannot swap players who already played a match in this stage'
    );
  }

  for (const m of stageMatches as Match[]) {
    if (m.status === 'completed') continue;

    let newE1 = m.entry1_id;
    let newE2 = m.entry2_id;
    let newWinner = m.winner_entry_id;
    let changed = false;

    if (m.entry1_id === entryAId) {
      newE1 = entryBId;
      changed = true;
    } else if (m.entry1_id === entryBId) {
      newE1 = entryAId;
      changed = true;
    }

    if (m.entry2_id === entryAId) {
      newE2 = entryBId;
      changed = true;
    } else if (m.entry2_id === entryBId) {
      newE2 = entryAId;
      changed = true;
    }

    if (m.status === 'walkover') {
      if (m.winner_entry_id === entryAId) newWinner = entryBId;
      else if (m.winner_entry_id === entryBId) newWinner = entryAId;
    }

    if (changed) {
      await supabase
        .from('matches')
        .update({ entry1_id: newE1, entry2_id: newE2, winner_entry_id: newWinner })
        .eq('id', m.id);
    }
  }
}

/**
 * CUSTOM JURY PLACEMENT 2: Directly place any entry (or empty/BYE) into Slot 1 or Slot 2 of a specific match.
 *
 * If the chosen entry already sits in another slot of the same round, the two
 * are SWAPPED (the displaced entry moves to the chosen entry's old slot), so a
 * player can never end up in two matches of the same round.
 */
export async function assignEntryToMatchSlot(
  match: Match,
  slot: 1 | 2,
  newEntryId: string | null
) {
  const { data: roundRows, error } = await supabase
    .from('matches')
    .select('*')
    .eq('stage_id', match.stage_id)
    .eq('bracket_type', match.bracket_type)
    .eq('round_number', match.round_number);
  if (error) throw new Error(error.message);

  const siblings = (roundRows as Match[]) || [];
  const fresh = siblings.find((m) => m.id === match.id);
  if (!fresh) throw new Error('Матч не найден / Match not found');
  if (fresh.status === 'completed') {
    throw new Error('Матч уже сыгран / Match already played');
  }

  const displaced = slot === 1 ? fresh.entry1_id : fresh.entry2_id;
  if (displaced === newEntryId) return;

  let e1 = slot === 1 ? newEntryId : fresh.entry1_id;
  let e2 = slot === 2 ? newEntryId : fresh.entry2_id;

  if (newEntryId) {
    const other = siblings.find(
      (m) => m.id !== fresh.id && (m.entry1_id === newEntryId || m.entry2_id === newEntryId)
    );
    if (other) {
      if (other.status === 'completed') {
        throw new Error(
          'Этот участник уже сыграл в этом раунде / This entry already played in this round'
        );
      }
      const otherSlot: 1 | 2 = other.entry1_id === newEntryId ? 1 : 2;
      await writeMatchSlots(
        other,
        otherSlot === 1 ? displaced : other.entry1_id,
        otherSlot === 2 ? displaced : other.entry2_id
      );
    } else if (slot === 1 && fresh.entry2_id === newEntryId) {
      e2 = displaced; // swap inside the same match
    } else if (slot === 2 && fresh.entry1_id === newEntryId) {
      e1 = displaced;
    }
  }

  await writeMatchSlots(fresh, e1, e2);
}

/** Writes both slots of a not-yet-played match and keeps Round 1 BYEs + their parent slot in sync. */
async function writeMatchSlots(match: Match, e1: string | null, e2: string | null) {
  const isR1Main = match.round_number === 1 && match.bracket_type === 'main';
  const isBye = isR1Main && Boolean(e1) !== Boolean(e2);
  const byeWinner = isBye ? e1 || e2 : null;

  const { error } = await supabase
    .from('matches')
    .update({
      entry1_id: e1,
      entry2_id: e2,
      winner_entry_id: byeWinner,
      entry1_score: isBye && e1 ? 1 : 0,
      entry2_score: isBye && e2 ? 1 : 0,
      status: isBye ? 'walkover' : 'scheduled',
    })
    .eq('id', match.id);
  if (error) throw new Error(error.message);

  // Round 1 BYE winners sit in the Round 2 slot already -> keep it in sync
  if (isR1Main && match.next_match_id && match.next_match_slot) {
    const col =
      match.next_match_slot === 1 ? { entry1_id: byeWinner } : { entry2_id: byeWinner };
    await supabase.from('matches').update(col).eq('id', match.next_match_id);
  }
}

export async function createAndAdvanceToStage2(
  tournamentId: string,
  orderedQualifierRows: StandingRow[],
  stage2Format: StageFormat
) {
  if (orderedQualifierRows.length < 2) {
    throw new Error('Выберите минимум 2 участников / Select at least 2 qualifiers');
  }

  const seededQualifiers = [...orderedQualifierRows]
    .sort((a, b) => {
      if (a.rankInGroup !== b.rankInGroup) return a.rankInGroup - b.rankInGroup;
      const winRateA = a.played > 0 ? a.wins / a.played : 0;
      const winRateB = b.played > 0 ? b.wins / b.played : 0;
      if (winRateB !== winRateA) return winRateB - winRateA;
      if (b.setDiff !== a.setDiff) return b.setDiff - a.setDiff;
      return b.entry.seed_elo - a.entry.seed_elo;
    })
    .map((r) => r.entry);

  const { data: existingStage2 } = await supabase
    .from('tournament_stages')
    .select('*')
    .eq('tournament_id', tournamentId)
    .eq('stage_order', 2)
    .maybeSingle();

  let stage2Id = existingStage2?.id;

  if (!stage2Id) {
    const { data: createdS2, error: s2Err } = await supabase
      .from('tournament_stages')
      .insert({
        tournament_id: tournamentId,
        stage_order: 2,
        name: 'Playoffs (Stage 2)',
        format: stage2Format,
        status: 'in_progress',
      })
      .select()
      .single();
    if (s2Err) {
      if (isUniqueViolation(s2Err)) throw new Error(CONCURRENT_DRAW_MSG);
      throw new Error(s2Err.message);
    }
    if (!createdS2) throw new Error('Не удалось создать Этап 2 / Failed to create Stage 2');
    stage2Id = createdS2.id;

    // Defence when DB unique index is missing: verify only one stage_order=2 exists
    const { data: stage2Rows } = await supabase
      .from('tournament_stages')
      .select('id')
      .eq('tournament_id', tournamentId)
      .eq('stage_order', 2);
    const list = (stage2Rows as { id: string }[]) || [];
    if (list.length > 1 && list[0].id !== stage2Id) {
      await supabase.from('tournament_stages').delete().eq('id', stage2Id);
      throw new Error(CONCURRENT_DRAW_MSG);
    }
  } else {
    await supabase
      .from('tournament_stages')
      .update({ format: stage2Format, status: 'in_progress' })
      .eq('id', stage2Id);
  }

  await generateStageDraw(tournamentId, stage2Id, stage2Format, seededQualifiers, 1, true, 'elo');
  return stage2Id;
}

export async function completeTournamentAndAssignMedals(
  tournamentId: string,
  stageMatches: Match[],
  format: StageFormat,
  entries: TournamentEntry[]
) {
  await supabase
    .from('tournament_entries')
    .update({ final_placement: null })
    .eq('tournament_id', tournamentId);

  let firstId: string | null = null;
  let secondId: string | null = null;
  let thirdId: string | null = null;

  if (format === 'single_elimination') {
    const mainMatches = stageMatches.filter((m) => m.bracket_type === 'main');
    const maxR = Math.max(...mainMatches.map((m) => m.round_number));
    const finalMatch = mainMatches.find((m) => m.round_number === maxR);
    if (finalMatch?.winner_entry_id) {
      firstId = finalMatch.winner_entry_id;
      secondId =
        finalMatch.winner_entry_id === finalMatch.entry1_id
          ? finalMatch.entry2_id
          : finalMatch.entry1_id;
    }
    const bronzeMatch = stageMatches.find((m) => m.bracket_type === 'third_place');
    if (bronzeMatch) {
      thirdId =
        bronzeMatch.winner_entry_id || bronzeMatch.entry1_id || bronzeMatch.entry2_id || null;
    }
  } else if (format === 'double_elimination') {
    const gf = stageMatches.find((m) => m.bracket_type === 'grand_final');
    if (gf?.winner_entry_id) {
      firstId = gf.winner_entry_id;
      secondId = gf.winner_entry_id === gf.entry1_id ? gf.entry2_id : gf.entry1_id;
    }
    const lbMatches = stageMatches.filter((m) => m.bracket_type === 'losers');
    if (lbMatches.length > 0) {
      const maxLbR = Math.max(...lbMatches.map((m) => m.round_number));
      const lbFinal = lbMatches.find((m) => m.round_number === maxLbR);
      if (lbFinal?.winner_entry_id) {
        thirdId =
          lbFinal.winner_entry_id === lbFinal.entry1_id ? lbFinal.entry2_id : lbFinal.entry1_id;
      }
    }
  } else {
    const standings = computeStageStandings(stageMatches, entries, true);
    firstId = standings[0]?.entry.id || null;
    secondId = standings[1]?.entry.id || null;
    thirdId = standings[2]?.entry.id || null;
  }

  if (firstId) {
    await supabase.from('tournament_entries').update({ final_placement: 1 }).eq('id', firstId);
  }
  if (secondId) {
    await supabase.from('tournament_entries').update({ final_placement: 2 }).eq('id', secondId);
  }
  if (thirdId) {
    await supabase.from('tournament_entries').update({ final_placement: 3 }).eq('id', thirdId);
  }

  await supabase.from('tournaments').update({ status: 'completed' }).eq('id', tournamentId);
}

export interface TournamentLifecyclePermissions {
  isPreStartStatus: boolean;
  hasStartedMatches: boolean;
  canEditMetadata: boolean;
  canEditStructure: boolean;
  canCancel: boolean;
  canDelete: boolean;
}

export function getTournamentLifecyclePermissions(
  status: TournamentStatus,
  matches: Array<Pick<Match, 'status'>>
): TournamentLifecyclePermissions {
  const isPreStartStatus =
    status === 'scheduled' ||
    status === 'registration_open' ||
    status === 'check_in' ||
    status === 'archived';
  const hasStartedMatches = matches.some(
    (m) => m.status === 'completed' || m.status === 'in_progress'
  );
  return {
    isPreStartStatus,
    hasStartedMatches,
    canEditMetadata: status !== 'completed',
    canEditStructure: isPreStartStatus && !hasStartedMatches,
    canCancel: isPreStartStatus && status !== 'archived' && !hasStartedMatches,
    canDelete: isPreStartStatus && !hasStartedMatches,
  };
}

export async function updateTournamentDetails(
  tournamentId: string,
  updates: {
    title: string;
    description: string | null;
    event_date: string;
    type?: MatchType;
    best_of?: number;
    is_rated?: boolean;
    stage1Id?: string;
    stage1Format?: StageFormat;
  }
) {
  const [{ data: tRow, error: tFetchErr }, { data: mRows, error: mFetchErr }] =
    await Promise.all([
      supabase.from('tournaments').select('status').eq('id', tournamentId).single(),
      supabase.from('matches').select('status').eq('tournament_id', tournamentId),
    ]);

  if (tFetchErr || !tRow) {
    throw new Error(tFetchErr?.message || 'Турнир не найден / Tournament not found');
  }
  if (mFetchErr) throw new Error(mFetchErr.message);

  const perms = getTournamentLifecyclePermissions(
    (tRow as { status: TournamentStatus }).status,
    (mRows as Array<Pick<Match, 'status'>>) || []
  );

  if (!perms.canEditMetadata) {
    throw new Error(
      'Нельзя редактировать завершённый турнир / Completed tournaments cannot be edited'
    );
  }

  const payload: Record<string, unknown> = {
    title: updates.title.trim(),
    description: updates.description?.trim() || null,
    event_date: updates.event_date,
  };

  if (perms.canEditStructure) {
    if (updates.type !== undefined) payload.type = updates.type;
    if (updates.best_of !== undefined) payload.best_of = updates.best_of;
    if (updates.is_rated !== undefined) payload.is_rated = updates.is_rated;
  }

  const { error: updErr } = await supabase
    .from('tournaments')
    .update(payload)
    .eq('id', tournamentId);
  if (updErr) throw new Error(updErr.message);

  if (perms.canEditStructure && updates.stage1Id && updates.stage1Format) {
    const { error: sErr } = await supabase
      .from('tournament_stages')
      .update({ format: updates.stage1Format })
      .eq('id', updates.stage1Id);
    if (sErr) throw new Error(sErr.message);
  }
}

export async function deleteUnstartedTournament(tournamentId: string) {
  const [{ data: tRow, error: tFetchErr }, { data: mRows, error: mFetchErr }] =
    await Promise.all([
      supabase.from('tournaments').select('status').eq('id', tournamentId).single(),
      supabase.from('matches').select('status').eq('tournament_id', tournamentId),
    ]);

  if (tFetchErr || !tRow) {
    throw new Error(tFetchErr?.message || 'Турнир не найден / Tournament not found');
  }
  if (mFetchErr) throw new Error(mFetchErr.message);

  const perms = getTournamentLifecyclePermissions(
    (tRow as { status: TournamentStatus }).status,
    (mRows as Array<Pick<Match, 'status'>>) || []
  );

  if (!perms.canDelete) {
    throw new Error(
      'Удалять можно только турниры, которые ещё не начались и не имеют сыгранных матчей / Only unstarted tournaments with no played matches can be deleted'
    );
  }

  // Delete dependent rows explicitly in safe FK order
  const { error: mDelErr } = await supabase
    .from('matches')
    .delete()
    .eq('tournament_id', tournamentId);
  if (mDelErr) throw new Error(mDelErr.message);

  const { error: sDelErr } = await supabase
    .from('tournament_stages')
    .delete()
    .eq('tournament_id', tournamentId);
  if (sDelErr) throw new Error(sDelErr.message);

  const { error: eDelErr } = await supabase
    .from('tournament_entries')
    .delete()
    .eq('tournament_id', tournamentId);
  if (eDelErr) throw new Error(eDelErr.message);

  const { error: tDelErr } = await supabase
    .from('tournaments')
    .delete()
    .eq('id', tournamentId);
  if (tDelErr) throw new Error(tDelErr.message);
}