import type { PlayerCategory } from '@/types/database';

export type PlayerSkillLevel = 'beginner' | 'amateur' | 'intermediate' | 'advanced';

export const SKILL_LEVEL_ELO: Record<PlayerSkillLevel, number> = {
  beginner: 800,
  amateur: 1000,
  intermediate: 1200,
  advanced: 1400,
};

export const DEFAULT_SKILL_LEVEL: PlayerSkillLevel = 'amateur';

export const SKILL_LEVEL_OPTIONS: PlayerSkillLevel[] = [
  'beginner',
  'amateur',
  'intermediate',
  'advanced',
];

export function getInitialEloForLevel(level: PlayerSkillLevel): number {
  return SKILL_LEVEL_ELO[level] ?? SKILL_LEVEL_ELO[DEFAULT_SKILL_LEVEL];
}

export interface ParsedCsvParticipant {
  fullName: string;
  universityId: string | null;
  category: PlayerCategory;
  skillLevel: PlayerSkillLevel;
  initialElo: number;
}

/**
 * Splits a single CSV line into trimmed fields, supporting quoted values
 * and semicolon-delimited lines (e.g., RU Excel CSV exports).
 */
export function splitCsvLine(line: string): string[] {
  const hasComma = line.includes(',');
  const delimiter = !hasComma && line.includes(';') ? ';' : ',';
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

export function parsePlayerCategory(raw?: string | null): PlayerCategory | null {
  const v = (raw || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'student' || v.includes('студ')) return 'student';
  if (v === 'staff' || v.includes('сотруд')) return 'staff';
  if (v === 'professor' || v === 'prof' || v.includes('професс') || v.includes('препод')) {
    return 'professor';
  }
  if (v === 'guest' || v === 'alumni' || v.includes('гост') || v.includes('выпуск')) {
    return 'guest';
  }
  return null;
}

export function parseSkillLevel(raw?: string | null): PlayerSkillLevel | null {
  const v = (raw || '').trim().toLowerCase();
  if (!v) return null;

  if (
    v.includes('beginner') ||
    v.includes('newbie') ||
    v.includes('novice') ||
    v.includes('нович') ||
    v.includes('начин') ||
    v.includes('начал') ||
    v === '800'
  ) {
    return 'beginner';
  }

  if (v.includes('amateur') || v.includes('casual') || v.includes('любит') || v === '1000') {
    return 'amateur';
  }

  if (
    v.includes('intermediate') ||
    v.includes('middle') ||
    v.includes('medium') ||
    v.includes('средн') ||
    v.includes('уверен') ||
    v.includes('продолж') ||
    v === '1200'
  ) {
    return 'intermediate';
  }

  if (
    v.includes('advanced') ||
    v.includes('experienced') ||
    v.includes('expert') ||
    /\bpro\b/.test(v) ||
    v.includes('продвин') ||
    v.includes('профи') ||
    v.includes('профессионал') ||
    v.includes('высок') ||
    v === '1400'
  ) {
    return 'advanced';
  }

  return null;
}

function isCsvHeaderRow(parts: string[]): boolean {
  const col0 = (parts[0] || '').toLowerCase();
  const rest = parts.slice(1).map((p) => p.toLowerCase());

  if (/^(timestamp|отметка времени)$/.test(col0)) {
    return true;
  }

  const col0LooksHeader = /^(full ?name|name|фио|имя|игрок|participant|участник)$/.test(col0);
  const restHasHeader = rest.some((c) =>
    /^(university ?id|uni ?id|id|category|категория|level|skill ?level|уровень|уровень игры)$/.test(
      c
    )
  );
  return col0LooksHeader && restHasHeader;
}

function looksLikeTimestamp(value: string): boolean {
  return /^\d{1,4}[./-]\d{1,2}[./-]\d{2,4}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.test(value);
}

/**
 * Parses a pasted CSV line into participant registration fields.
 * Expected order:
 *   Full Name, University ID, Category (student/staff/professor/guest), Level (beginner/amateur/intermediate/advanced)
 * Also tolerates Google Forms leading Timestamp column, omitted category (3 cols ending in level),
 * and bilingual RU/EN category or level values.
 */
export function parseCsvParticipantLine(line: string): ParsedCsvParticipant | null {
  const rawParts = splitCsvLine(line);
  if (rawParts.length === 0 || isCsvHeaderRow(rawParts)) {
    return null;
  }

  const parts =
    rawParts.length >= 2 && looksLikeTimestamp(rawParts[0]) ? rawParts.slice(1) : rawParts;

  const fullName = (parts[0] || '').trim();
  if (!fullName) return null;

  const universityId = (parts[1] || '').trim() || null;
  const col2 = parts[2] || '';
  const col3 = parts[3] || '';

  const catFromCol2 = parsePlayerCategory(col2);
  const levelFromCol3 = parseSkillLevel(col3);
  const levelFromCol2 = !catFromCol2 && !col3 ? parseSkillLevel(col2) : null;

  const category: PlayerCategory = catFromCol2 ?? 'student';
  const skillLevel: PlayerSkillLevel = levelFromCol3 ?? levelFromCol2 ?? DEFAULT_SKILL_LEVEL;

  return {
    fullName,
    universityId,
    category,
    skillLevel,
    initialElo: getInitialEloForLevel(skillLevel),
  };
}
