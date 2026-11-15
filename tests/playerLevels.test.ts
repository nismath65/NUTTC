import { describe, expect, it } from 'vitest';
import {
  getInitialEloForLevel,
  parseCsvParticipantLine,
  parsePlayerCategory,
  parseSkillLevel,
  SKILL_LEVEL_ELO,
} from '@/lib/playerLevels';
import { buildSingleElimination, buildRoundRobin } from '@/lib/bracketBuilder';
import type { TournamentEntry } from '@/types/database';

describe('playerLevels & CSV participant parsing', () => {
  it('maps the 4 skill levels to 800 / 1000 / 1200 / 1400 Elo', () => {
    expect(SKILL_LEVEL_ELO).toEqual({
      beginner: 800,
      amateur: 1000,
      intermediate: 1200,
      advanced: 1400,
    });
    expect(getInitialEloForLevel('beginner')).toBe(800);
    expect(getInitialEloForLevel('amateur')).toBe(1000);
    expect(getInitialEloForLevel('intermediate')).toBe(1200);
    expect(getInitialEloForLevel('advanced')).toBe(1400);
  });

  it('parses bilingual English and Russian skill level labels safely', () => {
    expect(parseSkillLevel('beginner')).toBe('beginner');
    expect(parseSkillLevel('Новичок (800)')).toBe('beginner');
    expect(parseSkillLevel('amateur')).toBe('amateur');
    expect(parseSkillLevel('Любитель')).toBe('amateur');
    expect(parseSkillLevel('Intermediate')).toBe('intermediate');
    expect(parseSkillLevel('Средний уровень')).toBe('intermediate');
    expect(parseSkillLevel('ADVANCED')).toBe('advanced');
    expect(parseSkillLevel('Продвинутый')).toBe('advanced');
    expect(parseSkillLevel('Pro')).toBe('advanced');
    // "professor" contains "pro" as prefix, must not misclassify as advanced level
    expect(parseSkillLevel('professor')).toBeNull();
    expect(parsePlayerCategory('professor')).toBe('professor');
  });

  it('parses standard 4-column Google Forms CSV lines and assigns initial Elo', () => {
    expect(parseCsvParticipantLine('Alikhan Bokeikhanov, 20230001, student, intermediate')).toEqual({
      fullName: 'Alikhan Bokeikhanov',
      universityId: '20230001',
      category: 'student',
      skillLevel: 'intermediate',
      initialElo: 1200,
    });

    expect(parseCsvParticipantLine('Akhmet Baitursynov, , professor, advanced')).toEqual({
      fullName: 'Akhmet Baitursynov',
      universityId: null,
      category: 'professor',
      skillLevel: 'advanced',
      initialElo: 1400,
    });

    expect(parseCsvParticipantLine('Mirzhakyp Dulatov, 20240012, student, beginner')).toEqual({
      fullName: 'Mirzhakyp Dulatov',
      universityId: '20240012',
      category: 'student',
      skillLevel: 'beginner',
      initialElo: 800,
    });
  });

  it('handles 3-column CSV (missing level or omitted category), quotes, semicolons, timestamps, and headers', () => {
    // 3 columns without level defaults to amateur (1000)
    expect(parseCsvParticipantLine('Amina Kim, 20230055, staff')).toEqual({
      fullName: 'Amina Kim',
      universityId: '20230055',
      category: 'staff',
      skillLevel: 'amateur',
      initialElo: 1000,
    });

    // 3 columns where col 3 is directly a level
    expect(parseCsvParticipantLine('Timur Ali, 20230099, advanced')).toEqual({
      fullName: 'Timur Ali',
      universityId: '20230099',
      category: 'student',
      skillLevel: 'advanced',
      initialElo: 1400,
    });

    // Quoted name with comma
    expect(parseCsvParticipantLine('"Suleimenov, Timur", 20231111, student, beginner')).toEqual({
      fullName: 'Suleimenov, Timur',
      universityId: '20231111',
      category: 'student',
      skillLevel: 'beginner',
      initialElo: 800,
    });

    // Semicolon-separated Excel RU export
    expect(parseCsvParticipantLine('Данияр К.; 20232222; студент; продвинутый')).toEqual({
      fullName: 'Данияр К.',
      universityId: '20232222',
      category: 'student',
      skillLevel: 'advanced',
      initialElo: 1400,
    });

    // Leading Google Forms Timestamp column
    expect(
      parseCsvParticipantLine('2026/11/15 14:30:05, Dana Omarova, 20234444, guest, intermediate')
    ).toEqual({
      fullName: 'Dana Omarova',
      universityId: '20234444',
      category: 'guest',
      skillLevel: 'intermediate',
      initialElo: 1200,
    });

    // Header rows ignored safely
    expect(parseCsvParticipantLine('Full Name, University ID, Category, Level')).toBeNull();
    expect(parseCsvParticipantLine('ФИО, University ID, Категория, Уровень')).toBeNull();
    expect(parseCsvParticipantLine('Timestamp, Full Name, University ID, Category')).toBeNull();
  });

  it('skill-based initial Elo drives bracket seeding and Round Robin group balance', () => {
    const levels = ['advanced', 'intermediate', 'amateur', 'beginner'] as const;
    const entries: TournamentEntry[] = levels
      .slice()
      .reverse()
      .map((lvl, idx) => ({
        id: lvl,
        tournament_id: 't1',
        player1_id: `p-${idx}`,
        player2_id: null,
        attendance: 'checked_in',
        seed_elo: getInitialEloForLevel(lvl),
        seed_number: null,
        final_placement: null,
      }));

    // Seed by Elo descending (advanced=1400 -> #1, intermediate=1200 -> #2, amateur=1000 -> #3, beginner=800 -> #4)
    const seeded = [...entries].sort((a, b) => b.seed_elo - a.seed_elo);
    const se = buildSingleElimination('t1', 's1', seeded, false);
    const r1 = se.filter((m) => m.round_number === 1).sort((a, b) => a.match_number - b.match_number);
    // Seed 1 (advanced) vs Seed 4 (beginner), Seed 2 (intermediate) vs Seed 3 (amateur)
    expect(r1[0].entry1_id).toBe('advanced');
    expect(r1[0].entry2_id).toBe('beginner');
    expect(r1[1].entry1_id).toBe('intermediate');
    expect(r1[1].entry2_id).toBe('amateur');

    // Snake seeding into 2 groups: Group 1 gets advanced (#1) + beginner (#4); Group 2 gets intermediate (#2) + amateur (#3)
    const rr = buildRoundRobin('t1', 's1', seeded, 2);
    const g1 = rr.find((m) => m.group_number === 1)!;
    const g2 = rr.find((m) => m.group_number === 2)!;
    expect(new Set([g1.entry1_id, g1.entry2_id])).toEqual(new Set(['advanced', 'beginner']));
    expect(new Set([g2.entry1_id, g2.entry2_id])).toEqual(new Set(['intermediate', 'amateur']));
  });
});
