import { supabase } from './supabase';
import { TournamentEntry, Match, StageFormat } from '@/types/database';

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

function getStandardSeedOrder(bracketSize: number): number[] {
  let rounds = [1];
  while (rounds.length < bracketSize) {
    const nextSize = rounds.length * 2;
    const nextRound: number[] = [];
    for (const seed of rounds) {
      nextRound.push(seed);
      nextRound.push(nextSize + 1 - seed);
    }
    rounds = nextRound;
  }
  return rounds;
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
 */
export async function generateStageDraw(
  tournamentId: string,
  stageId: string,
  format: StageFormat,
  entriesToUse: TournamentEntry[],
  groupCount: number = 2,
  preserveOrder: boolean = false,
  seedingMode: SeedingMode = 'elo'
) {
  if (entriesToUse.length < 2) {
    throw new Error('Минимум 2 участника / Need at least 2 entries');
  }

  const { error: delError } = await supabase.from('matches').delete().eq('stage_id', stageId);
  if (delError) throw new Error(delError.message);

  let sorted = [...entriesToUse];

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

  for (let i = 0; i < sorted.length; i++) {
    await supabase
      .from('tournament_entries')
      .update({ seed_number: i + 1 })
      .eq('id', sorted[i].id);
  }

  if (format === 'single_elimination') {
    await generateSingleElimination(tournamentId, stageId, sorted, true);
  } else if (format === 'double_elimination') {
    await generateDoubleElimination(tournamentId, stageId, sorted);
  } else if (format === 'round_robin') {
    await generateRoundRobin(tournamentId, stageId, sorted, groupCount);
  } else if (format === 'swiss') {
    await generateNextSwissRound(tournamentId, stageId, sorted, []);
  }

  await supabase.from('tournament_stages').update({ status: 'in_progress' }).eq('id', stageId);
  await supabase.from('tournaments').update({ status: 'in_progress' }).eq('id', tournamentId);
}

async function generateSingleElimination(
  tournamentId: string,
  stageId: string,
  seededEntries: TournamentEntry[],
  includeThirdPlace: boolean = true
) {
  const n = seededEntries.length;
  const totalRounds = Math.ceil(Math.log2(n));
  const bracketSize = Math.pow(2, totalRounds);
  const seedOrder = getStandardSeedOrder(bracketSize);

  const matchesByRound: Record<number, Match[]> = {};
  let thirdPlaceMatch: Match | null = null;

  if (includeThirdPlace && n >= 4 && totalRounds >= 2) {
    const { data: bronzeMatch, error: bErr } = await supabase
      .from('matches')
      .insert({
        tournament_id: tournamentId,
        stage_id: stageId,
        round_number: totalRounds,
        match_number: 2,
        bracket_type: 'third_place',
        status: 'scheduled',
      })
      .select()
      .single();

    if (bErr) throw new Error(bErr.message);
    thirdPlaceMatch = bronzeMatch as Match;
  }

  for (let round = totalRounds; round >= 1; round--) {
    const numMatches = bracketSize / Math.pow(2, round);
    matchesByRound[round] = [];

    for (let m = 0; m < numMatches; m++) {
      const parentMatch =
        round < totalRounds ? matchesByRound[round + 1][Math.floor(m / 2)] : null;
      const nextSlot: 1 | 2 | null = parentMatch ? (m % 2 === 0 ? 1 : 2) : null;

      const isSemifinal = round === totalRounds - 1 && thirdPlaceMatch !== null;
      const loserNextId = isSemifinal ? thirdPlaceMatch!.id : null;
      const loserNextSlot: 1 | 2 | null = isSemifinal ? (m === 0 ? 1 : 2) : null;

      let entry1: TournamentEntry | null = null;
      let entry2: TournamentEntry | null = null;

      if (round === 1) {
        const seed1 = seedOrder[m * 2];
        const seed2 = seedOrder[m * 2 + 1];
        entry1 = seed1 <= n ? seededEntries[seed1 - 1] : null;
        entry2 = seed2 <= n ? seededEntries[seed2 - 1] : null;
      }

      const isBye = round === 1 && ((entry1 && !entry2) || (!entry1 && entry2));
      const byeWinner = isBye ? (entry1 || entry2)! : null;

      const { data: createdMatch, error } = await supabase
        .from('matches')
        .insert({
          tournament_id: tournamentId,
          stage_id: stageId,
          round_number: round,
          match_number: m + 1,
          bracket_type: 'main',
          entry1_id: entry1?.id || null,
          entry2_id: entry2?.id || null,
          entry1_score: isBye && entry1 ? 1 : 0,
          entry2_score: isBye && entry2 ? 1 : 0,
          winner_entry_id: byeWinner?.id || null,
          status: isBye ? 'walkover' : 'scheduled',
          next_match_id: parentMatch?.id || null,
          next_match_slot: nextSlot,
          loser_next_match_id: loserNextId,
          loser_next_match_slot: loserNextSlot,
        })
        .select()
        .single();

      if (error || !createdMatch) throw new Error(error?.message);
      matchesByRound[round].push(createdMatch as Match);

      if (isBye && byeWinner && parentMatch && nextSlot) {
        const updateCol =
          nextSlot === 1 ? { entry1_id: byeWinner.id } : { entry2_id: byeWinner.id };
        await supabase.from('matches').update(updateCol).eq('id', parentMatch.id);
      }
    }
  }
}

async function generateDoubleElimination(
  tournamentId: string,
  stageId: string,
  seededEntries: TournamentEntry[]
) {
  await generateSingleElimination(tournamentId, stageId, seededEntries, false);

  const { data: wbMatches } = await supabase
    .from('matches')
    .select('*')
    .eq('stage_id', stageId)
    .eq('bracket_type', 'main')
    .order('round_number', { ascending: true })
    .order('match_number', { ascending: true });

  if (!wbMatches || wbMatches.length === 0) return;

  const maxWbRound = Math.max(...wbMatches.map((m) => m.round_number));
  const wbFinal = wbMatches.find((m) => m.round_number === maxWbRound)!;

  const { data: grandFinal, error: gfErr } = await supabase
    .from('matches')
    .insert({
      tournament_id: tournamentId,
      stage_id: stageId,
      round_number: 1,
      match_number: 1,
      bracket_type: 'grand_final',
      status: 'scheduled',
    })
    .select()
    .single();

  if (gfErr || !grandFinal) throw new Error(gfErr?.message);

  await supabase
    .from('matches')
    .update({ next_match_id: grandFinal.id, next_match_slot: 1 })
    .eq('id', wbFinal.id);

  const wbRound1 = wbMatches.filter((m) => m.round_number === 1);
  const lbRound1Count = Math.max(1, Math.floor(wbRound1.length / 2));
  const totalLbRounds = Math.max(1, Math.ceil(Math.log2(lbRound1Count)) + 1);
  const lbByRound: Record<number, Match[]> = {};

  for (let r = totalLbRounds; r >= 1; r--) {
    const count = r === totalLbRounds ? 1 : Math.max(1, Math.pow(2, totalLbRounds - 1 - r));
    lbByRound[r] = [];

    for (let m = 0; m < count; m++) {
      const parent =
        r === totalLbRounds
          ? (grandFinal as Match)
          : lbByRound[r + 1][Math.floor(m / 2)] || lbByRound[r + 1][0];
      const nextSlot: 1 | 2 = r === totalLbRounds ? 2 : m % 2 === 0 ? 1 : 2;

      const { data: lbMatch } = await supabase
        .from('matches')
        .insert({
          tournament_id: tournamentId,
          stage_id: stageId,
          round_number: r,
          match_number: m + 1,
          bracket_type: 'losers',
          next_match_id: parent.id,
          next_match_slot: nextSlot,
          status: 'scheduled',
        })
        .select()
        .single();

      if (lbMatch) lbByRound[r].push(lbMatch as Match);
    }
  }

  for (let idx = 0; idx < wbRound1.length; idx++) {
    const wbM = wbRound1[idx];
    const targetLb = lbByRound[1]?.[Math.floor(idx / 2)];
    if (targetLb) {
      const slot: 1 | 2 = idx % 2 === 0 ? 1 : 2;
      await supabase
        .from('matches')
        .update({ loser_next_match_id: targetLb.id, loser_next_match_slot: slot })
        .eq('id', wbM.id);
    }
  }

  const lbFinal = lbByRound[totalLbRounds]?.[0];
  if (lbFinal && totalLbRounds > 1) {
    await supabase
      .from('matches')
      .update({ loser_next_match_id: lbFinal.id, loser_next_match_slot: 2 })
      .eq('id', wbFinal.id);
  }
}

async function generateRoundRobin(
  tournamentId: string,
  stageId: string,
  seededEntries: TournamentEntry[],
  groupCount: number = 2
) {
  const safeGroups = Math.max(1, Math.min(groupCount, Math.floor(seededEntries.length / 2)));
  const groups: TournamentEntry[][] = Array.from({ length: safeGroups }, () => []);

  seededEntries.forEach((entry, index) => {
    const row = Math.floor(index / safeGroups);
    const posInRow = index % safeGroups;
    const targetGroup = row % 2 === 0 ? posInRow : safeGroups - 1 - posInRow;
    groups[targetGroup].push(entry);
  });

  const matchesToInsert = [];

  for (let g = 0; g < groups.length; g++) {
    const groupPlayers = groups[g];
    let matchCounter = 1;

    for (let i = 0; i < groupPlayers.length; i++) {
      for (let j = i + 1; j < groupPlayers.length; j++) {
        matchesToInsert.push({
          tournament_id: tournamentId,
          stage_id: stageId,
          round_number: 1,
          match_number: matchCounter++,
          group_number: g + 1,
          bracket_type: 'main',
          entry1_id: groupPlayers[i].id,
          entry2_id: groupPlayers[j].id,
          entry1_score: 0,
          entry2_score: 0,
          winner_entry_id: null,
          status: 'scheduled',
        });
      }
    }
  }

  if (matchesToInsert.length > 0) {
    const { error } = await supabase.from('matches').insert(matchesToInsert);
    if (error) throw new Error(error.message);
  }
}

export async function generateNextSwissRound(
  tournamentId: string,
  stageId: string,
  checkedInEntries: TournamentEntry[],
  existingMatches: Match[]
) {
  const stageMatches = existingMatches.filter((m) => m.stage_id === stageId);
  const currentMaxRound = stageMatches.reduce((max, m) => Math.max(max, m.round_number), 0);
  const nextRound = currentMaxRound + 1;

  const winsMap: Record<string, number> = {};
  const playedAgainst: Record<string, Set<string>> = {};

  checkedInEntries.forEach((e) => {
    winsMap[e.id] = 0;
    playedAgainst[e.id] = new Set();
  });

  stageMatches.forEach((m) => {
    if (m.winner_entry_id && winsMap[m.winner_entry_id] !== undefined) {
      winsMap[m.winner_entry_id] += 1;
    }
    if (m.entry1_id && m.entry2_id) {
      playedAgainst[m.entry1_id]?.add(m.entry2_id);
      playedAgainst[m.entry2_id]?.add(m.entry1_id);
    }
  });

  const pool = [...checkedInEntries].sort(
    (a, b) => winsMap[b.id] - winsMap[a.id] || b.seed_elo - a.seed_elo
  );

  const paired = new Set<string>();
  const newMatches = [];
  let matchNum = 1;

  for (let i = 0; i < pool.length; i++) {
    const p1 = pool[i];
    if (paired.has(p1.id)) continue;

    let partnerIdx = -1;
    for (let j = i + 1; j < pool.length; j++) {
      const candidate = pool[j];
      if (!paired.has(candidate.id) && !playedAgainst[p1.id]?.has(candidate.id)) {
        partnerIdx = j;
        break;
      }
    }
    if (partnerIdx === -1) {
      for (let j = i + 1; j < pool.length; j++) {
        if (!paired.has(pool[j].id)) {
          partnerIdx = j;
          break;
        }
      }
    }

    if (partnerIdx !== -1) {
      const p2 = pool[partnerIdx];
      paired.add(p1.id);
      paired.add(p2.id);
      newMatches.push({
        tournament_id: tournamentId,
        stage_id: stageId,
        round_number: nextRound,
        match_number: matchNum++,
        group_number: 1,
        bracket_type: 'main',
        entry1_id: p1.id,
        entry2_id: p2.id,
        entry1_score: 0,
        entry2_score: 0,
        winner_entry_id: null,
        status: 'scheduled',
      });
    } else {
      paired.add(p1.id);
      newMatches.push({
        tournament_id: tournamentId,
        stage_id: stageId,
        round_number: nextRound,
        match_number: matchNum++,
        group_number: 1,
        bracket_type: 'main',
        entry1_id: p1.id,
        entry2_id: null,
        entry1_score: 1,
        entry2_score: 0,
        winner_entry_id: p1.id,
        status: 'walkover',
      });
    }
  }

  if (newMatches.length > 0) {
    const { error } = await supabase.from('matches').insert(newMatches);
    if (error) throw new Error(error.message);
  }
}

export async function submitMatchResult(
  match: Match,
  score1: number,
  score2: number,
  bestOf: number,
  isRated: boolean
) {
  if (!match.entry1_id || !match.entry2_id) {
    throw new Error('Оба участника должны быть известны / Both match slots must be filled');
  }

  const setsToWin = Math.ceil(bestOf / 2);
  const maxScore = Math.max(score1, score2);
  const minScore = Math.min(score1, score2);

  if (score1 === score2 || maxScore !== setsToWin || minScore < 0 || minScore >= setsToWin) {
    throw new Error(
      `Недопустимый счёт для Bo${bestOf}. Победитель должен набрать ${setsToWin} сета.`
    );
  }

  const isAlreadyCompleted = match.status === 'completed';
  const winnerId = score1 > score2 ? match.entry1_id : match.entry2_id;
  const loserId = score1 > score2 ? match.entry2_id : match.entry1_id;

  const { error } = await supabase
    .from('matches')
    .update({
      entry1_score: score1,
      entry2_score: score2,
      winner_entry_id: winnerId,
      table_number: null,
      status: 'completed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', match.id);

  if (error) throw new Error(error.message);

  if (match.next_match_id && match.next_match_slot) {
    const col = match.next_match_slot === 1 ? { entry1_id: winnerId } : { entry2_id: winnerId };
    await supabase.from('matches').update(col).eq('id', match.next_match_id);
  }

  if (match.loser_next_match_id && match.loser_next_match_slot) {
    const col =
      match.loser_next_match_slot === 1 ? { entry1_id: loserId } : { entry2_id: loserId };
    await supabase.from('matches').update(col).eq('id', match.loser_next_match_id);
  }

  if (isRated && !isAlreadyCompleted && match.entry1 && match.entry2) {
    const K = 32;
    const rA = match.entry1.seed_elo;
    const rB = match.entry2.seed_elo;
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
            match_id: match.id,
            elo_before: p.elo_rating,
            elo_after: newElo,
            reason: won ? `Match win (+${delta})` : `Match loss (${delta})`,
          });
        }
      }
    };

    await updateEntryPlayers(match.entry1, deltaA, score1 > score2);
    await updateEntryPlayers(match.entry2, deltaB, score2 > score1);
  }
}

/**
 * UNDO / RESET COMPLETED MATCH:
 * Reverts Elo changes from rating_logs, clears advanced slots in next matches, and resets match to 'scheduled'.
 */
export async function undoMatchResult(match: Match) {
  if (match.status !== 'completed') return;

  // 1. Revert Elo and W/L using rating_logs for this match
  const { data: logs } = await supabase
    .from('rating_logs')
    .select('*')
    .eq('match_id', match.id);

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
    await supabase.from('rating_logs').delete().eq('match_id', match.id);
  }

  // 2. Pull winner back from next_match_id
  if (match.next_match_id && match.next_match_slot) {
    const col = match.next_match_slot === 1 ? { entry1_id: null } : { entry2_id: null };
    await supabase.from('matches').update(col).eq('id', match.next_match_id);
  }

  // 3. Pull loser back from loser_next_match_id
  if (match.loser_next_match_id && match.loser_next_match_slot) {
    const col = match.loser_next_match_slot === 1 ? { entry1_id: null } : { entry2_id: null };
    await supabase.from('matches').update(col).eq('id', match.loser_next_match_id);
  }

  // 4. Reset match row
  await supabase
    .from('matches')
    .update({
      entry1_score: 0,
      entry2_score: 0,
      winner_entry_id: null,
      status: 'scheduled',
    })
    .eq('id', match.id);
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
 * CUSTOM JURY PLACEMENT 2: Directly place any entry (or empty/BYE) into Slot 1 or Slot 2 of a specific match
 */
export async function assignEntryToMatchSlot(
  match: Match,
  slot: 1 | 2,
  newEntryId: string | null
) {
  const updatedE1 = slot === 1 ? newEntryId : match.entry1_id;
  const updatedE2 = slot === 2 ? newEntryId : match.entry2_id;

  const isBye =
    match.round_number === 1 &&
    match.bracket_type === 'main' &&
    ((updatedE1 && !updatedE2) || (!updatedE1 && updatedE2));
  const byeWinner = isBye ? updatedE1 || updatedE2 : null;

  await supabase
    .from('matches')
    .update({
      entry1_id: updatedE1,
      entry2_id: updatedE2,
      winner_entry_id: isBye ? byeWinner : null,
      entry1_score: isBye && updatedE1 ? 1 : 0,
      entry2_score: isBye && updatedE2 ? 1 : 0,
      status: isBye ? 'walkover' : 'scheduled',
    })
    .eq('id', match.id);

  // If this created or changed a Round 1 BYE, update the parent Round 2 slot automatically
  if (match.next_match_id && match.next_match_slot) {
    const parentVal = isBye ? byeWinner : null;
    const col =
      match.next_match_slot === 1 ? { entry1_id: parentVal } : { entry2_id: parentVal };
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
    if (s2Err || !createdS2) throw new Error(s2Err?.message);
    stage2Id = createdS2.id;
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