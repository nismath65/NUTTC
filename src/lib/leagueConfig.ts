import type { StageFormat, TournamentStage } from '@/types/database';

export type UiStageFormat = StageFormat | 'club_league';

export function isLeagueStage(
  stage?: Pick<TournamentStage, 'format' | 'config'> | null
): boolean {
  if (!stage) return false;
  return (
    stage.format === 'round_robin' &&
    Boolean(stage.config && (stage.config as Record<string, unknown>).league_mode === true)
  );
}

export function getUiFormat(
  stage?: Pick<TournamentStage, 'format' | 'config'> | null
): UiStageFormat {
  if (!stage) return 'single_elimination';
  return isLeagueStage(stage) ? 'club_league' : stage.format;
}

export function getDefaultLeagueNames(locale: 'ru' | 'en' = 'en'): Record<string, string> {
  if (locale === 'ru') {
    return {
      '1': 'Суперлига (1-я лига)',
      '2': '2-я лига',
      '3': '3-я лига',
      '4': '4-я лига',
      '5': '5-я лига',
      '6': '6-я лига',
    };
  }
  return {
    '1': 'Super League (1st League)',
    '2': '2nd League',
    '3': '3rd League',
    '4': '4th League',
    '5': '5th League',
    '6': '6th League',
  };
}

export function getGroupDisplayName(
  stage: Pick<TournamentStage, 'format' | 'config'> | null | undefined,
  groupNumber: number,
  locale: 'ru' | 'en'
): string {
  const customNames = (stage?.config?.group_names as Record<string, string> | undefined) || {};
  const explicit = customNames[String(groupNumber)];
  if (explicit && explicit.trim()) return explicit.trim();

  if (isLeagueStage(stage)) {
    if (groupNumber === 1) return locale === 'ru' ? 'Суперлига' : 'Super League';
    if (locale === 'ru') return `${groupNumber}-я лига`;
    const suffix = groupNumber === 2 ? 'nd' : groupNumber === 3 ? 'rd' : 'th';
    return `${groupNumber}${suffix} League`;
  }

  return locale === 'ru' ? `Группа #${groupNumber}` : `Group #${groupNumber}`;
}

export function getStageCustomGroups(
  stage?: Pick<TournamentStage, 'config'> | null
): Record<string, number> {
  const raw = stage?.config?.custom_groups as Record<string, number> | undefined;
  return raw && typeof raw === 'object' ? { ...raw } : {};
}
