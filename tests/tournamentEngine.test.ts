import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeDb } from './fakeSupabase';

const holder: { db: FakeDb } = { db: new FakeDb() };
vi.mock('@/lib/supabase', () => ({
  supabase: { from: (t: string) => holder.db.from(t) },
}));

import {
  generateStageDraw,
  generateNextSwissRound,
  submitMatchResult,
  undoMatchResult,
  assignEntryToMatchSlot,
  swapTwoEntriesInStage,
  createAndAdvanceToStage2,
  computeStageStandings,
  completeTournamentAndAssignMedals,
} from '@/lib/tournamentEngine';
import {
  buildSingleElimination,
  buildDoubleElimination,
  buildRoundRobin,
  findStageIntegrityIssues,
} from '@/lib/bracketBuilder';
import type { Match, StageFormat, TournamentEntry } from '@/types/database';

// ---------------------------------------------------------------- helpers

/** The unique index from supabase/migrations/…_bracket_integrity.sql */
const MATCH_SLOT_INDEX = (r: Record<string, unknown>) =>
  `${r.stage_id}|${r.bracket_type}|${r.round_number}|${r.group_number ?? 0}|${r.match_number}`;

function makeEntries(n: number): TournamentEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i + 1}`,
    tournament_id: 't1',
    player1_id: `p${i + 1}`,
    player2_id: null,
    attendance: 'checked_in',
    seed_elo: 1500 - i * 10,
    seed_number: null,
    final_placement: null,
  }));
}

function freshDb(n: number, withUniqueIndex = false) {
  holder.db = new FakeDb(
    withUniqueIndex ? { uniqueIndexes: { matches: [MATCH_SLOT_INDEX] } } : {}
  );
  const entries = makeEntries(n);
  holder.db.seed('tournament_entries', entries as never);
  holder.db.seed(
    'players',
    entries.map((e) => ({ id: e.player1_id, elo_rating: 1000, wins: 0, losses: 0 })) as never
  );
  holder.db.seed('tournaments', [{ id: 't1', status: 'check_in' }] as never);
  holder.db.seed('tournament_stages', [{ id: 's1', tournament_id: 't1', status: 'pending' }] as never);
  return entries;
}

const stageMatches = () =>
  (holder.db.table('matches') as unknown as Match[]).filter((m) => m.stage_id === 's1');

function expectClean(format: StageFormat) {
  const issues = findStageIntegrityIssues(stageMatches(), format);
  expect(issues.map((i) => i.message)).toEqual([]);
}

/** Small deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const playable = () =>
  stageMatches().filter(
    (m) =>
      (m.status === 'scheduled' || m.status === 'in_progress') && m.entry1_id && m.entry2_id
  );

/** Plays the whole stage with random winners, checking integrity after every result. */
async function playOut(format: StageFormat, seed: number, bestOf = 3) {
  const rand = rng(seed);
  const win = Math.ceil(bestOf / 2);
  for (let guard = 0; guard < 500; guard++) {
    const ready = playable();
    if (ready.length === 0) return;
    const m = ready[Math.floor(rand() * ready.length)];
    const p1 = rand() < 0.5;
    await submitMatchResult(m, p1 ? win : 0, p1 ? 0 : win, bestOf, true);
    expectClean(format);
  }
  throw new Error('stage never finished');
}

// ---------------------------------------------------------------- 1. the reported bug

describe('reported bug: player in two places / plays themselves in the final', () => {
  it('two overlapping "Generate draw" runs never produce two interleaved brackets (no DB index)', async () => {
    const entries = freshDb(8);
    const results = await Promise.allSettled([
      generateStageDraw('t1', 's1', 'single_elimination', entries),
      generateStageDraw('t1', 's1', 'single_elimination', entries),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const total = stageMatches().length;
    // either exactly one complete bracket (7 main + bronze) or nothing (jury just clicks again)
    expect([0, 8]).toContain(total);
    if (total === 8) expect(ok).toBeGreaterThanOrEqual(1);
    expectClean('single_elimination');
  });

  it('with the DB unique index, exactly one bracket survives and the other run reports it', async () => {
    const entries = freshDb(8, true);
    const results = await Promise.allSettled([
      generateStageDraw('t1', 's1', 'single_elimination', entries),
      generateStageDraw('t1', 's1', 'single_elimination', entries),
    ]);
    expect(stageMatches()).toHaveLength(8);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expectClean('single_elimination');
  });

  it('five rapid clicks still leave one clean bracket', async () => {
    const entries = freshDb(8, true);
    await Promise.allSettled(
      Array.from({ length: 5 }, () => generateStageDraw('t1', 's1', 'single_elimination', entries))
    );
    expect(stageMatches()).toHaveLength(8);
    expectClean('single_elimination');
  });

  it('regenerating a draw replaces the old one instead of adding to it', async () => {
    const entries = freshDb(8);
    await generateStageDraw('t1', 's1', 'single_elimination', entries);
    await generateStageDraw('t1', 's1', 'single_elimination', entries, 2, false, 'random');
    expect(stageMatches()).toHaveLength(8);
    expectClean('single_elimination');
  });

  it('the integrity checker flags exactly the situation from the screenshot', () => {
    const entries = makeEntries(8);
    let n = 0;
    const idGen = () => `x${++n}`;
    const doubled = [
      ...buildSingleElimination('t1', 's1', entries, true, idGen),
      ...buildSingleElimination('t1', 's1', entries, true, idGen),
    ];
    const kinds = new Set(
      findStageIntegrityIssues(doubled as unknown as Match[], 'single_elimination').map(
        (i) => i.kind
      )
    );
    expect(kinds.has('duplicate_match')).toBe(true);
    expect(kinds.has('entry_twice_in_round')).toBe(true);
    expect(kinds.has('entry_in_two_live_matches')).toBe(true);
  });
});

// ---------------------------------------------------------------- 2. structure

describe('single elimination structure', () => {
  for (let n = 2; n <= 33; n++) {
    it(`n=${n}: every player placed once, byes only for top seeds, links valid`, () => {
      const entries = makeEntries(n);
      const rows = buildSingleElimination('t1', 's1', entries, true);
      const rounds = Math.ceil(Math.log2(n));
      const size = 2 ** rounds;
      const main = rows.filter((r) => r.bracket_type === 'main');
      expect(main).toHaveLength(size - 1);
      expect(rows.filter((r) => r.bracket_type === 'third_place')).toHaveLength(n >= 4 ? 1 : 0);

      const r1 = main.filter((r) => r.round_number === 1);
      const placed = r1.flatMap((r) => [r.entry1_id, r.entry2_id]).filter(Boolean);
      expect(new Set(placed).size).toBe(n);
      expect(placed).toHaveLength(n);
      expect(r1.some((r) => !r.entry1_id && !r.entry2_id)).toBe(false);

      const byeWinners = r1.filter((r) => r.status === 'walkover').map((r) => r.winner_entry_id);
      expect(byeWinners).toHaveLength(size - n);
      expect(new Set(byeWinners)).toEqual(new Set(entries.slice(0, size - n).map((e) => e.id)));

      const ids = new Set(rows.map((r) => r.id));
      rows.forEach((r) => {
        if (r.next_match_id) expect(ids.has(r.next_match_id)).toBe(true);
        if (r.loser_next_match_id) expect(ids.has(r.loser_next_match_id)).toBe(true);
      });
      expect(findStageIntegrityIssues(rows as unknown as Match[], 'single_elimination')).toEqual([]);
    });
  }
});

describe('double elimination structure', () => {
  for (let n = 2; n <= 33; n++) {
    it(`n=${n}: every WB match routes its loser, every LB slot is wired`, () => {
      const rows = buildDoubleElimination('t1', 's1', makeEntries(n));
      const wb = rows.filter((r) => r.bracket_type === 'main');
      const gf = rows.filter((r) => r.bracket_type === 'grand_final');
      expect(gf).toHaveLength(1);
      // every WB match that is a real match must send its loser somewhere
      wb.filter((r) => r.status !== 'walkover').forEach((r) =>
        expect(r.loser_next_match_id).not.toBeNull()
      );
      // no LB match receives more than 2 feeders
      const feeds = new Map<string, number>();
      rows.forEach((r) => {
        [r.next_match_id, r.loser_next_match_id].forEach((t) => {
          if (t) feeds.set(t, (feeds.get(t) || 0) + 1);
        });
      });
      rows
        .filter((r) => r.bracket_type === 'losers')
        .forEach((r) => expect(feeds.get(r.id) || 0).toBe(2));
    });
  }
});

describe('round robin structure', () => {
  it('each group plays all-play-all, every player in exactly one group', () => {
    const rows = buildRoundRobin('t1', 's1', makeEntries(10), 3);
    const groups = new Map<number, Set<string>>();
    rows.forEach((r) => {
      const g = groups.get(r.group_number!) || new Set();
      g.add(r.entry1_id!);
      g.add(r.entry2_id!);
      groups.set(r.group_number!, g);
    });
    const sizes = [...groups.values()].map((g) => g.size);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(10);
    const expected = sizes.reduce((a, s) => a + (s * (s - 1)) / 2, 0);
    expect(rows).toHaveLength(expected);
  });
});

// ---------------------------------------------------------------- 3. full simulations

describe('full tournament simulations (random results, integrity checked after every match)', () => {
  for (let n = 2; n <= 20; n++) {
    it(`single elimination, ${n} players`, async () => {
      const entries = freshDb(n);
      await generateStageDraw('t1', 's1', 'single_elimination', entries);
      await playOut('single_elimination', n * 7);

      const main = stageMatches().filter((m) => m.bracket_type === 'main');
      const final = main.find((m) => m.round_number === Math.max(...main.map((x) => x.round_number)))!;
      expect(final.status === 'completed' || final.status === 'walkover').toBe(true);
      expect(final.entry1_id).not.toBe(final.entry2_id);

      // every player loses at most once, exactly one player never loses
      const losses = new Map<string, number>();
      stageMatches()
        .filter((m) => m.status === 'completed' && m.bracket_type === 'main')
        .forEach((m) => {
          const loser = m.winner_entry_id === m.entry1_id ? m.entry2_id! : m.entry1_id!;
          losses.set(loser, (losses.get(loser) || 0) + 1);
        });
      expect([...losses.values()].every((v) => v === 1)).toBe(true);
      expect(losses.size).toBe(n - 1);

      if (n >= 4) {
        const bronze = stageMatches().find((m) => m.bracket_type === 'third_place')!;
        expect(bronze.status).toBe('completed');
      }

      await completeTournamentAndAssignMedals('t1', stageMatches(), 'single_elimination', entries);
      const medals = (holder.db.table('tournament_entries') as unknown as TournamentEntry[])
        .filter((e) => e.final_placement)
        .map((e) => e.id);
      expect(new Set(medals).size).toBe(medals.length);
    });
  }

  for (let n = 2; n <= 20; n++) {
    it(`double elimination, ${n} players`, async () => {
      const entries = freshDb(n);
      await generateStageDraw('t1', 's1', 'double_elimination', entries);
      await playOut('double_elimination', n * 13);

      // nothing is stuck: no scheduled match is left behind
      const stuck = stageMatches().filter((m) => m.status === 'scheduled');
      expect(stuck).toEqual([]);

      const gf = stageMatches().find((m) => m.bracket_type === 'grand_final')!;
      expect(gf.status).toBe('completed');
      expect(gf.entry1_id).not.toBe(gf.entry2_id);

      // nobody loses more than twice, everybody except the champion is out
      const losses = new Map<string, number>();
      stageMatches()
        .filter((m) => m.status === 'completed')
        .forEach((m) => {
          const loser = m.winner_entry_id === m.entry1_id ? m.entry2_id! : m.entry1_id!;
          losses.set(loser, (losses.get(loser) || 0) + 1);
        });
      expect([...losses.values()].every((v) => v <= 2)).toBe(true);
      expect(losses.has(gf.winner_entry_id!) ? losses.get(gf.winner_entry_id!) : 0).toBeLessThanOrEqual(1);
      const eliminated = entries.filter((e) => e.id !== gf.winner_entry_id);
      eliminated.forEach((e) => {
        const l = losses.get(e.id) || 0;
        const lostGf = gf.winner_entry_id !== e.id && (gf.entry1_id === e.id || gf.entry2_id === e.id);
        expect(l === 2 || lostGf).toBe(true);
      });
    });
  }

  it('swiss, 7 players, 4 rounds: no repeat byes, no duplicated rounds', async () => {
    const entries = freshDb(7);
    await generateStageDraw('t1', 's1', 'swiss', entries);
    for (let r = 1; r <= 4; r++) {
      await playOut('swiss', r);
      if (r < 4) await generateNextSwissRound('t1', 's1', entries, []);
    }
    const byes = stageMatches()
      .filter((m) => m.status === 'walkover')
      .map((m) => m.entry1_id);
    expect(byes).toHaveLength(4);
    expect(new Set(byes).size).toBe(4);
    expectClean('swiss');
  });
});

// ---------------------------------------------------------------- 4. double clicks & jury edits

describe('jury actions under double clicks and corrections', () => {
  beforeEach(() => undefined);

  const r1 = () =>
    stageMatches()
      .filter((m) => m.bracket_type === 'main' && m.round_number === 1)
      .sort((a, b) => a.match_number - b.match_number);

  it('double-clicking a winner records the result and Elo only once', async () => {
    const entries = freshDb(8);
    await generateStageDraw('t1', 's1', 'single_elimination', entries);
    const m = r1()[0];
    const res = await Promise.allSettled([
      submitMatchResult(m, 2, 0, 3, true),
      submitMatchResult(m, 2, 0, 3, true),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(holder.db.table('rating_logs')).toHaveLength(2);
    expectClean('single_elimination');
  });

  it('double-clicking undo reverts Elo only once', async () => {
    const entries = freshDb(8);
    await generateStageDraw('t1', 's1', 'single_elimination', entries);
    const m = r1()[0];
    await submitMatchResult(m, 2, 0, 3, true);
    await Promise.allSettled([undoMatchResult(m), undoMatchResult(m)]);
    const players = holder.db.table('players') as { elo_rating: number; wins: number }[];
    players.forEach((p) => {
      expect(p.elo_rating).toBe(1000);
      expect(p.wins).toBe(0);
    });
    expectClean('single_elimination');
  });

  it('undo is refused once the next match has been played', async () => {
    const entries = freshDb(4);
    await generateStageDraw('t1', 's1', 'single_elimination', entries);
    const [a, b] = r1();
    await submitMatchResult(a, 2, 0, 3, true);
    await submitMatchResult(b, 2, 0, 3, true);
    const final = stageMatches().find((m) => m.bracket_type === 'main' && m.round_number === 2)!;
    await submitMatchResult(final, 2, 1, 3, true);
    await expect(undoMatchResult(a)).rejects.toThrow(/Undo the following match first/);
    expectClean('single_elimination');
  });

  it('changing the winner of a finished match moves the new winner on and redoes Elo', async () => {
    const entries = freshDb(4);
    await generateStageDraw('t1', 's1', 'single_elimination', entries);
    const a = r1()[0];
    await submitMatchResult(a, 2, 0, 3, true);
    await submitMatchResult(a, 0, 2, 3, true);
    const final = stageMatches().find((m) => m.bracket_type === 'main' && m.round_number === 2)!;
    expect([final.entry1_id, final.entry2_id]).toContain(a.entry2_id);
    expect([final.entry1_id, final.entry2_id]).not.toContain(a.entry1_id);
    const logs = holder.db.table('rating_logs') as { player_id: string; reason: string }[];
    expect(logs).toHaveLength(2);
    expectClean('single_elimination');
  });

  it('manual slot edit: picking a player who is already placed swaps them instead of duplicating', async () => {
    const entries = freshDb(8);
    await generateStageDraw('t1', 's1', 'single_elimination', entries);
    const [m1, m2] = r1();
    const moving = m2.entry1_id!;
    const displaced = m1.entry1_id!;
    await assignEntryToMatchSlot(m1, 1, moving);
    const [n1, n2] = r1();
    expect(n1.entry1_id).toBe(moving);
    expect(n2.entry1_id).toBe(displaced);
    expectClean('single_elimination');
  });

  it('swiss: double-clicking "next round" never creates the round twice', async () => {
    const entries = freshDb(6, true);
    await generateStageDraw('t1', 's1', 'swiss', entries);
    await playOut('swiss', 3);
    await Promise.allSettled([
      generateNextSwissRound('t1', 's1', entries, []),
      generateNextSwissRound('t1', 's1', entries, []),
    ]);
    expect(stageMatches().filter((m) => m.round_number === 2)).toHaveLength(3);
    expectClean('swiss');
  });

  it('manual slot edit updates Round 2 automatically when turning a Round 1 match into a BYE and back', async () => {
    const entries = freshDb(3);
    await generateStageDraw('t1', 's1', 'single_elimination', entries);
    const [m1, m2] = r1();
    expect(m1.status).toBe('walkover'); // Seed 1 gets BYE
    const finalBefore = stageMatches().find((m) => m.round_number === 2)!;
    expect(finalBefore.entry1_id).toBe(m1.entry1_id);

    // Move m2's player into m1 slot 2 -> m1 is no longer a BYE, m2 becomes a BYE!
    const movedPlayer = m2.entry2_id!;
    await assignEntryToMatchSlot(m1, 2, movedPlayer);
    const [n1, n2] = r1();
    expect(n1.status).toBe('scheduled');
    expect(n1.winner_entry_id).toBeNull();
    expect(n2.status).toBe('walkover');
    expect(n2.winner_entry_id).toBe(m2.entry1_id);

    const finalAfter = stageMatches().find((m) => m.round_number === 2)!;
    expect(finalAfter.entry1_id).toBeNull();
    expect(finalAfter.entry2_id).toBe(m2.entry1_id);
    expectClean('single_elimination');
  });

  it('swapTwoEntriesInStage swaps unplayed matches cleanly and refuses once a match is completed', async () => {
    const entries = freshDb(4);
    await generateStageDraw('t1', 's1', 'single_elimination', entries);
    const [m1, m2] = r1();
    const pA = m1.entry1_id!;
    const pB = m2.entry1_id!;

    await swapTwoEntriesInStage('s1', pA, pB);
    const [after1, after2] = r1();
    expect(after1.entry1_id).toBe(pB);
    expect(after2.entry1_id).toBe(pA);
    expectClean('single_elimination');

    await submitMatchResult(after1, 2, 0, 3, true);
    await expect(swapTwoEntriesInStage('s1', pB, after2.entry2_id!)).rejects.toThrow(
      /already played/
    );
  });

  it('round robin: standings, score correction without duplicating Elo, and undo', async () => {
    const entries = freshDb(6);
    await generateStageDraw('t1', 's1', 'round_robin', entries, 2);
    expect(stageMatches()).toHaveLength(6); // 2 groups of 3 -> 3 + 3 matches
    expectClean('round_robin');

    const g1Match = stageMatches().find((m) => m.group_number === 1)!;
    await submitMatchResult(g1Match, 2, 0, 3, true);
    expect(holder.db.table('rating_logs')).toHaveLength(2);

    // Correct score for same winner (2:0 -> 2:1)
    await submitMatchResult(g1Match, 2, 1, 3, true);
    expect(holder.db.table('rating_logs')).toHaveLength(2);
    const updated = stageMatches().find((m) => m.id === g1Match.id)!;
    expect(updated.entry2_score).toBe(1);

    const standings = computeStageStandings(stageMatches(), entries, false);
    const winnerRow = standings.find((s) => s.entry.id === g1Match.entry1_id)!;
    expect(winnerRow.wins).toBe(1);
    expect(winnerRow.setsWon).toBe(2);
    expect(winnerRow.setsLost).toBe(1);

    await undoMatchResult(updated);
    expect(holder.db.table('rating_logs')).toHaveLength(0);
  });

  it('double elimination: undo retracts both winner and loser (including through LB pass-throughs)', async () => {
    const entries = freshDb(5); // 5 players -> LB has pass-through matches
    await generateStageDraw('t1', 's1', 'double_elimination', entries);
    const wbR1Real = stageMatches().find(
      (m) => m.bracket_type === 'main' && m.round_number === 1 && m.status === 'scheduled'
    )!;
    await submitMatchResult(wbR1Real, 2, 0, 3, true);
    expectClean('double_elimination');

    await undoMatchResult(wbR1Real);
    expectClean('double_elimination');
    const lbActive = stageMatches().filter(
      (m) => m.bracket_type === 'losers' && (m.entry1_id || m.entry2_id)
    );
    expect(lbActive).toHaveLength(0);
  });

  it('stage 2 advancement: concurrent clicks create exactly one Stage 2 and one bracket', async () => {
    const entries = freshDb(6);
    await generateStageDraw('t1', 's1', 'round_robin', entries, 2);
    await playOut('round_robin', 11);
    const standings = computeStageStandings(stageMatches(), entries, false);
    const qualifiers = standings.filter((r) => r.rankInGroup <= 2);

    const res = await Promise.allSettled([
      createAndAdvanceToStage2('t1', qualifiers, 'single_elimination'),
      createAndAdvanceToStage2('t1', qualifiers, 'single_elimination'),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    const stages = holder.db.table('tournament_stages');
    expect(stages).toHaveLength(2);
    const s2Id = (stages[1] as { id: string }).id;
    const s2Matches = (holder.db.table('matches') as unknown as Match[]).filter(
      (m) => m.stage_id === s2Id
    );
    expect(s2Matches).toHaveLength(4); // 4 qualifiers -> 2 semis + final + bronze
    expect(findStageIntegrityIssues(s2Matches, 'single_elimination')).toEqual([]);
  });

  it('manual seeding respects seed_number order', async () => {
    const entries = freshDb(4).map((e, i) => ({ ...e, seed_number: 4 - i }));
    await generateStageDraw('t1', 's1', 'single_elimination', entries, 2, false, 'manual');
    const [m1] = r1();
    // Seed #1 is entries[3] (e4), faces Seed #4 (entries[0] = e1)
    expect(m1.entry1_id).toBe('e4');
    expect(m1.entry2_id).toBe('e1');
  });
});
