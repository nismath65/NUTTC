'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useLanguage } from '@/components/LanguageProvider';
import { useAuth } from '@/components/AuthProvider';
import PlayerPicker from '@/components/PlayerPicker';
import {
  generateStageDraw,
  generateNextSwissRound,
  submitMatchResult,
  undoMatchResult,
  swapTwoEntriesInStage,
  assignEntryToMatchSlot,
  createAndAdvanceToStage2,
  computeStageStandings,
  completeTournamentAndAssignMedals,
  SeedingMode,
} from '@/lib/tournamentEngine';
import {
  Tournament,
  TournamentStage,
  TournamentEntry,
  Player,
  PlayerCategory,
  Match,
  TournamentStatus,
  StageFormat,
  AttendanceStatus,
} from '@/types/database';

const TOTAL_TABLES = 8;

export default function TournamentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { locale, t } = useLanguage();
  const { isStaff } = useAuth();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [stages, setStages] = useState<TournamentStage[]>([]);
  const [activeStageId, setActiveStageId] = useState<string | null>(null);
  const [entries, setEntries] = useState<TournamentEntry[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [allPlayers, setAllPlayers] = useState<Player[]>([]);

  // UI & Jury Mode states
  const [juryViewEnabled, setJuryViewEnabled] = useState(true);
  const isJuryMode = isStaff && juryViewEnabled;

  const [showSidebar, setShowSidebar] = useState(true);
  const [fastTestMode, setFastTestMode] = useState(true);
  const [manualSlotEditMode, setManualSlotEditMode] = useState(false);
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [csvText, setCsvText] = useState('');

  // Seeding & Swap Controls
  const [seedingMode, setSeedingMode] = useState<SeedingMode>('elo');
  const [swapEntryA, setSwapEntryA] = useState<string>('');
  const [swapEntryB, setSwapEntryB] = useState<string>('');

  // Registration state
  const [player1, setPlayer1] = useState<Player | null>(null);
  const [player2, setPlayer2] = useState<Player | null>(null);
  const [checkInImmediately, setCheckInImmediately] = useState(false);
  const [regMessage, setRegMessage] = useState<string | null>(null);

  // Stage & Qualification config
  const [groupCount, setGroupCount] = useState<number>(2);
  const [swissAdvanceCount, setSwissAdvanceCount] = useState<number>(4);
  const [groupAdvanceMap, setGroupAdvanceMap] = useState<Record<number, number>>({
    1: 2,
    2: 2,
    3: 2,
    4: 2,
  });
  const [stage2Format, setStage2Format] = useState<StageFormat>('single_elimination');
  const [engineMsg, setEngineMsg] = useState<string | null>(null);

  const loadTournamentData = useCallback(async () => {
    if (!id) return;

    const { data: tData } = await supabase
      .from('tournaments')
      .select('*')
      .eq('id', id)
      .single();
    if (tData) setTournament(tData as Tournament);

    const { data: sData } = await supabase
      .from('tournament_stages')
      .select('*')
      .eq('tournament_id', id)
      .order('stage_order', { ascending: true });
    const loadedStages = (sData as TournamentStage[]) || [];
    setStages(loadedStages);
    setActiveStageId((prev) =>
      prev && loadedStages.some((s) => s.id === prev)
        ? prev
        : loadedStages[loadedStages.length - 1]?.id || null
    );

    const { data: eData } = await supabase
      .from('tournament_entries')
      .select('*, player1:players!player1_id(*), player2:players!player2_id(*)')
      .eq('tournament_id', id)
      .order('seed_number', { ascending: true, nullsFirst: false })
      .order('seed_elo', { ascending: false });

    const loadedEntries = (eData as TournamentEntry[]) || [];
    setEntries(loadedEntries);

    const entryMap: Record<string, TournamentEntry> = {};
    loadedEntries.forEach((e) => {
      entryMap[e.id] = e;
    });

    const { data: mData } = await supabase
      .from('matches')
      .select('*')
      .eq('tournament_id', id)
      .order('round_number', { ascending: true })
      .order('match_number', { ascending: true });

    if (mData) {
      const enriched: Match[] = (mData as Match[]).map((m) => ({
        ...m,
        entry1: m.entry1_id ? entryMap[m.entry1_id] : null,
        entry2: m.entry2_id ? entryMap[m.entry2_id] : null,
      }));
      setMatches(enriched);
    }

    const { data: pData } = await supabase
      .from('players')
      .select('*')
      .order('full_name', { ascending: true });
    if (pData) setAllPlayers(pData as Player[]);
  }, [id]);

  // Initial load + SUPABASE REALTIME SUBSCRIPTION
  useEffect(() => {
    loadTournamentData();

    if (!id) return;
    const channel = supabase
      .channel(`live-tournament-${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'matches', filter: `tournament_id=eq.${id}` },
        () => loadTournamentData()
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_entries',
          filter: `tournament_id=eq.${id}`,
        },
        () => loadTournamentData()
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_stages',
          filter: `tournament_id=eq.${id}`,
        },
        () => loadTournamentData()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, loadTournamentData]);

  const formatEntryName = (entry?: TournamentEntry | null) => {
    if (!entry) return 'TBD';
    if (entry.player2) {
      return `${entry.player1?.full_name} / ${entry.player2?.full_name}`;
    }
    return entry.player1?.full_name || 'Unknown';
  };

  const getValidScorePairs = (bestOf: number): Array<[number, number]> => {
    const win = Math.ceil(bestOf / 2);
    const pairs: Array<[number, number]> = [];
    for (let loserScore = 0; loserScore < win; loserScore++) {
      pairs.push([win, loserScore]);
    }
    for (let loserScore = win - 1; loserScore >= 0; loserScore--) {
      pairs.push([loserScore, win]);
    }
    return pairs;
  };

  const currentStage = stages.find((s) => s.id === activeStageId) || stages[0];
  const stageMatches = useMemo(
    () => matches.filter((m) => m.stage_id === currentStage?.id),
    [matches, currentStage?.id]
  );
  const checkedInEntries = useMemo(
    () => entries.filter((e) => e.attendance === 'checked_in'),
    [entries]
  );

  const hasPlayedMatchesInStage = stageMatches.some((m) => m.status === 'completed');
  const isStageStructureLocked = hasPlayedMatchesInStage && !fastTestMode;

  const isSwiss = currentStage?.format === 'swiss';
  const isGroupOrSwiss =
    currentStage?.format === 'round_robin' || currentStage?.format === 'swiss';

  const liveStandings = useMemo(() => {
    if (!isGroupOrSwiss) return [];
    return computeStageStandings(stageMatches, entries, Boolean(isSwiss));
  }, [stageMatches, entries, isGroupOrSwiss, isSwiss]);

  const predictedQualifiers = useMemo(() => {
    if (!isGroupOrSwiss) return [];
    if (isSwiss) return liveStandings.slice(0, swissAdvanceCount);
    return liveStandings.filter((row) => {
      const limit = groupAdvanceMap[row.groupNumber] ?? 2;
      return row.rankInGroup <= limit;
    });
  }, [liveStandings, isGroupOrSwiss, isSwiss, swissAdvanceCount, groupAdvanceMap]);

  const qualifiedIdSet = useMemo(
    () => new Set(predictedQualifiers.map((q) => q.entry.id)),
    [predictedQualifiers]
  );

  const medalists = useMemo(
    () =>
      entries
        .filter((e) => e.final_placement && e.final_placement <= 3)
        .sort((a, b) => (a.final_placement || 99) - (b.final_placement || 99)),
    [entries]
  );

  // --- HANDLERS ---
  const handleStatusChange = async (newStatus: TournamentStatus) => {
    if (!tournament) return;
    await supabase.from('tournaments').update({ status: newStatus }).eq('id', tournament.id);
    setTournament({ ...tournament, status: newStatus });
  };

  const handleStageFormatChange = async (stageId: string, newFormat: StageFormat) => {
    if (isStageStructureLocked) return;
    await supabase.from('tournament_stages').update({ format: newFormat }).eq('id', stageId);
    setStages(stages.map((s) => (s.id === stageId ? { ...s, format: newFormat } : s)));
  };

  const handleGenerateDraw = async () => {
    setEngineMsg(null);
    if (!tournament || !currentStage) return;
    try {
      await generateStageDraw(
        tournament.id,
        currentStage.id,
        currentStage.format,
        checkedInEntries,
        groupCount,
        false,
        seedingMode
      );
      setEngineMsg('✓ Сетка сформирована / Draw generated!');
      loadTournamentData();
    } catch (err: unknown) {
      setEngineMsg(err instanceof Error ? err.message : 'Error');
    }
  };

  const handleNextSwissRound = async () => {
    setEngineMsg(null);
    if (!tournament || !currentStage) return;
    try {
      await generateNextSwissRound(tournament.id, currentStage.id, checkedInEntries, matches);
      loadTournamentData();
    } catch (err: unknown) {
      setEngineMsg(err instanceof Error ? err.message : 'Error');
    }
  };

  const handleQuickResult = async (match: Match, s1: number, s2: number) => {
    setEngineMsg(null);
    if (!tournament || !isJuryMode) return;
    if (!fastTestMode && match.status !== 'in_progress' && match.status !== 'completed') {
      setEngineMsg(t.TournamentDetail.safeModeHint);
      return;
    }
    try {
      await submitMatchResult(match, s1, s2, tournament.best_of, tournament.is_rated);
      loadTournamentData();
    } catch (err: unknown) {
      setEngineMsg(err instanceof Error ? err.message : 'Error');
    }
  };

  const handleUndoMatch = async (match: Match) => {
    setEngineMsg(null);
    try {
      await undoMatchResult(match);
      setEngineMsg('↺ Результат матча отменён / Match result undone');
      loadTournamentData();
    } catch (err: unknown) {
      setEngineMsg(err instanceof Error ? err.message : 'Error undoing match');
    }
  };

  const handleSwapPlayers = async () => {
    if (!currentStage || !swapEntryA || !swapEntryB || swapEntryA === swapEntryB) return;
    await swapTwoEntriesInStage(currentStage.id, swapEntryA, swapEntryB);
    setEngineMsg('⇄ Игроки поменялись местами / Players swapped!');
    setSwapEntryA('');
    setSwapEntryB('');
    loadTournamentData();
  };

  const handleDirectSlotAssign = async (match: Match, slot: 1 | 2, newEntryId: string) => {
    await assignEntryToMatchSlot(match, slot, newEntryId || null);
    loadTournamentData();
  };

  const handleSeedNumberChange = async (entryId: string, newSeed: number) => {
    await supabase
      .from('tournament_entries')
      .update({ seed_number: newSeed })
      .eq('id', entryId);
    setEntries(entries.map((e) => (e.id === entryId ? { ...e, seed_number: newSeed } : e)));
  };

  const handleAssignTable = async (matchId: string, tableNum: number | null) => {
    await supabase
      .from('matches')
      .update({
        table_number: tableNum,
        status: tableNum ? 'in_progress' : 'scheduled',
      })
      .eq('id', matchId);
    loadTournamentData();
  };

  const handleAdvanceToStage2 = async () => {
    setEngineMsg(null);
    if (!tournament) return;
    try {
      const s2Id = await createAndAdvanceToStage2(
        tournament.id,
        predictedQualifiers,
        stage2Format
      );
      setActiveStageId(s2Id);
      loadTournamentData();
    } catch (err: unknown) {
      setEngineMsg(err instanceof Error ? err.message : 'Error');
    }
  };

  const handleCompleteTournament = async () => {
    if (!tournament || !currentStage) return;
    try {
      await completeTournamentAndAssignMedals(
        tournament.id,
        stageMatches,
        currentStage.format,
        entries
      );
      setEngineMsg('🏆 Турнир завершён, медали вручены!');
      loadTournamentData();
    } catch (err: unknown) {
      setEngineMsg(err instanceof Error ? err.message : 'Error');
    }
  };

  // --- EXPORT TOURNAMENT REPORT TO EXCEL CSV ---
  const handleExportCsv = () => {
    if (!tournament) return;
    const rows: string[][] = [
      ['Tournament', tournament.title],
      ['Date', new Date(tournament.event_date).toLocaleDateString('ru-RU')],
      [],
      ['Placement', 'Participant', 'University ID', 'Seed Elo', 'Attendance'],
    ];

    entries.forEach((e) => {
      rows.push([
        e.final_placement ? String(e.final_placement) : '',
        formatEntryName(e),
        e.player1?.university_id || '',
        String(e.seed_elo),
        e.attendance,
      ]);
    });

    rows.push([]);
    rows.push(['Round', 'Match #', 'Player 1', 'Score 1', 'Score 2', 'Player 2', 'Status']);
    matches.forEach((m) => {
      rows.push([
        String(m.round_number),
        String(m.match_number),
        formatEntryName(m.entry1),
        String(m.entry1_score),
        String(m.entry2_score),
        formatEntryName(m.entry2),
        m.status,
      ]);
    });

    const csvContent =
      '\uFEFF' +
      rows.map((r) => r.map((cell) => `"${(cell || '').replace(/"/g, '""')}"`).join(',')).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${tournament.title.replace(/\s+/g, '_')}_results.csv`;
    link.click();
  };

  // --- GOOGLE FORMS CSV IMPORT ---
  const handleCsvImport = async () => {
    if (!tournament || !csvText.trim()) return;
    const lines = csvText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    let importedCount = 0;
    for (const line of lines) {
      const parts = line.split(',').map((p) => p.trim());
      const name = parts[0];
      const uniId = parts[1] || null;
      const rawCat = (parts[2] || 'student').toLowerCase();
      const cat: PlayerCategory =
        rawCat === 'professor' || rawCat === 'staff' || rawCat === 'guest'
          ? (rawCat as PlayerCategory)
          : 'student';

      if (!name) continue;

      let playerRecord = allPlayers.find(
        (p) =>
          (uniId && p.university_id === uniId) ||
          p.full_name.toLowerCase() === name.toLowerCase()
      );

      if (!playerRecord) {
        const { data: created } = await supabase
          .from('players')
          .insert({
            full_name: name,
            university_id: uniId,
            category: cat,
            elo_rating: 1000,
          })
          .select()
          .single();
        if (created) playerRecord = created as Player;
      }

      if (playerRecord) {
        const { error } = await supabase.from('tournament_entries').insert({
          tournament_id: tournament.id,
          player1_id: playerRecord.id,
          attendance: 'registered',
          seed_elo: playerRecord.elo_rating,
        });
        if (!error) importedCount++;
      }
    }

    setCsvText('');
    setShowCsvImport(false);
    setRegMessage(`✓ Импортировано из CSV: ${importedCount}`);
    loadTournamentData();
  };

  const handleRegisterEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegMessage(null);
    if (!tournament || !player1) return;
    if (tournament.type === 'doubles' && !player2) return;
    if (tournament.type === 'doubles' && player1.id === player2?.id) return;

    const seedElo =
      tournament.type === 'doubles' && player2
        ? Math.round((player1.elo_rating + player2.elo_rating) / 2)
        : player1.elo_rating;

    const { error } = await supabase.from('tournament_entries').insert({
      tournament_id: tournament.id,
      player1_id: player1.id,
      player2_id: tournament.type === 'doubles' && player2 ? player2.id : null,
      attendance: isJuryMode && checkInImmediately ? 'checked_in' : 'registered',
      seed_elo: seedElo,
    });

    if (error) {
      setRegMessage(`Ошибка: ${error.message}`);
      return;
    }
    setPlayer1(null);
    setPlayer2(null);
    setRegMessage('✓ OK!');
    loadTournamentData();
  };

  const handleAttendanceChange = async (entryId: string, status: AttendanceStatus) => {
    await supabase.from('tournament_entries').update({ attendance: status }).eq('id', entryId);
    setEntries(entries.map((e) => (e.id === entryId ? { ...e, attendance: status } : e)));
  };

  const handleDeleteEntry = async (entryId: string) => {
    await supabase.from('tournament_entries').delete().eq('id', entryId);
    setEntries(entries.filter((e) => e.id !== entryId));
  };

  if (!tournament) {
    return <div className="max-w-7xl mx-auto p-6 text-gray-500">Loading...</div>;
  }

  const setsToWin = Math.ceil(tournament.best_of / 2);
  const validScorePairs = getValidScorePairs(tournament.best_of);

  // 8 Tables & Call Queue
  const busyEntryIds = new Set<string>();
  matches
    .filter((m) => m.status === 'in_progress' && m.table_number)
    .forEach((m) => {
      if (m.entry1_id) busyEntryIds.add(m.entry1_id);
      if (m.entry2_id) busyEntryIds.add(m.entry2_id);
    });

  const occupiedTables = new Map<number, Match>();
  matches
    .filter((m) => m.status === 'in_progress' && m.table_number)
    .forEach((m) => {
      if (m.table_number) occupiedTables.set(m.table_number, m);
    });

  const freeTableNumbers = Array.from({ length: TOTAL_TABLES }, (_, i) => i + 1).filter(
    (num) => !occupiedTables.has(num)
  );

  const readyQueue = stageMatches.filter(
    (m) =>
      m.status === 'scheduled' &&
      m.entry1_id &&
      m.entry2_id &&
      !busyEntryIds.has(m.entry1_id) &&
      !busyEntryIds.has(m.entry2_id)
  );

  const distinctGroups = Array.from(
    new Set(stageMatches.map((m) => m.group_number || 1))
  ).sort((a, b) => a - b);

  // Visual Bracket Renderer (Now with Direct Slot Placement Dropdown & Undo!)
  const renderBracketTree = (bracketMatches: Match[], title: string) => {
    const rounds = Array.from(new Set(bracketMatches.map((m) => m.round_number))).sort(
      (a, b) => a - b
    );
    if (rounds.length === 0) return null;

    return (
      <div className="space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">{title}</h3>
        <div className="flex gap-6 overflow-x-auto pb-4 items-stretch">
          {rounds.map((rNum, rIdx) => {
            const rMatches = bracketMatches.filter((m) => m.round_number === rNum);
            const isLastRound = rIdx === rounds.length - 1;
            return (
              <div key={rNum} className="min-w-[250px] flex flex-col justify-around gap-4">
                <div className="text-xs font-bold uppercase text-center text-gray-500 bg-gray-100 py-1 rounded">
                  {isLastRound && bracketMatches[0]?.bracket_type === 'main'
                    ? t.TournamentDetail.finalRound
                    : `${t.TournamentDetail.round} ${rNum}`}
                </div>

                <div className="flex flex-col justify-around flex-1 gap-5">
                  {rMatches.map((m) => {
                    const p1Won = m.winner_entry_id && m.winner_entry_id === m.entry1_id;
                    const p2Won = m.winner_entry_id && m.winner_entry_id === m.entry2_id;
                    const bothPresent = Boolean(m.entry1_id && m.entry2_id);
                    const canScore =
                      isJuryMode &&
                      bothPresent &&
                      (fastTestMode || m.status === 'in_progress' || m.status === 'completed');

                    return (
                      <div
                        key={m.id}
                        className={`border-2 rounded-lg bg-white shadow-xs overflow-hidden transition ${
                          m.status === 'in_progress'
                            ? 'border-blue-500 ring-2 ring-blue-100'
                            : m.status === 'completed'
                            ? 'border-green-300'
                            : 'border-gray-200'
                        }`}
                      >
                        <div className="bg-gray-50 px-2.5 py-1 text-[11px] text-gray-500 flex justify-between items-center border-b">
                          <span>#{m.match_number}</span>
                          {m.table_number ? (
                            <span className="font-bold text-blue-600">
                              🏓 {t.TournamentDetail.table} #{m.table_number}
                            </span>
                          ) : bothPresent && m.status === 'scheduled' && !fastTestMode ? (
                            <span className="text-[10px] text-amber-600">
                              {t.TournamentDetail.waitingTable}
                            </span>
                          ) : null}
                          {m.status === 'walkover' && <span>BYE</span>}
                          {isJuryMode && m.status === 'completed' && (
                            <button
                              type="button"
                              onClick={() => handleUndoMatch(m)}
                              className="text-[10px] text-red-600 font-semibold hover:underline"
                            >
                              ↺ Undo
                            </button>
                          )}
                        </div>

                        {/* MANUAL SLOT PLACEMENT MODE VS NORMAL WINNER CLICK */}
                        {isJuryMode && manualSlotEditMode && m.status !== 'completed' ? (
                          <div className="p-2 space-y-1.5 bg-amber-50/40">
                            <select
                              value={m.entry1_id || ''}
                              onChange={(e) => handleDirectSlotAssign(m, 1, e.target.value)}
                              className="w-full border rounded px-2 py-1 text-xs bg-white"
                            >
                              <option value="">— Пусто / BYE —</option>
                              {checkedInEntries.map((ce) => (
                                <option key={ce.id} value={ce.id}>
                                  {formatEntryName(ce)}
                                </option>
                              ))}
                            </select>
                            <select
                              value={m.entry2_id || ''}
                              onChange={(e) => handleDirectSlotAssign(m, 2, e.target.value)}
                              className="w-full border rounded px-2 py-1 text-xs bg-white"
                            >
                              <option value="">— Пусто / BYE —</option>
                              {checkedInEntries.map((ce) => (
                                <option key={ce.id} value={ce.id}>
                                  {formatEntryName(ce)}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={!canScore}
                              onClick={() => handleQuickResult(m, setsToWin, 0)}
                              className={`w-full px-3 py-2 text-left text-xs flex justify-between items-center border-b transition ${
                                p1Won
                                  ? 'bg-green-100 font-bold text-green-900'
                                  : canScore
                                  ? 'hover:bg-blue-50 cursor-pointer'
                                  : 'text-gray-400 cursor-default'
                              }`}
                            >
                              <span className="truncate">{formatEntryName(m.entry1)}</span>
                              <span className="ml-2 shrink-0">
                                {p1Won ? '🏆' : canScore ? t.TournamentDetail.chooseWinner : ''}
                              </span>
                            </button>

                            <button
                              type="button"
                              disabled={!canScore}
                              onClick={() => handleQuickResult(m, 0, setsToWin)}
                              className={`w-full px-3 py-2 text-left text-xs flex justify-between items-center transition ${
                                p2Won
                                  ? 'bg-green-100 font-bold text-green-900'
                                  : canScore
                                  ? 'hover:bg-blue-50 cursor-pointer'
                                  : 'text-gray-400 cursor-default'
                              }`}
                            >
                              <span className="truncate">{formatEntryName(m.entry2)}</span>
                              <span className="ml-2 shrink-0">
                                {p2Won ? '🏆' : canScore ? t.TournamentDetail.chooseWinner : ''}
                              </span>
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <main className="max-w-[1440px] mx-auto p-4 md:p-6 space-y-6">
      {/* PODIUM BANNER IF COMPLETED */}
      {medalists.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
          <span className="font-bold text-sm text-amber-900">🏆 {t.Tournaments.podium}:</span>
          <div className="flex flex-wrap gap-6 text-sm font-semibold">
            {medalists.map((m) => (
              <span key={m.id} className="flex items-center gap-1.5">
                <span>
                  {m.final_placement === 1 ? '🥇 1.' : m.final_placement === 2 ? '🥈 2.' : '🥉 3.'}
                </span>
                <span>{formatEntryName(m)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 1. HEADER + JURY CONTROLS */}
      <div className="bg-white border rounded-lg p-5 shadow-xs flex flex-col lg:flex-row justify-between gap-4">
        <div className="space-y-1.5 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl md:text-2xl font-bold">{tournament.title}</h1>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700">
              Bo{tournament.best_of} ({t.Tournaments.upToWins} {setsToWin} {t.Tournaments.winsUnit})
            </span>

            <button
              onClick={handleExportCsv}
              className="px-2.5 py-1 rounded text-xs font-semibold border bg-gray-50 hover:bg-gray-100 text-gray-700"
            >
              📊 CSV
            </button>

            {isStaff && (
              <button
                onClick={() => setJuryViewEnabled(!juryViewEnabled)}
                className={`px-2.5 py-1 rounded text-xs font-semibold border ${
                  isJuryMode
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white text-gray-600 border-gray-300'
                }`}
              >
                {isJuryMode ? t.Nav.juryModeOn : t.Nav.juryModeOff}
              </button>
            )}
          </div>
          <p className="text-xs text-gray-500">
            {new Date(tournament.event_date).toLocaleString(
              locale === 'ru' ? 'ru-RU' : 'en-US',
              { dateStyle: 'medium', timeStyle: 'short' }
            )}{' '}
            • {tournament.type === 'singles' ? t.Tournaments.singles : t.Tournaments.doubles}
          </p>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            {stages.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveStageId(s.id)}
                className={`px-3 py-1 rounded text-xs font-bold transition ${
                  currentStage?.id === s.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {t.TournamentDetail.stageTab} {s.stage_order}: {t.Staff.formats[s.format]}
              </button>
            ))}

            {stageMatches.length > 0 && (
              <button
                onClick={() => setShowSidebar(!showSidebar)}
                className="ml-auto px-3 py-1 rounded text-xs font-semibold border bg-gray-50 hover:bg-gray-100 text-gray-700"
              >
                {showSidebar
                  ? t.TournamentDetail.hideSidebar
                  : `${t.TournamentDetail.showSidebar} (${freeTableNumbers.length}/8)`}
              </button>
            )}
          </div>
        </div>

        {/* JURY PANEL */}
        {isJuryMode && (
          <div className="bg-gray-50 border rounded-md p-3.5 space-y-2.5 min-w-[340px] max-w-md">
            <div className="flex justify-between items-center gap-2">
              <span className="text-[11px] font-bold uppercase text-gray-500">
                {t.TournamentDetail.juryControls}
              </span>

              <div className="flex gap-1.5">
                <label className="flex items-center gap-1 text-[11px] font-semibold cursor-pointer bg-amber-50 border border-amber-200 text-amber-900 px-2 py-0.5 rounded">
                  <input
                    type="checkbox"
                    checked={fastTestMode}
                    onChange={(e) => setFastTestMode(e.target.checked)}
                  />
                  {t.TournamentDetail.fastTestMode}
                </label>

                <label className="flex items-center gap-1 text-[11px] font-semibold cursor-pointer bg-purple-50 border border-purple-200 text-purple-900 px-2 py-0.5 rounded">
                  <input
                    type="checkbox"
                    checked={manualSlotEditMode}
                    onChange={(e) => setManualSlotEditMode(e.target.checked)}
                  />
                  ✎ Слоты
                </label>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[11px] font-medium mb-0.5">
                  {t.TournamentDetail.changeStatus}
                </label>
                <select
                  value={tournament.status}
                  onChange={(e) => handleStatusChange(e.target.value as TournamentStatus)}
                  className="w-full border bg-white rounded px-1.5 py-1 text-xs font-medium"
                >
                  <option value="scheduled">{t.Tournaments.status.scheduled}</option>
                  <option value="registration_open">{t.Tournaments.status.registration_open}</option>
                  <option value="check_in">{t.Tournaments.status.check_in}</option>
                  <option value="in_progress">{t.Tournaments.status.in_progress}</option>
                  <option value="completed">{t.Tournaments.status.completed}</option>
                </select>
              </div>

              {currentStage && (
                <div>
                  <label className="block text-[11px] font-medium mb-0.5">
                    {t.TournamentDetail.stageFormat} {isStageStructureLocked ? '🔒' : ''}
                  </label>
                  <select
                    disabled={isStageStructureLocked}
                    value={currentStage.format}
                    onChange={(e) =>
                      handleStageFormatChange(currentStage.id, e.target.value as StageFormat)
                    }
                    className="w-full border bg-white rounded px-1.5 py-1 text-xs font-medium disabled:opacity-50"
                  >
                    <option value="single_elimination">{t.Staff.formats.single_elimination}</option>
                    <option value="double_elimination">{t.Staff.formats.double_elimination}</option>
                    <option value="round_robin">{t.Staff.formats.round_robin}</option>
                    <option value="swiss">{t.Staff.formats.swiss}</option>
                  </select>
                </div>
              )}

              <div>
                <label className="block text-[11px] font-medium mb-0.5">Посев / Seeding</label>
                <select
                  value={seedingMode}
                  onChange={(e) => setSeedingMode(e.target.value as SeedingMode)}
                  className="w-full border bg-white rounded px-1.5 py-1 text-xs font-medium"
                >
                  <option value="elo">По Эло (Elo)</option>
                  <option value="manual">Ручной (Seed #)</option>
                  <option value="random">Слепой жребий</option>
                </select>
              </div>
            </div>

            <div className="flex gap-2 items-end">
              {currentStage?.format === 'round_robin' && (
                <div className="w-20">
                  <label className="block text-[11px] font-medium mb-0.5">
                    {t.TournamentDetail.groupsCount}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    disabled={isStageStructureLocked}
                    value={groupCount}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setGroupCount(Math.max(1, Number(e.target.value)))}
                    className="w-full border bg-white rounded px-2 py-1 text-xs"
                  />
                </div>
              )}

              <button
                onClick={handleGenerateDraw}
                className="flex-1 bg-blue-600 text-white py-1.5 px-3 rounded text-xs font-semibold hover:bg-blue-700"
              >
                {t.TournamentDetail.generateDrawBtn} ({checkedInEntries.length})
              </button>

              {currentStage?.format === 'swiss' && stageMatches.length > 0 && (
                <button
                  onClick={handleNextSwissRound}
                  className="bg-indigo-600 text-white py-1.5 px-2.5 rounded text-xs font-semibold hover:bg-indigo-700"
                >
                  {t.TournamentDetail.nextSwissRoundBtn}
                </button>
              )}
            </div>

            {/* SWAP ANY TWO PLAYERS BAR */}
            {stageMatches.length > 0 && (
              <div className="pt-2 border-t flex items-center gap-1.5">
                <select
                  value={swapEntryA}
                  onChange={(e) => setSwapEntryA(e.target.value)}
                  className="flex-1 border bg-white rounded px-1.5 py-1 text-[11px]"
                >
                  <option value="">Игрок А...</option>
                  {checkedInEntries.map((ce) => (
                    <option key={ce.id} value={ce.id}>
                      {formatEntryName(ce)}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-gray-400">⇄</span>
                <select
                  value={swapEntryB}
                  onChange={(e) => setSwapEntryB(e.target.value)}
                  className="flex-1 border bg-white rounded px-1.5 py-1 text-[11px]"
                >
                  <option value="">Игрок Б...</option>
                  {checkedInEntries.map((ce) => (
                    <option key={ce.id} value={ce.id}>
                      {formatEntryName(ce)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleSwapPlayers}
                  className="bg-purple-600 text-white px-2.5 py-1 rounded text-[11px] font-semibold hover:bg-purple-700 shrink-0"
                >
                  Поменять
                </button>
              </div>
            )}

            {stageMatches.length > 0 && (
              <button
                onClick={handleCompleteTournament}
                className="w-full bg-amber-600 text-white py-1.5 px-3 rounded text-xs font-semibold hover:bg-amber-700"
              >
                {t.TournamentDetail.finishTournamentBtn}
              </button>
            )}

            {engineMsg && <p className="text-[11px] font-semibold text-blue-700">{engineMsg}</p>}
          </div>
        )}
      </div>

      {/* 2. MAIN WORKSPACE */}
      {stageMatches.length > 0 && currentStage && (
        <div className="flex flex-col lg:flex-row gap-6 items-start">
          <div className="flex-1 w-full bg-white border rounded-lg p-5 shadow-xs space-y-6 overflow-hidden">
            <div className="flex flex-wrap justify-between items-center gap-2 border-b pb-3">
              <h2 className="text-lg font-bold">{t.Staff.formats[currentStage.format]}</h2>
              {isJuryMode && (
                <span className="text-xs text-gray-500">
                  {manualSlotEditMode
                    ? '✎ Режим ручной расстановки активен: выберите любого игрока в любой слот матча'
                    : !fastTestMode
                    ? t.TournamentDetail.safeModeHint
                    : t.TournamentDetail.fastModeHint}
                </span>
              )}
            </div>

            {/* VIEW A: SINGLE & DOUBLE ELIMINATION */}
            {(currentStage.format === 'single_elimination' ||
              currentStage.format === 'double_elimination') && (
              <div className="space-y-8">
                {renderBracketTree(
                  stageMatches.filter((m) => m.bracket_type === 'main'),
                  t.TournamentDetail.mainBracket
                )}

                {currentStage.format === 'single_elimination' &&
                  renderBracketTree(
                    stageMatches.filter((m) => m.bracket_type === 'third_place'),
                    t.TournamentDetail.thirdPlaceMatch
                  )}

                {currentStage.format === 'double_elimination' && (
                  <>
                    {renderBracketTree(
                      stageMatches.filter((m) => m.bracket_type === 'losers'),
                      t.TournamentDetail.losersBracket
                    )}
                    {renderBracketTree(
                      stageMatches.filter((m) => m.bracket_type === 'grand_final'),
                      t.TournamentDetail.grandFinal
                    )}
                  </>
                )}
              </div>
            )}

            {/* VIEW B: ROUND ROBIN GROUPS */}
            {currentStage.format === 'round_robin' && (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                {distinctGroups.map((gNum) => {
                  const gMatches = stageMatches.filter((m) => (m.group_number || 1) === gNum);
                  const gStandings = liveStandings.filter((r) => r.groupNumber === gNum);
                  const advanceCountForThisGroup = groupAdvanceMap[gNum] ?? 2;

                  return (
                    <div key={gNum} className="border rounded-lg p-4 bg-gray-50/50 space-y-3">
                      <div className="flex justify-between items-center">
                        <h3 className="font-bold text-sm text-blue-900">
                          {t.TournamentDetail.group} #{gNum}
                        </h3>
                        {isJuryMode && (
                          <label className="flex items-center gap-1.5 text-xs text-gray-600">
                            {t.TournamentDetail.advanceFromGroup}
                            <input
                              type="number"
                              min={1}
                              max={gStandings.length || 8}
                              value={advanceCountForThisGroup}
                              onFocus={(e) => e.target.select()}
                              onChange={(e) =>
                                setGroupAdvanceMap({
                                  ...groupAdvanceMap,
                                  [gNum]: Math.max(1, Number(e.target.value)),
                                })
                              }
                              className="w-12 border bg-white rounded px-1.5 py-0.5 text-center font-bold text-emerald-700"
                            />
                          </label>
                        )}
                      </div>

                      <div className="overflow-x-auto bg-white border rounded-md">
                        <table className="w-full text-xs text-left border-collapse">
                          <thead className="bg-gray-100 text-gray-700">
                            <tr>
                              <th className="p-1.5 border">#</th>
                              <th className="p-1.5 border">{t.Staff.fullName}</th>
                              {gStandings.map((_, idx) => (
                                <th key={idx} className="p-1.5 border text-center w-8">
                                  {idx + 1}
                                </th>
                              ))}
                              <th className="p-1.5 border text-center">W-L</th>
                              <th className="p-1.5 border text-center">Sets</th>
                            </tr>
                          </thead>
                          <tbody>
                            {gStandings.map((row, rIdx) => {
                              const isQualifying = qualifiedIdSet.has(row.entry.id);
                              return (
                                <tr
                                  key={row.entry.id}
                                  className={isQualifying ? 'bg-emerald-50/60' : ''}
                                >
                                  <td className="p-1.5 border font-bold">
                                    {rIdx + 1}
                                    {isQualifying && (
                                      <span className="ml-1 text-emerald-600">▲</span>
                                    )}
                                  </td>
                                  <td className="p-1.5 border font-medium truncate max-w-[130px]">
                                    {formatEntryName(row.entry)}
                                  </td>
                                  {gStandings.map((col, cIdx) => {
                                    if (rIdx === cIdx) {
                                      return <td key={cIdx} className="p-1.5 border bg-gray-200" />;
                                    }
                                    const match = gMatches.find(
                                      (m) =>
                                        (m.entry1_id === row.entry.id &&
                                          m.entry2_id === col.entry.id) ||
                                        (m.entry1_id === col.entry.id &&
                                          m.entry2_id === row.entry.id)
                                    );
                                    if (!match || match.status !== 'completed') {
                                      return (
                                        <td
                                          key={cIdx}
                                          className="p-1.5 border text-center text-gray-300"
                                        >
                                          —
                                        </td>
                                      );
                                    }
                                    const isE1 = match.entry1_id === row.entry.id;
                                    const myS = isE1 ? match.entry1_score : match.entry2_score;
                                    const oppS = isE1 ? match.entry2_score : match.entry1_score;
                                    return (
                                      <td
                                        key={cIdx}
                                        className={`p-1.5 border text-center font-semibold ${
                                          myS > oppS ? 'text-green-700' : 'text-red-600'
                                        }`}
                                      >
                                        {myS}:{oppS}
                                      </td>
                                    );
                                  })}
                                  <td className="p-1.5 border text-center font-semibold">
                                    {row.wins}-{row.losses}
                                  </td>
                                  <td className="p-1.5 border text-center text-gray-600">
                                    {row.setsWon}:{row.setsLost}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      <div className="space-y-1.5">
                        {gMatches.map((m) => {
                          const canScore =
                            isJuryMode &&
                            (fastTestMode ||
                              m.status === 'in_progress' ||
                              m.status === 'completed');
                          return (
                            <div
                              key={m.id}
                              className={`border rounded px-2.5 py-1.5 bg-white flex flex-wrap justify-between items-center gap-2 text-xs ${
                                m.status === 'in_progress'
                                  ? 'border-blue-500 bg-blue-50/20'
                                  : m.status === 'completed'
                                  ? 'border-green-200 bg-green-50/20'
                                  : ''
                              }`}
                            >
                              <div className="truncate max-w-[200px]">
                                <span
                                  className={
                                    m.winner_entry_id === m.entry1_id
                                      ? 'font-bold text-green-800'
                                      : ''
                                  }
                                >
                                  {formatEntryName(m.entry1)}
                                </span>{' '}
                                <span className="text-gray-400">vs</span>{' '}
                                <span
                                  className={
                                    m.winner_entry_id === m.entry2_id
                                      ? 'font-bold text-green-800'
                                      : ''
                                  }
                                >
                                  {formatEntryName(m.entry2)}
                                </span>
                              </div>

                              <div className="flex items-center gap-1">
                                {validScorePairs.map(([s1, s2]) => {
                                  const isSelected =
                                    m.status === 'completed' &&
                                    m.entry1_score === s1 &&
                                    m.entry2_score === s2;
                                  return (
                                    <button
                                      key={`${s1}-${s2}`}
                                      disabled={!canScore}
                                      onClick={() => handleQuickResult(m, s1, s2)}
                                      className={`px-1.5 py-0.5 rounded text-[11px] font-semibold transition ${
                                        isSelected
                                          ? 'bg-green-600 text-white'
                                          : canScore
                                          ? 'bg-gray-100 hover:bg-blue-600 hover:text-white text-gray-700'
                                          : 'bg-gray-50 text-gray-300 cursor-default'
                                      }`}
                                    >
                                      {s1}:{s2}
                                    </button>
                                  );
                                })}
                                {isJuryMode && m.status === 'completed' && (
                                  <button
                                    type="button"
                                    onClick={() => handleUndoMatch(m)}
                                    className="ml-1 text-[10px] text-red-600 hover:underline"
                                  >
                                    ↺
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* VIEW C: SWISS SYSTEM ROUNDS */}
            {currentStage.format === 'swiss' && (
              <div className="space-y-4">
                {Array.from(new Set(stageMatches.map((m) => m.round_number)))
                  .sort((a, b) => b - a)
                  .map((rNum) => {
                    const rMatches = stageMatches.filter((m) => m.round_number === rNum);
                    return (
                      <div key={rNum} className="border rounded-lg p-4 bg-gray-50/60 space-y-2.5">
                        <h3 className="font-bold text-xs uppercase text-indigo-900">
                          {t.TournamentDetail.round} {rNum}
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                          {rMatches.map((m) => {
                            const canScore =
                              isJuryMode &&
                              (fastTestMode ||
                                m.status === 'in_progress' ||
                                m.status === 'completed');
                            return (
                              <div
                                key={m.id}
                                className={`bg-white border rounded p-2.5 flex justify-between items-center gap-2 text-xs ${
                                  m.status === 'in_progress' ? 'border-blue-500' : ''
                                }`}
                              >
                                <div className="truncate">
                                  <span
                                    className={
                                      m.winner_entry_id === m.entry1_id
                                        ? 'font-bold text-green-800'
                                        : ''
                                    }
                                  >
                                    {formatEntryName(m.entry1)}
                                  </span>{' '}
                                  <span className="text-gray-400">vs</span>{' '}
                                  <span
                                    className={
                                      m.winner_entry_id === m.entry2_id
                                        ? 'font-bold text-green-800'
                                        : ''
                                    }
                                  >
                                    {formatEntryName(m.entry2)}
                                  </span>
                                </div>

                                {m.status === 'walkover' ? (
                                  <span className="text-green-700 font-bold shrink-0">
                                    BYE (+1)
                                  </span>
                                ) : (
                                  <div className="flex items-center gap-1 shrink-0">
                                    {validScorePairs.map(([s1, s2]) => {
                                      const isSelected =
                                        m.status === 'completed' &&
                                        m.entry1_score === s1 &&
                                        m.entry2_score === s2;
                                      return (
                                        <button
                                          key={`${s1}-${s2}`}
                                          disabled={!canScore}
                                          onClick={() => handleQuickResult(m, s1, s2)}
                                          className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                                            isSelected
                                              ? 'bg-green-600 text-white'
                                              : canScore
                                              ? 'bg-gray-100 hover:bg-indigo-600 hover:text-white text-gray-700'
                                              : 'bg-gray-50 text-gray-300 cursor-default'
                                          }`}
                                        >
                                          {s1}:{s2}
                                        </button>
                                      );
                                    })}
                                    {isJuryMode && m.status === 'completed' && (
                                      <button
                                        type="button"
                                        onClick={() => handleUndoMatch(m)}
                                        className="ml-1 text-[10px] text-red-600 hover:underline"
                                      >
                                        ↺
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>

          {/* RIGHT SIDEBAR: LIVE STANDINGS + 8 TABLES */}
          {showSidebar && (
            <aside className="w-full lg:w-[350px] shrink-0 space-y-4">
              {isGroupOrSwiss && (
                <div className="bg-white border rounded-lg p-4 shadow-xs space-y-3">
                  <div className="flex justify-between items-center">
                    <h3 className="text-xs font-bold uppercase text-gray-700">
                      {t.TournamentDetail.standingsTitle}
                    </h3>
                    <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                      {t.TournamentDetail.qualifyingCount}: {predictedQualifiers.length}
                    </span>
                  </div>

                  {isSwiss && isJuryMode && (
                    <div className="flex items-center justify-between bg-indigo-50/60 p-2 rounded border border-indigo-100 text-xs">
                      <span className="font-medium text-indigo-950">
                        {t.TournamentDetail.swissTopLabel}
                      </span>
                      <div className="flex gap-1">
                        {[2, 4, 6, 8].map((n) => (
                          <button
                            key={n}
                            onClick={() => setSwissAdvanceCount(n)}
                            className={`px-2 py-0.5 rounded font-bold ${
                              swissAdvanceCount === n
                                ? 'bg-indigo-600 text-white'
                                : 'bg-white border text-gray-700'
                            }`}
                          >
                            {t.TournamentDetail.top}-{n}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="max-h-60 overflow-y-auto border rounded">
                    <table className="w-full text-[11px] text-left">
                      <thead className="bg-gray-50 border-b text-gray-500 sticky top-0">
                        <tr>
                          <th className="p-1.5">#</th>
                          <th className="p-1.5">{t.Staff.fullName}</th>
                          <th className="p-1.5 text-center">W-L</th>
                          <th className="p-1.5 text-center">Diff</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {liveStandings.map((row, idx) => {
                          const qualifies = qualifiedIdSet.has(row.entry.id);
                          return (
                            <tr
                              key={row.entry.id}
                              className={qualifies ? 'bg-emerald-50/70 font-medium' : ''}
                            >
                              <td className="p-1.5 font-bold">
                                {isSwiss ? idx + 1 : `G${row.groupNumber}-${row.rankInGroup}`}
                              </td>
                              <td className="p-1.5 truncate max-w-[140px]">
                                {qualifies && <span className="text-emerald-600 mr-1">●</span>}
                                {formatEntryName(row.entry)}
                              </td>
                              <td className="p-1.5 text-center font-bold">
                                {row.wins}-{row.losses}
                              </td>
                              <td className="p-1.5 text-center text-gray-500">
                                {row.setDiff > 0 ? `+${row.setDiff}` : row.setDiff}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {isJuryMode && (
                    <div className="pt-1 border-t space-y-2">
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-gray-600">
                          {t.TournamentDetail.stage2FormatLabel}
                        </span>
                        <select
                          value={stage2Format}
                          onChange={(e) => setStage2Format(e.target.value as StageFormat)}
                          className="border rounded px-2 py-1 text-xs font-medium bg-white"
                        >
                          <option value="single_elimination">Single Elimination</option>
                          <option value="double_elimination">Double Elimination</option>
                        </select>
                      </div>
                      <button
                        onClick={handleAdvanceToStage2}
                        className="w-full bg-emerald-600 text-white py-2 rounded text-xs font-bold hover:bg-emerald-700"
                      >
                        {t.TournamentDetail.createStage2Btn} ({predictedQualifiers.length})
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* COMPACT 8-TABLE DISPATCHER */}
              <div className="bg-white border rounded-lg p-4 shadow-xs space-y-3">
                <h3 className="text-xs font-bold uppercase text-gray-700">
                  {t.TournamentDetail.tablesTitle} ({t.TournamentDetail.free}:{' '}
                  {freeTableNumbers.length}/8)
                </h3>

                <div className="grid grid-cols-2 gap-2">
                  {Array.from({ length: TOTAL_TABLES }, (_, i) => i + 1).map((tNum) => {
                    const active = occupiedTables.get(tNum);
                    return (
                      <div
                        key={tNum}
                        className={`border rounded p-2 text-[11px] ${
                          active
                            ? 'bg-blue-50/70 border-blue-300'
                            : 'bg-green-50/40 border-green-200'
                        }`}
                      >
                        <div className="flex justify-between font-bold mb-1">
                          <span>
                            {t.TournamentDetail.table} #{tNum}
                          </span>
                          {active && isJuryMode ? (
                            <button
                              onClick={() => handleAssignTable(active.id, null)}
                              className="text-[10px] text-red-600 hover:underline"
                            >
                              {t.TournamentDetail.releaseTable}
                            </button>
                          ) : !active ? (
                            <span className="text-green-700">{t.TournamentDetail.tableFree}</span>
                          ) : null}
                        </div>
                        {active ? (
                          <div className="truncate text-gray-800 leading-tight">
                            <div className="truncate">{formatEntryName(active.entry1)}</div>
                            <div className="truncate text-gray-500">
                              vs {formatEntryName(active.entry2)}
                            </div>
                          </div>
                        ) : (
                          <div className="text-gray-400">{t.TournamentDetail.waitingPair}</div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {isJuryMode && (
                  <div className="border-t pt-2.5 space-y-2">
                    <p className="text-[11px] font-bold uppercase text-gray-500">
                      {t.TournamentDetail.callQueue} ({readyQueue.length})
                    </p>
                    <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1">
                      {readyQueue.slice(0, 8).map((m) => (
                        <div
                          key={m.id}
                          className="border rounded p-2 bg-gray-50 text-[11px] space-y-1.5"
                        >
                          <div className="font-semibold text-gray-800 truncate">
                            {formatEntryName(m.entry1)} <span className="text-gray-400">vs</span>{' '}
                            {formatEntryName(m.entry2)}
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {freeTableNumbers.length > 0 ? (
                              freeTableNumbers.map((tNum) => (
                                <button
                                  key={tNum}
                                  onClick={() => handleAssignTable(m.id, tNum)}
                                  className="bg-blue-600 text-white px-1.5 py-0.5 rounded text-[10px] font-semibold hover:bg-blue-700"
                                >
                                  → #{tNum}
                                </button>
                              ))
                            ) : (
                              <span className="text-amber-700 text-[10px]">
                                {t.TournamentDetail.allTablesBusy}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                      {readyQueue.length === 0 && (
                        <p className="text-[11px] text-gray-400">
                          {t.TournamentDetail.noReadyMatches}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      )}

      {/* 3. REGISTRATION + GOOGLE FORMS CSV IMPORT */}
      {(isJuryMode || tournament.status === 'registration_open') && (
        <section className="bg-white border rounded-lg p-6 shadow-xs space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-semibold">{t.TournamentDetail.registrationTitle}</h2>
            {isJuryMode && (
              <button
                type="button"
                onClick={() => setShowCsvImport(!showCsvImport)}
                className="text-xs font-semibold px-3 py-1.5 rounded border bg-gray-50 hover:bg-gray-100"
              >
                {t.TournamentDetail.csvImportTitle}
              </button>
            )}
          </div>

          {showCsvImport && isJuryMode && (
            <div className="bg-blue-50/50 border border-blue-200 rounded-md p-4 space-y-3">
              <textarea
                rows={4}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder={t.TournamentDetail.csvPlaceholder}
                className="w-full border bg-white rounded p-2.5 text-xs font-mono"
              />
              <button
                type="button"
                onClick={handleCsvImport}
                className="bg-blue-600 text-white px-4 py-1.5 rounded text-xs font-semibold hover:bg-blue-700"
              >
                {t.TournamentDetail.csvImportBtn}
              </button>
            </div>
          )}

          <form onSubmit={handleRegisterEntry} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <PlayerPicker
                label={t.TournamentDetail.player1}
                players={allPlayers}
                selectedPlayer={player1}
                onSelect={setPlayer1}
                onPlayerCreated={(newP) => setAllPlayers([...allPlayers, newP])}
              />
              {tournament.type === 'doubles' && (
                <PlayerPicker
                  label={t.TournamentDetail.player2}
                  players={allPlayers}
                  selectedPlayer={player2}
                  onSelect={setPlayer2}
                  onPlayerCreated={(newP) => setAllPlayers([...allPlayers, newP])}
                />
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 pt-2">
              {isJuryMode ? (
                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checkInImmediately}
                    onChange={(e) => setCheckInImmediately(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  {t.TournamentDetail.checkInImmediately}
                </label>
              ) : (
                <div />
              )}

              <div className="flex items-center gap-3">
                {regMessage && <span className="text-sm text-blue-700">{regMessage}</span>}
                <button
                  type="submit"
                  disabled={!player1 || (tournament.type === 'doubles' && !player2)}
                  className="bg-blue-600 text-white px-5 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {t.TournamentDetail.registerBtn}
                </button>
              </div>
            </div>
          </form>
        </section>
      )}

      {/* 4. PARTICIPANTS & CHECK-IN + MANUAL SEED ORDER */}
      <section className="bg-white border rounded-lg p-6 shadow-xs space-y-4">
        <div className="flex flex-wrap justify-between items-center gap-4">
          <h2 className="text-lg font-semibold">{t.TournamentDetail.participantsTitle}</h2>
          <div className="flex gap-4 text-sm">
            <span className="px-3 py-1 bg-gray-100 rounded-full">
              {t.TournamentDetail.totalRegistered}: <strong>{entries.length}</strong>
            </span>
            <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full">
              {t.TournamentDetail.checkedInCount}: <strong>{checkedInEntries.length}</strong>
            </span>
          </div>
        </div>

        <div className="overflow-x-auto border rounded-md">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-50 border-b text-gray-600">
              <tr>
                <th className="p-3">Seed #</th>
                <th className="p-3">{t.Staff.fullName}</th>
                <th className="p-3">Seed Elo</th>
                <th className="p-3">{t.TournamentDetail.changeStatus}</th>
                {isJuryMode && <th className="p-3 text-right">Check-In</th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {entries.map((entry, idx) => (
                <tr key={entry.id} className="hover:bg-gray-50">
                  <td className="p-3 text-gray-500 w-24">
                    {isJuryMode ? (
                      <input
                        type="number"
                        min={1}
                        value={entry.seed_number ?? idx + 1}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) =>
                          handleSeedNumberChange(entry.id, Number(e.target.value))
                        }
                        className="w-14 border rounded px-1.5 py-0.5 text-xs font-bold text-center"
                        title="Задайте номер посева вручную и выберите «Ручной (Seed #)» при генерации сетки"
                      />
                    ) : (
                      entry.seed_number ?? idx + 1
                    )}
                  </td>
                  <td className="p-3 font-medium">
                    {entry.final_placement === 1 && '🥇 '}
                    {entry.final_placement === 2 && '🥈 '}
                    {entry.final_placement === 3 && '🥉 '}
                    {formatEntryName(entry)}
                  </td>
                  <td className="p-3 font-semibold">{entry.seed_elo}</td>
                  <td className="p-3">
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        entry.attendance === 'checked_in'
                          ? 'bg-green-100 text-green-800'
                          : entry.attendance === 'no_show'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {t.TournamentDetail.attendance[entry.attendance]}
                    </span>
                  </td>
                  {isJuryMode && (
                    <td className="p-3 text-right space-x-2">
                      <button
                        onClick={() => handleAttendanceChange(entry.id, 'checked_in')}
                        className={`px-2.5 py-1 rounded text-xs font-medium ${
                          entry.attendance === 'checked_in'
                            ? 'bg-green-600 text-white'
                            : 'bg-gray-100 hover:bg-green-50 text-gray-700'
                        }`}
                      >
                        ✓ {t.TournamentDetail.markCheckedIn}
                      </button>
                      <button
                        onClick={() => handleAttendanceChange(entry.id, 'no_show')}
                        className={`px-2.5 py-1 rounded text-xs font-medium ${
                          entry.attendance === 'no_show'
                            ? 'bg-red-600 text-white'
                            : 'bg-gray-100 hover:bg-red-50 text-gray-700'
                        }`}
                      >
                        ✕ {t.TournamentDetail.markNoShow}
                      </button>
                      <button
                        onClick={() => handleDeleteEntry(entry.id)}
                        className="px-2 py-1 text-xs text-gray-400 hover:text-red-600"
                      >
                        {t.TournamentDetail.remove}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}