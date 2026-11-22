/**
 * Pure (database-free) bracket construction + integrity checks.
 *
 * Brackets are built completely in memory with client-generated UUIDs and then
 * written with ONE bulk insert. Previously every match was inserted one by one
 * (15+ round-trips for 8 players), so two "Generate draw" runs that overlapped
 * (double click, two jury devices, slow gym Wi-Fi) both deleted the old matches
 * first and then both inserted a full bracket -> every match existed twice and
 * players showed up in two places at once.
 */
import type { Match, MatchStatus, StageFormat, TournamentEntry } from '@/types/database';

export interface MatchRow {
  id: string;
  tournament_id: string;
  stage_id: string;
  round_number: number;
  match_number: number;
  group_number: number | null;
  bracket_type: 'main' | 'third_place' | 'losers' | 'grand_final';
  entry1_id: string | null;
  entry2_id: string | null;
  entry1_score: number;
  entry2_score: number;
  winner_entry_id: string | null;
  status: MatchStatus;
  next_match_id: string | null;
  next_match_slot: 1 | 2 | null;
  loser_next_match_id: string | null;
  loser_next_match_slot: 1 | 2 | null;
}

export type IdGen = () => string;
export const defaultIdGen: IdGen = () => globalThis.crypto.randomUUID();

export function getStandardSeedOrder(bracketSize: number): number[] {
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

function blankRow(
  idGen: IdGen,
  tournamentId: string,
  stageId: string,
  fields: Partial<MatchRow> & Pick<MatchRow, 'round_number' | 'match_number' | 'bracket_type'>
): MatchRow {
  return {
    id: idGen(),
    tournament_id: tournamentId,
    stage_id: stageId,
    group_number: null,
    entry1_id: null,
    entry2_id: null,
    entry1_score: 0,
    entry2_score: 0,
    winner_entry_id: null,
    status: 'scheduled',
    next_match_id: null,
    next_match_slot: null,
    loser_next_match_id: null,
    loser_next_match_slot: null,
    ...fields,
  };
}

export function buildSingleElimination(
  tournamentId: string,
  stageId: string,
  seededEntries: TournamentEntry[],
  includeThirdPlace: boolean = true,
  idGen: IdGen = defaultIdGen
): MatchRow[] {
  const n = seededEntries.length;
  if (n < 2) throw new Error('Минимум 2 участника / Need at least 2 entries');

  const totalRounds = Math.ceil(Math.log2(n));
  const bracketSize = Math.pow(2, totalRounds);
  const seedOrder = getStandardSeedOrder(bracketSize);

  const byRound: MatchRow[][] = [];
  for (let round = 1; round <= totalRounds; round++) {
    const count = bracketSize / Math.pow(2, round);
    byRound[round] = Array.from({ length: count }, (_, m) =>
      blankRow(idGen, tournamentId, stageId, {
        round_number: round,
        match_number: m + 1,
        bracket_type: 'main',
      })
    );
  }

  // Winner links
  for (let round = 1; round < totalRounds; round++) {
    byRound[round].forEach((row, m) => {
      row.next_match_id = byRound[round + 1][Math.floor(m / 2)].id;
      row.next_match_slot = m % 2 === 0 ? 1 : 2;
    });
  }

  // Bronze match
  let bronze: MatchRow | null = null;
  if (includeThirdPlace && n >= 4 && totalRounds >= 2) {
    bronze = blankRow(idGen, tournamentId, stageId, {
      round_number: totalRounds,
      match_number: 2,
      bracket_type: 'third_place',
    });
    byRound[totalRounds - 1].forEach((semi, m) => {
      semi.loser_next_match_id = bronze!.id;
      semi.loser_next_match_slot = m === 0 ? 1 : 2;
    });
  }

  // Round 1 seeding + BYEs (top seeds get the byes)
  const byId = new Map<string, MatchRow>();
  byRound.flat().forEach((r) => byId.set(r.id, r));
  byRound[1].forEach((row, m) => {
    const seed1 = seedOrder[m * 2];
    const seed2 = seedOrder[m * 2 + 1];
    row.entry1_id = seed1 <= n ? seededEntries[seed1 - 1].id : null;
    row.entry2_id = seed2 <= n ? seededEntries[seed2 - 1].id : null;

    const isBye = Boolean(row.entry1_id) !== Boolean(row.entry2_id);
    if (isBye) {
      const winner = (row.entry1_id || row.entry2_id)!;
      row.status = 'walkover';
      row.winner_entry_id = winner;
      row.entry1_score = row.entry1_id ? 1 : 0;
      row.entry2_score = row.entry2_id ? 1 : 0;
      if (row.next_match_id) {
        const parent = byId.get(row.next_match_id)!;
        if (row.next_match_slot === 1) parent.entry1_id = winner;
        else parent.entry2_id = winner;
      }
    }
  });

  const rows = byRound.flat();
  if (bronze) rows.push(bronze);
  return rows;
}

/**
 * Full double elimination for a 2^k bracket:
 *   WB rounds 1..k, LB rounds 1..2(k-1), one Grand Final.
 *   LB odd rounds  : winners of the previous LB round play each other
 *                    (LB round 1: losers of WB round 1).
 *   LB even rounds : LB survivor (slot 1) vs the loser dropping from WB (slot 2).
 *
 * LB matches that can only ever receive ONE player (because of WB byes) are
 * created as 'walkover' pass-through matches: when the single player arrives
 * the engine advances them automatically. Matches that receive nobody are
 * 'walkover' with no winner and never block anything.
 */
export function buildDoubleElimination(
  tournamentId: string,
  stageId: string,
  seededEntries: TournamentEntry[],
  idGen: IdGen = defaultIdGen
): MatchRow[] {
  const wb = buildSingleElimination(tournamentId, stageId, seededEntries, false, idGen);
  const k = Math.max(...wb.map((m) => m.round_number));
  const wbRound = (r: number) =>
    wb.filter((m) => m.round_number === r).sort((a, b) => a.match_number - b.match_number);
  const wbFinal = wbRound(k)[0];

  const gf = blankRow(idGen, tournamentId, stageId, {
    round_number: 1,
    match_number: 1,
    bracket_type: 'grand_final',
  });
  wbFinal.next_match_id = gf.id;
  wbFinal.next_match_slot = 1;

  if (k === 1) {
    // 2 players: the WB final loser goes straight to the grand final.
    wbFinal.loser_next_match_id = gf.id;
    wbFinal.loser_next_match_slot = 2;
    return [...wb, gf];
  }

  const bracketSize = Math.pow(2, k);
  const lbRounds = 2 * (k - 1);
  const lb: MatchRow[][] = [];
  for (let r = 1; r <= lbRounds; r++) {
    const count = bracketSize / Math.pow(2, Math.ceil(r / 2) + 1);
    lb[r] = Array.from({ length: count }, (_, m) =>
      blankRow(idGen, tournamentId, stageId, {
        round_number: r,
        match_number: m + 1,
        bracket_type: 'losers',
      })
    );
  }

  // LB winner links
  for (let r = 1; r <= lbRounds; r++) {
    lb[r].forEach((row, m) => {
      if (r === lbRounds) {
        row.next_match_id = gf.id;
        row.next_match_slot = 2;
      } else if (r % 2 === 1) {
        // odd -> even: same index, survivor takes slot 1
        row.next_match_id = lb[r + 1][m].id;
        row.next_match_slot = 1;
      } else {
        // even -> odd: pairs merge
        row.next_match_id = lb[r + 1][Math.floor(m / 2)].id;
        row.next_match_slot = m % 2 === 0 ? 1 : 2;
      }
    });
  }

  // WB loser links
  wbRound(1).forEach((row, i) => {
    row.loser_next_match_id = lb[1][Math.floor(i / 2)].id;
    row.loser_next_match_slot = i % 2 === 0 ? 1 : 2;
  });
  for (let j = 2; j <= k; j++) {
    const target = lb[2 * (j - 1)];
    wbRound(j).forEach((row, i) => {
      // reversed order so players don't immediately meet the same opponent again
      row.loser_next_match_id = target[target.length - 1 - i].id;
      row.loser_next_match_slot = 2;
    });
  }

  // Liveness: which LB slots will ever receive a player?
  const all = [...wb, ...lb.flat(), gf];
  const live = new Map<string, [boolean, boolean]>();
  lb.flat().forEach((m) => live.set(m.id, [false, false]));
  const markLive = (targetId: string | null, slot: 1 | 2 | null) => {
    if (!targetId || !slot || !live.has(targetId)) return;
    live.get(targetId)![slot - 1] = true;
  };
  wb.forEach((m) => {
    const producesLoser = m.round_number > 1 || (m.entry1_id !== null && m.entry2_id !== null);
    if (producesLoser) markLive(m.loser_next_match_id, m.loser_next_match_slot);
  });
  for (let r = 1; r <= lbRounds; r++) {
    lb[r].forEach((m) => {
      const [a, b] = live.get(m.id)!;
      if (a && b) return;
      m.status = 'walkover'; // pass-through (one live slot) or dead (none)
      if (a || b) markLive(m.next_match_id, m.next_match_slot);
    });
    // live winners of fully-live matches
    lb[r].forEach((m) => {
      const [a, b] = live.get(m.id)!;
      if (a && b) markLive(m.next_match_id, m.next_match_slot);
    });
  }

  return all;
}

/**
 * Generates circle-method (Berger) Round Robin pairings for a single group so each
 * participant plays at most one match per round_number.
 */
export function buildGroupRoundRobinMatches(
  tournamentId: string,
  stageId: string,
  groupNumber: number,
  groupPlayers: TournamentEntry[],
  idGen: IdGen = defaultIdGen,
  startMatchNumber: number = 1
): MatchRow[] {
  if (groupPlayers.length < 2) return [];

  const list: Array<TournamentEntry | null> = [...groupPlayers];
  if (list.length % 2 === 1) list.push(null);

  const n = list.length;
  const totalRounds = n - 1;
  const half = n / 2;
  const rows: MatchRow[] = [];
  let matchCounter = startMatchNumber;

  for (let r = 0; r < totalRounds; r++) {
    for (let i = 0; i < half; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a && b) {
        // Alternate first/second slot cleanly across rounds
        const first = r % 2 === 1 && i === 0 ? b : a;
        const second = r % 2 === 1 && i === 0 ? a : b;
        rows.push(
          blankRow(idGen, tournamentId, stageId, {
            round_number: r + 1,
            match_number: matchCounter++,
            group_number: groupNumber,
            bracket_type: 'main',
            entry1_id: first.id,
            entry2_id: second.id,
          })
        );
      }
    }

    // Rotate indices 1..n-1 clockwise
    const last = list.pop()!;
    list.splice(1, 0, last);
  }

  return rows;
}

export function buildRoundRobinFromGroups(
  tournamentId: string,
  stageId: string,
  groupsMap: Array<{ groupNumber: number; entries: TournamentEntry[] }>,
  idGen: IdGen = defaultIdGen
): MatchRow[] {
  const rows: MatchRow[] = [];
  const sortedGroups = [...groupsMap].sort((a, b) => a.groupNumber - b.groupNumber);
  sortedGroups.forEach(({ groupNumber, entries }) => {
    const groupRows = buildGroupRoundRobinMatches(
      tournamentId,
      stageId,
      groupNumber,
      entries,
      idGen,
      1
    );
    rows.push(...groupRows);
  });
  return rows;
}

export function buildRoundRobin(
  tournamentId: string,
  stageId: string,
  seededEntries: TournamentEntry[],
  groupCount: number = 2,
  idGen: IdGen = defaultIdGen,
  distribution: 'snake' | 'sequential' = 'snake'
): MatchRow[] {
  const safeGroups = Math.max(1, Math.min(groupCount, Math.floor(seededEntries.length / 2)));
  const groups: TournamentEntry[][] = Array.from({ length: safeGroups }, () => []);

  if (distribution === 'sequential') {
    const baseSize = Math.floor(seededEntries.length / safeGroups);
    const remainder = seededEntries.length % safeGroups;
    let cursor = 0;
    for (let g = 0; g < safeGroups; g++) {
      // Keep earlier groups compact when desired or balanced evenly
      const size = baseSize + (g < remainder ? 1 : 0);
      groups[g] = seededEntries.slice(cursor, cursor + size);
      cursor += size;
    }
  } else {
    // Snake seeding
    seededEntries.forEach((entry, index) => {
      const row = Math.floor(index / safeGroups);
      const posInRow = index % safeGroups;
      const targetGroup = row % 2 === 0 ? posInRow : safeGroups - 1 - posInRow;
      groups[targetGroup].push(entry);
    });
  }

  return buildRoundRobinFromGroups(
    tournamentId,
    stageId,
    groups.map((entries, idx) => ({ groupNumber: idx + 1, entries })),
    idGen
  );
}

/**
 * Swiss pairing for the next round. Players with equal wins are paired first
 * (preserving caller's seeded order on ties so manual/random/Elo seeding works),
 * rematches are avoided when possible, and the BYE goes to the lowest-ranked
 * player who has not had a BYE yet.
 */
export function buildSwissRound(
  tournamentId: string,
  stageId: string,
  entries: TournamentEntry[],
  stageMatches: Pick<Match, 'round_number' | 'entry1_id' | 'entry2_id' | 'winner_entry_id' | 'status'>[],
  idGen: IdGen = defaultIdGen
): MatchRow[] {
  const nextRound = stageMatches.reduce((max, m) => Math.max(max, m.round_number), 0) + 1;

  const wins: Record<string, number> = {};
  const playedAgainst: Record<string, Set<string>> = {};
  const hadBye = new Set<string>();
  const seedOrder = new Map<string, number>();
  entries.forEach((e, idx) => {
    wins[e.id] = 0;
    playedAgainst[e.id] = new Set();
    seedOrder.set(e.id, idx);
  });
  stageMatches.forEach((m) => {
    if (m.winner_entry_id && wins[m.winner_entry_id] !== undefined) wins[m.winner_entry_id] += 1;
    if (m.entry1_id && m.entry2_id) {
      playedAgainst[m.entry1_id]?.add(m.entry2_id);
      playedAgainst[m.entry2_id]?.add(m.entry1_id);
    } else if (m.status === 'walkover') {
      const solo = m.entry1_id || m.entry2_id;
      if (solo) hadBye.add(solo);
    }
  });

  let pool = [...entries].sort(
    (a, b) => wins[b.id] - wins[a.id] || (seedOrder.get(a.id) ?? 0) - (seedOrder.get(b.id) ?? 0)
  );
  const rows: MatchRow[] = [];
  let matchNum = 1;

  let byeEntry: TournamentEntry | null = null;
  if (pool.length % 2 === 1) {
    byeEntry = [...pool].reverse().find((e) => !hadBye.has(e.id)) || pool[pool.length - 1];
    pool = pool.filter((e) => e.id !== byeEntry!.id);
  }

  const paired = new Set<string>();
  for (let i = 0; i < pool.length; i++) {
    const p1 = pool[i];
    if (paired.has(p1.id)) continue;
    let partner = pool.slice(i + 1).find((c) => !paired.has(c.id) && !playedAgainst[p1.id]?.has(c.id));
    if (!partner) partner = pool.slice(i + 1).find((c) => !paired.has(c.id));
    if (!partner) continue;
    paired.add(p1.id);
    paired.add(partner.id);
    rows.push(
      blankRow(idGen, tournamentId, stageId, {
        round_number: nextRound,
        match_number: matchNum++,
        group_number: 1,
        bracket_type: 'main',
        entry1_id: p1.id,
        entry2_id: partner.id,
      })
    );
  }

  if (byeEntry) {
    rows.push(
      blankRow(idGen, tournamentId, stageId, {
        round_number: nextRound,
        match_number: matchNum++,
        group_number: 1,
        bracket_type: 'main',
        entry1_id: byeEntry.id,
        entry1_score: 1,
        winner_entry_id: byeEntry.id,
        status: 'walkover',
      })
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Integrity checks (used by tests AND shown to the jury as a warning banner)
// ---------------------------------------------------------------------------

export interface IntegrityIssue {
  kind: 'duplicate_match' | 'self_match' | 'entry_twice_in_round' | 'entry_in_two_live_matches';
  message: string;
  matchIds: string[];
}

type CheckableMatch = Pick<
  Match,
  | 'id'
  | 'round_number'
  | 'match_number'
  | 'group_number'
  | 'bracket_type'
  | 'entry1_id'
  | 'entry2_id'
  | 'status'
>;

export function findStageIntegrityIssues(
  matches: CheckableMatch[],
  format: StageFormat
): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const isElimination = format === 'single_elimination' || format === 'double_elimination';

  // 1. Same structural slot exists more than once -> draw generated twice
  const slots = new Map<string, CheckableMatch[]>();
  matches.forEach((m) => {
    const key = `${m.bracket_type}|${m.round_number}|${m.group_number ?? 0}|${m.match_number}`;
    slots.set(key, [...(slots.get(key) || []), m]);
  });
  slots.forEach((list) => {
    if (list.length > 1) {
      const m = list[0];
      issues.push({
        kind: 'duplicate_match',
        message: `Матч #${m.match_number} (раунд ${m.round_number}, ${m.bracket_type}) существует ${list.length} раза / exists ${list.length} times`,
        matchIds: list.map((x) => x.id),
      });
    }
  });

  // 2. Player vs. themselves
  matches.forEach((m) => {
    if (m.entry1_id && m.entry1_id === m.entry2_id) {
      issues.push({
        kind: 'self_match',
        message: `Матч #${m.match_number} (раунд ${m.round_number}): игрок против самого себя / player vs. themselves`,
        matchIds: [m.id],
      });
    }
  });

  // 3. Same entry twice in the same round (elimination & swiss)
  if (isElimination || format === 'swiss') {
    const perRound = new Map<string, Map<string, string[]>>();
    matches.forEach((m) => {
      const rk = `${m.bracket_type}|${m.round_number}`;
      if (!perRound.has(rk)) perRound.set(rk, new Map());
      const bucket = perRound.get(rk)!;
      [m.entry1_id, m.entry2_id].forEach((e) => {
        if (!e) return;
        bucket.set(e, [...(bucket.get(e) || []), m.id]);
      });
    });
    perRound.forEach((bucket, rk) => {
      bucket.forEach((ids, entryId) => {
        const unique = Array.from(new Set(ids));
        if (unique.length > 1) {
          issues.push({
            kind: 'entry_twice_in_round',
            message: `Участник ${entryId.slice(0, 8)} стоит в ${unique.length} матчах одного раунда (${rk}) / in ${unique.length} matches of the same round`,
            matchIds: unique,
          });
        }
      });
    });
  }

  // 4. Elimination: an entry can only be in ONE unfinished match at a time
  if (isElimination) {
    const liveByEntry = new Map<string, string[]>();
    matches
      .filter((m) => m.status === 'scheduled' || m.status === 'in_progress')
      .forEach((m) => {
        [m.entry1_id, m.entry2_id].forEach((e) => {
          if (!e) return;
          liveByEntry.set(e, [...(liveByEntry.get(e) || []), m.id]);
        });
      });
    liveByEntry.forEach((ids, entryId) => {
      const unique = Array.from(new Set(ids));
      if (unique.length > 1) {
        issues.push({
          kind: 'entry_in_two_live_matches',
          message: `Участник ${entryId.slice(0, 8)} одновременно в ${unique.length} несыгранных матчах / in ${unique.length} unplayed matches at once`,
          matchIds: unique,
        });
      }
    });
  }

  return issues;
}
