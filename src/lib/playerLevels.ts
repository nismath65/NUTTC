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
  skillLevelDeclared: boolean;
  initialElo: number;
}

/**
 * Splits a single CSV/TSV line into trimmed fields, supporting quoted values,
 * tab-separated Google Sheets/Excel pastes, comma CSVs, and semicolon EU/RU CSVs.
 */
export function splitCsvLine(line: string): string[] {
  const delimiter = line.includes('\t')
    ? '\t'
    : !line.includes(',') && line.includes(';')
    ? ';'
    : ',';
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
  if (v === 'professor' || v === 'prof' || v.includes('професс') || v.includes('препод') || v.includes('faculty')) {
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
    v.includes('intermediate') ||
    v.includes('middle') ||
    v.includes('medium') ||
    v.includes('средн') ||
    v.includes('уверен') ||
    v.includes('продолж') ||
    v.includes('хорош') ||
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
    v.includes('сильн') ||
    v.includes('мастер') ||
    v.includes('кмс') ||
    v === '1400'
  ) {
    return 'advanced';
  }

  if (
    v.includes('beginner') ||
    v.includes('newbie') ||
    v.includes('novice') ||
    v.includes('starter') ||
    v.includes('elementary') ||
    v.includes('basic') ||
    v.includes('нович') ||
    v.includes('начин') ||
    v.includes('начал') ||
    v.includes('базов') ||
    v.includes('слаб') ||
    v === '800'
  ) {
    return 'beginner';
  }

  if (v.includes('amateur') || v.includes('casual') || v.includes('любит') || v === '1000') {
    return 'amateur';
  }

  return null;
}

interface CsvColumnMap {
  nameIdx: number;
  uniIdIdx: number | null;
  categoryIdx: number | null;
  levelIdx: number | null;
}

function detectHeaderColumnMap(parts: string[]): CsvColumnMap | null {
  const lower = parts.map((p) => p.trim().toLowerCase());

  const findIdx = (patterns: RegExp[]) =>
    lower.findIndex((c) => patterns.some((re) => re.test(c)));

  const nameIdx = findIdx([
    /^(full ?name|player ?name|name|фио|имя|участник|игрок)$/,
    /(full ?name|фио|имя и фамилия|your name|имя участника)/,
  ]);
  const uniIdIdx = findIdx([
    /^(university ?id|uni ?id|student ?id|nu ?id|id)$/,
    /(university ?id|student ?id|id студента|номер ид|айди)/,
  ]);
  const categoryIdx = findIdx([
    /^(category|role|status|категория|статус)$/,
    /(категория|student\/staff|студент\/сотрудник)/,
  ]);
  const levelIdx = findIdx([
    /^(level|skill|skill ?level|tier|rating|уровень|уровень игры|навык)$/,
    /(skill ?level|playing level|уровень|beginner|amateur|intermediate|advanced)/,
  ]);

  const hasTimestamp = /^(timestamp|отметка времени|дата)$/.test(lower[0] || '');
  const matchedOther = [uniIdIdx, categoryIdx, levelIdx].filter((i) => i >= 0).length;

  if (nameIdx >= 0 && (matchedOther > 0 || hasTimestamp || parts.length >= 2)) {
    return {
      nameIdx,
      uniIdIdx: uniIdIdx >= 0 ? uniIdIdx : null,
      categoryIdx: categoryIdx >= 0 ? categoryIdx : null,
      levelIdx: levelIdx >= 0 ? levelIdx : null,
    };
  }

  if (hasTimestamp && parts.length >= 2) {
    // Google Forms header without recognizable name header: assume col 1 is name (skipping email if needed)
    const fallbackNameIdx = lower[1]?.includes('email') || lower[1]?.includes('почт') ? 2 : 1;
    if (fallbackNameIdx < parts.length) {
      return {
        nameIdx: fallbackNameIdx,
        uniIdIdx: uniIdIdx >= 0 ? uniIdIdx : null,
        categoryIdx: categoryIdx >= 0 ? categoryIdx : null,
        levelIdx: levelIdx >= 0 ? levelIdx : null,
      };
    }
  }

  return null;
}

function isCsvHeaderRow(parts: string[]): boolean {
  return detectHeaderColumnMap(parts) !== null;
}

function looksLikeTimestamp(value: string): boolean {
  const v = value.trim();
  return /^\d{1,4}[./-]\d{1,2}[./-]\d{2,4}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM))?(?:\s*(?:GMT|UTC)[+-]\d{1,2}(?::?\d{2})?)?)?$/i.test(
    v
  );
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Parses a single CSV/TSV line into participant registration fields.
 * Supports:
 * - Full Name, University ID, Category, Level
 * - Full Name, University ID, Level
 * - Full Name, Category, Level
 * - Full Name, Level
 * - Leading Google Forms Timestamp and/or Email columns
 * - Bilingual EN/RU category & skill level values
 */
export function parseCsvParticipantLine(
  line: string,
  columnMap?: CsvColumnMap | null
): ParsedCsvParticipant | null {
  const rawParts = splitCsvLine(line);
  if (rawParts.length === 0 || (!columnMap && isCsvHeaderRow(rawParts))) {
    return null;
  }

  if (columnMap) {
    const fullName = (rawParts[columnMap.nameIdx] || '').trim();
    if (!fullName) return null;

    const rawId = columnMap.uniIdIdx !== null ? (rawParts[columnMap.uniIdIdx] || '').trim() : '';
    const rawCat =
      columnMap.categoryIdx !== null ? rawParts[columnMap.categoryIdx] : undefined;
    const rawLvl = columnMap.levelIdx !== null ? rawParts[columnMap.levelIdx] : undefined;

    let detectedCategory = parsePlayerCategory(rawCat);
    let detectedLevel = parseSkillLevel(rawLvl);

    // Fallback scan of remaining cells if level/category weren't explicitly mapped
    if (!detectedLevel || !detectedCategory) {
      rawParts.forEach((cell, idx) => {
        if (idx === columnMap.nameIdx || idx === columnMap.uniIdIdx) return;
        if (!detectedCategory) detectedCategory = parsePlayerCategory(cell);
        if (!detectedLevel) detectedLevel = parseSkillLevel(cell);
      });
    }

    const skillLevel = detectedLevel ?? DEFAULT_SKILL_LEVEL;
    return {
      fullName,
      universityId: rawId || null,
      category: detectedCategory ?? 'student',
      skillLevel,
      skillLevelDeclared: detectedLevel !== null,
      initialElo: getInitialEloForLevel(skillLevel),
    };
  }

  let parts = rawParts;
  if (parts.length >= 2 && looksLikeTimestamp(parts[0])) {
    parts = parts.slice(1);
  }
  if (parts.length >= 2 && looksLikeEmail(parts[0])) {
    parts = parts.slice(1);
  }

  const fullName = (parts[0] || '').trim();
  if (!fullName) return null;

  let universityId: string | null = null;
  let detectedCategory: PlayerCategory | null = null;
  let detectedLevel: PlayerSkillLevel | null = null;

  for (let i = 1; i < parts.length; i++) {
    const cell = (parts[i] || '').trim();
    if (!cell || looksLikeEmail(cell)) continue;

    const cat = parsePlayerCategory(cell);
    if (cat && !detectedCategory) {
      detectedCategory = cat;
      continue;
    }

    const lvl = parseSkillLevel(cell);
    if (lvl && !detectedLevel) {
      detectedLevel = lvl;
      continue;
    }

    if (!universityId) {
      universityId = cell;
    }
  }

  const skillLevel = detectedLevel ?? DEFAULT_SKILL_LEVEL;
  return {
    fullName,
    universityId,
    category: detectedCategory ?? 'student',
    skillLevel,
    skillLevelDeclared: detectedLevel !== null,
    initialElo: getInitialEloForLevel(skillLevel),
  };
}

/**
 * Parses a multi-line pasted CSV/TSV block. Detects an optional header row
 * so column order and extra Google Forms columns are handled reliably.
 */
export function parseCsvParticipantsBatch(text: string): ParsedCsvParticipant[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const firstParts = splitCsvLine(lines[0]);
  const headerMap = detectHeaderColumnMap(firstParts);
  const startIdx = headerMap ? 1 : 0;

  const parsed: ParsedCsvParticipant[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const item = parseCsvParticipantLine(lines[i], headerMap);
    if (item) parsed.push(item);
  }
  return parsed;
}
