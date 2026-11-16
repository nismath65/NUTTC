'use client';

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams } from 'next/navigation';
import {
  Download,
  Unlock,
  Eye,
  FlaskConical,
  Pencil,
  ArrowLeftRight,
  Lock,
  Zap,
  Plus,
  Flag,
  AlertTriangle,
  RotateCcw,
  Check,
  X,
  Trash2,
  Search,
  PanelRightClose,
  PanelRightOpen,
  Trophy,
  FileSpreadsheet,
  CircleDot,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useLanguage } from '@/components/LanguageProvider';
import { useAuth } from '@/components/AuthProvider';
import PlayerPicker from '@/components/PlayerPicker';
import BracketView from '@/components/BracketView';
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
  findStageIntegrityIssues,
  SeedingMode,
} from '@/lib/tournamentEngine';
import { parseCsvParticipantLine } from '@/lib/playerLevels';
import {
  Tournament,
  TournamentStage,
  TournamentEntry,
  Player,
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
  const [showSwapBar, setShowSwapBar] = useState(false);
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [participantSearch, setParticipantSearch] = useState('');

  // Concurrency / double-click guards
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [busyMatchId, setBusyMatchId] = useState<string | null>(null);
  const [confirmRedraw, setConfirmRedraw] = useState(false);
  const actionLockRef = useRef(false);
  const loadSeqRef = useRef(0);
  const realtimeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const [engineMsg, setEngineMsg] = useState<{ text: string; isError?: boolean } | null>(null);

  const loadTournamentData = useCallback(async () => {
    if (!id) return;
    const seq = ++loadSeqRef.current;

    const [{ data: tData }, { data: sData }, { data: eData }, { data: mData }, { data: pData }] =
      await Promise.all([
        supabase.from('tournaments').select('*').eq('id', id).single(),
        supabase
          .from('tournament_stages')
          .select('*')
          .eq('tournament_id', id)
          .order('stage_order', { ascending: true }),
        supabase
          .from('tournament_entries')
          .select('*, player1:players!player1_id(*), player2:players!player2_id(*)')
          .eq('tournament_id', id)
          .order('seed_number', { ascending: true, nullsFirst: false })
          .order('seed_elo', { ascending: false }),
        supabase
          .from('matches')
          .select('*')
          .eq('tournament_id', id)
          .order('round_number', { ascending: true })
          .order('match_number', { ascending: true }),
        supabase.from('players').select('*').order('full_name', { ascending: true }),
      ]);

    // Ignore stale out-of-order responses
    if (seq !== loadSeqRef.current) return;

    if (tData) setTournament(tData as Tournament);

    const loadedStages = (sData as TournamentStage[]) || [];
    setStages(loadedStages);
    setActiveStageId((prev) =>
      prev && loadedStages.some((s) => s.id === prev)
        ? prev
        : loadedStages[loadedStages.length - 1]?.id || null
    );

    const loadedEntries = (eData as TournamentEntry[]) || [];
    setEntries(loadedEntries);

    const entryMap: Record<string, TournamentEntry> = {};
    loadedEntries.forEach((e) => {
      entryMap[e.id] = e;
    });

    if (mData) {
      const enriched: Match[] = (mData as Match[]).map((m) => ({
        ...m,
        entry1: m.entry1_id ? entryMap[m.entry1_id] : null,
        entry2: m.entry2_id ? entryMap[m.entry2_id] : null,
      }));
      setMatches(enriched);
    }

    if (pData) setAllPlayers(pData as Player[]);
  }, [id]);

  // Initial load + debounced SUPABASE REALTIME SUBSCRIPTION
  useEffect(() => {
    loadTournamentData();

    if (!id) return;
    const scheduleReload = () => {
      if (realtimeTimerRef.current) clearTimeout(realtimeTimerRef.current);
      realtimeTimerRef.current = setTimeout(() => {
        loadTournamentData();
      }, 120);
    };

    const channel = supabase
      .channel(`live-tournament-${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'matches', filter: `tournament_id=eq.${id}` },
        scheduleReload
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_entries',
          filter: `tournament_id=eq.${id}`,
        },
        scheduleReload
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_stages',
          filter: `tournament_id=eq.${id}`,
        },
        scheduleReload
      )
      .subscribe();

    return () => {
      if (realtimeTimerRef.current) clearTimeout(realtimeTimerRef.current);
      supabase.removeChannel(channel);
    };
  }, [id, loadTournamentData]);

  // Auto-reset confirmation step after 4s
  useEffect(() => {
    if (!confirmRedraw) return;
    const timer = setTimeout(() => setConfirmRedraw(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmRedraw]);

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

  const integrityIssues = useMemo(() => {
    if (!currentStage || stageMatches.length === 0) return [];
    return findStageIntegrityIssues(stageMatches, currentStage.format);
  }, [stageMatches, currentStage]);

  const flaggedMatchIds = useMemo(() => {
    const set = new Set<string>();
    integrityIssues.forEach((issue) => issue.matchIds.forEach((mid) => set.add(mid)));
    return set;
  }, [integrityIssues]);

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

  const registeredPlayerIds = useMemo(() => {
    const ids = new Set<string>();
    entries.forEach((e) => {
      if (e.player1_id) ids.add(e.player1_id);
      if (e.player2_id) ids.add(e.player2_id);
    });
    return ids;
  }, [entries]);

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

  const runDrawGeneration = async (skipConfirm = false) => {
    if (!tournament || !currentStage) return;
    if (!skipConfirm && stageMatches.length > 0 && !confirmRedraw) {
      setConfirmRedraw(true);
      return;
    }
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    setBusyAction('draw');
    setConfirmRedraw(false);
    setEngineMsg(null);
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
      setEngineMsg({ text: '✓ Сетка сформирована / Draw generated!' });
      await loadTournamentData();
    } catch (err: unknown) {
      setEngineMsg({
        text: err instanceof Error ? err.message : 'Error',
        isError: true,
      });
    } finally {
      actionLockRef.current = false;
      setBusyAction(null);
    }
  };

  const handleNextSwissRound = async () => {
    if (!tournament || !currentStage || actionLockRef.current) return;
    actionLockRef.current = true;
    setBusyAction('swiss');
    setEngineMsg(null);
    try {
      await generateNextSwissRound(tournament.id, currentStage.id, checkedInEntries, matches);
      await loadTournamentData();
    } catch (err: unknown) {
      setEngineMsg({
        text: err instanceof Error ? err.message : 'Error',
        isError: true,
      });
    } finally {
      actionLockRef.current = false;
      setBusyAction(null);
    }
  };

  const handleQuickResult = async (match: Match, s1: number, s2: number) => {
    if (!tournament || !isJuryMode || busyMatchId === match.id) return;
    if (!fastTestMode && match.status !== 'in_progress' && match.status !== 'completed') {
      setEngineMsg({ text: t.TournamentDetail.safeModeHint, isError: true });
      return;
    }
    setEngineMsg(null);
    setBusyMatchId(match.id);
    try {
      await submitMatchResult(match, s1, s2, tournament.best_of, tournament.is_rated);
      await loadTournamentData();
    } catch (err: unknown) {
      setEngineMsg({
        text: err instanceof Error ? err.message : 'Error',
        isError: true,
      });
    } finally {
      setBusyMatchId(null);
    }
  };

  const handleUndoMatch = async (match: Match) => {
    if (busyMatchId === match.id) return;
    setEngineMsg(null);
    setBusyMatchId(match.id);
    try {
      await undoMatchResult(match);
      setEngineMsg({ text: '↺ Результат матча отменён / Match result undone' });
      await loadTournamentData();
    } catch (err: unknown) {
      setEngineMsg({
        text: err instanceof Error ? err.message : 'Error undoing match',
        isError: true,
      });
    } finally {
      setBusyMatchId(null);
    }
  };

  const handleSwapPlayers = async () => {
    if (!currentStage || !swapEntryA || !swapEntryB || swapEntryA === swapEntryB) return;
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    setBusyAction('swap');
    setEngineMsg(null);
    try {
      await swapTwoEntriesInStage(currentStage.id, swapEntryA, swapEntryB);
      setEngineMsg({ text: '⇄ Игроки поменялись местами / Players swapped!' });
      setSwapEntryA('');
      setSwapEntryB('');
      await loadTournamentData();
    } catch (err: unknown) {
      setEngineMsg({
        text: err instanceof Error ? err.message : 'Error swapping players',
        isError: true,
      });
    } finally {
      actionLockRef.current = false;
      setBusyAction(null);
    }
  };

  const handleDirectSlotAssign = async (match: Match, slot: 1 | 2, newEntryId: string) => {
    setEngineMsg(null);
    try {
      await assignEntryToMatchSlot(match, slot, newEntryId || null);
      await loadTournamentData();
    } catch (err: unknown) {
      setEngineMsg({
        text: err instanceof Error ? err.message : 'Error assigning slot',
        isError: true,
      });
    }
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
    if (!tournament || actionLockRef.current) return;
    actionLockRef.current = true;
    setBusyAction('stage2');
    setEngineMsg(null);
    try {
      const s2Id = await createAndAdvanceToStage2(
        tournament.id,
        predictedQualifiers,
        stage2Format
      );
      setActiveStageId(s2Id);
      await loadTournamentData();
    } catch (err: unknown) {
      setEngineMsg({
        text: err instanceof Error ? err.message : 'Error',
        isError: true,
      });
    } finally {
      actionLockRef.current = false;
      setBusyAction(null);
    }
  };

  const handleCompleteTournament = async () => {
    if (!tournament || !currentStage || actionLockRef.current) return;
    actionLockRef.current = true;
    setBusyAction('complete');
    setEngineMsg(null);
    try {
      await completeTournamentAndAssignMedals(
        tournament.id,
        stageMatches,
        currentStage.format,
        entries
      );
      setEngineMsg({ text: '✓ Турнир завершён, медали вручены!' });
      await loadTournamentData();
    } catch (err: unknown) {
      setEngineMsg({
        text: err instanceof Error ? err.message : 'Error',
        isError: true,
      });
    } finally {
      actionLockRef.current = false;
      setBusyAction(null);
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
      rows
        .map((r) => r.map((cell) => `"${(cell || '').replace(/"/g, '""')}"`).join(','))
        .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${tournament.title.replace(/\s+/g, '_')}_results.csv`;
    link.click();
  };

  // --- GOOGLE FORMS CSV IMPORT ---
  const handleCsvImport = async () => {
    if (!tournament || !csvText.trim() || actionLockRef.current) return;
    actionLockRef.current = true;
    setBusyAction('csv');
    try {
      const lines = csvText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      const knownPlayers = [...allPlayers];
      const seenIds = new Set(registeredPlayerIds);
      let importedCount = 0;
      let skippedDuplicates = 0;

      for (const line of lines) {
        const parsed = parseCsvParticipantLine(line);
        if (!parsed) continue;

        let playerRecord = knownPlayers.find(
          (p) =>
            (parsed.universityId && p.university_id === parsed.universityId) ||
            p.full_name.toLowerCase() === parsed.fullName.toLowerCase()
        );

        // New players get starting Elo from their declared skill level;
        // existing players keep their earned club Elo rating.
        if (!playerRecord) {
          const { data: created } = await supabase
            .from('players')
            .insert({
              full_name: parsed.fullName,
              university_id: parsed.universityId,
              category: parsed.category,
              elo_rating: parsed.initialElo,
            })
            .select()
            .single();
          if (created) {
            playerRecord = created as Player;
            knownPlayers.push(playerRecord);
          }
        }

        if (playerRecord) {
          if (seenIds.has(playerRecord.id)) {
            skippedDuplicates++;
            continue;
          }
          const { error } = await supabase.from('tournament_entries').insert({
            tournament_id: tournament.id,
            player1_id: playerRecord.id,
            attendance: 'registered',
            seed_elo: playerRecord.elo_rating,
          });
          if (!error) {
            seenIds.add(playerRecord.id);
            importedCount++;
          }
        }
      }

      setCsvText('');
      setShowCsvImport(false);
      setRegMessage(
        skippedDuplicates > 0
          ? `✓ Импортировано: ${importedCount} (пропущено дубликатов: ${skippedDuplicates})`
          : `✓ Импортировано из CSV: ${importedCount}`
      );
      await loadTournamentData();
    } finally {
      actionLockRef.current = false;
      setBusyAction(null);
    }
  };

  const handleRegisterEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegMessage(null);
    if (!tournament || !player1 || actionLockRef.current) return;
    if (tournament.type === 'doubles' && !player2) return;
    if (tournament.type === 'doubles' && player1.id === player2?.id) return;

    if (
      registeredPlayerIds.has(player1.id) ||
      (tournament.type === 'doubles' && player2 && registeredPlayerIds.has(player2.id))
    ) {
      setRegMessage(
        locale === 'ru'
          ? 'Игрок уже зарегистрирован в этом турнире'
          : 'Player is already registered in this tournament'
      );
      return;
    }

    actionLockRef.current = true;
    setBusyAction('register');
    try {
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
      await loadTournamentData();
    } finally {
      actionLockRef.current = false;
      setBusyAction(null);
    }
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
    return (
      <div className="max-w-7xl mx-auto p-6 text-sm text-[#828E88]">
        Loading...
      </div>
    );
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

  const filteredEntries = entries.filter((entry) => {
    const q = participantSearch.trim().toLowerCase();
    if (!q) return true;
    return formatEntryName(entry).toLowerCase().includes(q);
  });

  return (
    <main className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* PODIUM BANNER IF COMPLETED */}
      {medalists.length > 0 && (
        <div className="bg-[#FEF7E6] border border-[#ECD58E] rounded-xl px-5 py-3.5 flex flex-wrap items-center justify-between gap-4">
          <div className="inline-flex items-center gap-2 font-bold text-sm text-[#784A04]">
            <Trophy className="w-4 h-4 text-[#B45309]" />
            <span>{t.Tournaments.podium}</span>
          </div>
          <div className="flex flex-wrap gap-3 text-sm font-semibold">
            {medalists.map((m) => (
              <span
                key={m.id}
                className="inline-flex items-center gap-1.5 bg-white/80 border border-[#ECD58E] px-3 py-1 rounded-lg text-[#18211D]"
              >
                <span>
                  {m.final_placement === 1 ? '🥇' : m.final_placement === 2 ? '🥈' : '🥉'}
                </span>
                <span>{formatEntryName(m)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 1. HEADER & STAGE TABS */}
      <section className="bg-white border border-[#E3DED2] rounded-xl shadow-[0_1px_2px_rgba(20,30,25,0.04)] overflow-hidden">
        <div className="p-5 space-y-4">
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
            <div className="space-y-1.5 min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-[#18211D]">
                  {tournament.title}
                </h1>
                <span className="font-num px-2.5 py-0.5 rounded-md text-xs font-bold bg-[#FEF2F2] text-[#B91C1C] border border-[#FECACA]">
                  Bo{tournament.best_of} ({t.Tournaments.upToWins} {setsToWin}{' '}
                  {t.Tournaments.winsUnit})
                </span>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[#F1EDE4] text-[#53605A] border border-[#E3DED2]">
                  {t.Tournaments.status[tournament.status]}
                </span>
              </div>

              <p className="text-xs text-[#53605A]">
                {new Date(tournament.event_date).toLocaleString(
                  locale === 'ru' ? 'ru-RU' : 'en-US',
                  { dateStyle: 'medium', timeStyle: 'short' }
                )}{' '}
                • {tournament.type === 'singles' ? t.Tournaments.singles : t.Tournaments.doubles}
                {tournament.description ? ` • ${tournament.description}` : ''}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleExportCsv}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-[#E3DED2] bg-[#FAF8F4] hover:bg-[#F1EDE4] text-[#53605A] transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>CSV</span>
              </button>

              {isStaff && (
                <button
                  type="button"
                  onClick={() => setJuryViewEnabled(!juryViewEnabled)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    isJuryMode
                      ? 'bg-[#18211D] text-white border-[#18211D]'
                      : 'bg-white text-[#53605A] border-[#E3DED2] hover:bg-[#FAF8F4]'
                  }`}
                >
                  {isJuryMode ? (
                    <Unlock className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                  <span>
                    {isJuryMode
                      ? t.Nav.juryModeOn.replace(/^[^\wА-Яа-яЁё]+\s*/, '')
                      : t.Nav.juryModeOff.replace(/^[^\wА-Яа-яЁё]+\s*/, '')}
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* Stage tabs + sidebar toggle */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#EFECE4]">
            <div className="flex flex-wrap items-center gap-1.5">
              {stages.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setActiveStageId(s.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    currentStage?.id === s.id
                      ? 'bg-[#B91C1C] text-white'
                      : 'bg-[#F1EDE4] text-[#53605A] hover:text-[#18211D]'
                  }`}
                >
                  {t.TournamentDetail.stageTab} {s.stage_order}: {t.Staff.formats[s.format]}
                </button>
              ))}
            </div>

            {stageMatches.length > 0 && (
              <button
                type="button"
                onClick={() => setShowSidebar(!showSidebar)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-[#E3DED2] bg-[#FAF8F4] hover:bg-[#F1EDE4] text-[#53605A] transition-colors"
              >
                {showSidebar ? (
                  <PanelRightClose className="w-3.5 h-3.5" />
                ) : (
                  <PanelRightOpen className="w-3.5 h-3.5" />
                )}
                <span>
                  {showSidebar
                    ? t.TournamentDetail.hideSidebar.replace(/^[▶◀]\s*/, '')
                    : `${t.TournamentDetail.showSidebar.replace(/^[▶◀]\s*/, '')} (${freeTableNumbers.length}/8)`}
                </span>
              </button>
            )}
          </div>
        </div>

        {/* FULL-WIDTH CLEAN JURY TOOLBAR */}
        {isJuryMode && (
          <div className="bg-[#FAF8F4] border-t border-[#E3DED2] px-5 py-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#53605A]">
                {t.TournamentDetail.juryControls}
              </span>

              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-1.5 text-xs font-semibold cursor-pointer bg-[#FEF7E6] border border-[#EDD6A3] text-[#784A04] px-2.5 py-1 rounded-lg">
                  <input
                    type="checkbox"
                    checked={fastTestMode}
                    onChange={(e) => setFastTestMode(e.target.checked)}
                    className="accent-[#B91C1C]"
                  />
                  <FlaskConical className="w-3.5 h-3.5" />
                  <span>{t.TournamentDetail.fastTestMode.replace(/^[^\wА-Яа-яЁё]+\s*/, '')}</span>
                </label>

                <label className="inline-flex items-center gap-1.5 text-xs font-semibold cursor-pointer bg-white border border-[#E3DED2] text-[#53605A] px-2.5 py-1 rounded-lg">
                  <input
                    type="checkbox"
                    checked={manualSlotEditMode}
                    onChange={(e) => setManualSlotEditMode(e.target.checked)}
                    className="accent-[#B91C1C]"
                  />
                  <Pencil className="w-3.5 h-3.5" />
                  <span>{locale === 'ru' ? 'Слоты' : 'Slots'}</span>
                </label>

                {stageMatches.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowSwapBar(!showSwapBar)}
                    className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-lg border transition-colors ${
                      showSwapBar
                        ? 'bg-[#18211D] text-white border-[#18211D]'
                        : 'bg-white text-[#53605A] border-[#E3DED2] hover:bg-[#F1EDE4]'
                    }`}
                  >
                    <ArrowLeftRight className="w-3.5 h-3.5" />
                    <span>{locale === 'ru' ? 'Поменять местами' : 'Swap Players'}</span>
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2.5 items-end">
              <div>
                <label className="block text-[11px] font-semibold text-[#53605A] mb-1">
                  {t.TournamentDetail.changeStatus}
                </label>
                <select
                  value={tournament.status}
                  onChange={(e) => handleStatusChange(e.target.value as TournamentStatus)}
                  className="w-full border border-[#E3DED2] bg-white rounded-lg px-2.5 py-1.5 text-xs font-medium"
                >
                  <option value="scheduled">{t.Tournaments.status.scheduled}</option>
                  <option value="registration_open">
                    {t.Tournaments.status.registration_open}
                  </option>
                  <option value="check_in">{t.Tournaments.status.check_in}</option>
                  <option value="in_progress">{t.Tournaments.status.in_progress}</option>
                  <option value="completed">{t.Tournaments.status.completed}</option>
                </select>
              </div>

              {currentStage && (
                <div>
                  <label className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#53605A] mb-1">
                    <span>{t.TournamentDetail.stageFormat}</span>
                    {isStageStructureLocked && <Lock className="w-3 h-3 text-[#828E88]" />}
                  </label>
                  <select
                    disabled={isStageStructureLocked}
                    value={currentStage.format}
                    onChange={(e) =>
                      handleStageFormatChange(currentStage.id, e.target.value as StageFormat)
                    }
                    className="w-full border border-[#E3DED2] bg-white rounded-lg px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
                  >
                    <option value="single_elimination">
                      {t.Staff.formats.single_elimination}
                    </option>
                    <option value="double_elimination">
                      {t.Staff.formats.double_elimination}
                    </option>
                    <option value="round_robin">{t.Staff.formats.round_robin}</option>
                    <option value="swiss">{t.Staff.formats.swiss}</option>
                  </select>
                </div>
              )}

              <div>
                <label className="block text-[11px] font-semibold text-[#53605A] mb-1">
                  {locale === 'ru' ? 'Посев / Seeding' : 'Seeding'}
                </label>
                <select
                  value={seedingMode}
                  onChange={(e) => setSeedingMode(e.target.value as SeedingMode)}
                  className="w-full border border-[#E3DED2] bg-white rounded-lg px-2.5 py-1.5 text-xs font-medium"
                >
                  <option value="elo">По Эло (Elo)</option>
                  <option value="manual">Ручной (Seed #)</option>
                  <option value="random">Слепой жребий</option>
                </select>
              </div>

              {currentStage?.format === 'round_robin' && (
                <div>
                  <label className="block text-[11px] font-semibold text-[#53605A] mb-1">
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
                    className="w-full border border-[#E3DED2] bg-white rounded-lg px-2.5 py-1.5 text-xs font-num"
                  />
                </div>
              )}

              <div className="col-span-2 lg:col-span-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => runDrawGeneration(false)}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 ${
                    confirmRedraw
                      ? 'bg-[#C2412D] text-white hover:bg-[#A33322]'
                      : 'bg-[#B91C1C] text-white hover:bg-[#991B1B]'
                  }`}
                >
                  <Zap className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {busyAction === 'draw'
                      ? '...'
                      : confirmRedraw
                      ? locale === 'ru'
                        ? 'Подтвердить сброс и перегенерацию'
                        : 'Confirm Reset & Redraw'
                      : `${t.TournamentDetail.generateDrawBtn.replace(/^[^\wА-Яа-яЁё]+\s*/, '')} (${checkedInEntries.length})`}
                  </span>
                </button>

                {currentStage?.format === 'swiss' && stageMatches.length > 0 && (
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={handleNextSwissRound}
                    className="inline-flex items-center gap-1 bg-[#1D527C] text-white py-1.5 px-3 rounded-lg text-xs font-semibold hover:bg-[#163E5E] disabled:opacity-50"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>
                      {t.TournamentDetail.nextSwissRoundBtn.replace(/^\+\s*/, '')}
                    </span>
                  </button>
                )}

                {stageMatches.length > 0 && (
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={handleCompleteTournament}
                    className="inline-flex items-center gap-1.5 bg-[#B45309] text-white py-1.5 px-3 rounded-lg text-xs font-semibold hover:bg-[#92400E] disabled:opacity-50"
                  >
                    <Flag className="w-3.5 h-3.5" />
                    <span>
                      {t.TournamentDetail.finishTournamentBtn.replace(/^[^\wА-Яа-яЁё]+\s*/, '')}
                    </span>
                  </button>
                )}
              </div>
            </div>

            {showSwapBar && stageMatches.length > 0 && (
              <div className="pt-2.5 border-t border-[#E3DED2] flex flex-wrap items-center gap-2">
                <select
                  value={swapEntryA}
                  onChange={(e) => setSwapEntryA(e.target.value)}
                  className="flex-1 min-w-[160px] border border-[#E3DED2] bg-white rounded-lg px-2.5 py-1.5 text-xs"
                >
                  <option value="">Игрок А...</option>
                  {checkedInEntries.map((ce) => (
                    <option key={ce.id} value={ce.id}>
                      {formatEntryName(ce)}
                    </option>
                  ))}
                </select>
                <ArrowLeftRight className="w-3.5 h-3.5 text-[#828E88]" />
                <select
                  value={swapEntryB}
                  onChange={(e) => setSwapEntryB(e.target.value)}
                  className="flex-1 min-w-[160px] border border-[#E3DED2] bg-white rounded-lg px-2.5 py-1.5 text-xs"
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
                  disabled={busyAction !== null || !swapEntryA || !swapEntryB}
                  onClick={handleSwapPlayers}
                  className="bg-[#18211D] text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-[#2C3732] disabled:opacity-40"
                >
                  {locale === 'ru' ? 'Поменять' : 'Swap'}
                </button>
              </div>
            )}

            {engineMsg && (
              <p
                className={`text-xs font-semibold px-3 py-1.5 rounded-lg border ${
                  engineMsg.isError
                    ? 'bg-[#FBECE9] border-[#F0C9C2] text-[#C2412D]'
                    : 'bg-[#FEF2F2] border-[#FECACA] text-[#B91C1C]'
                }`}
              >
                {engineMsg.text}
              </p>
            )}
          </div>
        )}
      </section>

      {/* INTEGRITY DIAGNOSTIC BANNER (catches any pre-existing broken / duplicated brackets) */}
      {integrityIssues.length > 0 && (
        <div className="bg-[#FBECE9] border border-[#E5B4AC] rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-2 text-sm font-bold text-[#9C2F1E]">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                {locale === 'ru'
                  ? 'Обнаружены дубликаты или конфликт слотов в сетке'
                  : 'Bracket integrity issue detected'}
              </span>
            </div>
            <ul className="text-xs text-[#7D2416] space-y-0.5 pl-6 list-disc">
              {integrityIssues.slice(0, 4).map((issue, idx) => (
                <li key={idx}>{issue.message}</li>
              ))}
              {integrityIssues.length > 4 && (
                <li>
                  +{integrityIssues.length - 4}{' '}
                  {locale === 'ru' ? 'других замечаний' : 'more issues'}
                </li>
              )}
            </ul>
          </div>
          {isJuryMode && (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => runDrawGeneration(true)}
              className="shrink-0 bg-[#C2412D] text-white px-3.5 py-2 rounded-lg text-xs font-semibold hover:bg-[#A33322] disabled:opacity-50"
            >
              {locale === 'ru' ? 'Пересоздать чистую сетку' : 'Regenerate clean draw'}
            </button>
          )}
        </div>
      )}

      {/* 2. MAIN WORKSPACE */}
      {stageMatches.length > 0 && currentStage && (
        <div className="flex flex-col xl:flex-row gap-6 items-start">
          <div className="flex-1 min-w-0 w-full bg-white border border-[#E3DED2] rounded-xl p-5 shadow-[0_1px_2px_rgba(20,30,25,0.04)] space-y-6">
            <div className="flex flex-wrap justify-between items-center gap-2 border-b border-[#EFECE4] pb-3">
              <h2 className="text-base font-bold text-[#18211D]">
                {t.Staff.formats[currentStage.format]}
              </h2>
              {isJuryMode && (
                <span className="text-xs text-[#53605A]">
                  {manualSlotEditMode
                    ? locale === 'ru'
                      ? 'Режим слотов активен: выбор игрока меняет его местами с текущим'
                      : 'Slot edit active: picking a placed player swaps them cleanly'
                    : !fastTestMode
                    ? t.TournamentDetail.safeModeHint.replace(/^[^\wА-Яа-яЁё]+\s*/, '')
                    : t.TournamentDetail.fastModeHint.replace(/^[^\wА-Яа-яЁё]+\s*/, '')}
                </span>
              )}
            </div>

            {/* VIEW A: SINGLE & DOUBLE ELIMINATION */}
            {(currentStage.format === 'single_elimination' ||
              currentStage.format === 'double_elimination') && (
              <div className="space-y-8">
                <BracketView
                  bracketMatches={stageMatches.filter((m) => m.bracket_type === 'main')}
                  title={t.TournamentDetail.mainBracket}
                  locale={locale}
                  isJuryMode={isJuryMode}
                  fastTestMode={fastTestMode}
                  manualSlotEditMode={manualSlotEditMode}
                  checkedInEntries={checkedInEntries}
                  busyMatchId={busyMatchId}
                  flaggedMatchIds={flaggedMatchIds}
                  formatEntryName={formatEntryName}
                  onQuickWin={(m, slot) =>
                    handleQuickResult(m, slot === 1 ? setsToWin : 0, slot === 2 ? setsToWin : 0)
                  }
                  onUndoMatch={handleUndoMatch}
                  onDirectSlotAssign={handleDirectSlotAssign}
                  labels={{
                    round: t.TournamentDetail.round,
                    finalRound: t.TournamentDetail.finalRound.replace(/^[^\wА-Яа-яЁё]+\s*/, ''),
                    table: t.TournamentDetail.table,
                    waitingTable: t.TournamentDetail.waitingTable,
                    chooseWinner: t.TournamentDetail.chooseWinner,
                  }}
                />

                {currentStage.format === 'single_elimination' && (
                  <BracketView
                    bracketMatches={stageMatches.filter((m) => m.bracket_type === 'third_place')}
                    title={t.TournamentDetail.thirdPlaceMatch.replace(/^[^\wА-Яа-яЁё]+\s*/, '')}
                    locale={locale}
                    isJuryMode={isJuryMode}
                    fastTestMode={fastTestMode}
                    manualSlotEditMode={manualSlotEditMode}
                    checkedInEntries={checkedInEntries}
                    busyMatchId={busyMatchId}
                    flaggedMatchIds={flaggedMatchIds}
                    formatEntryName={formatEntryName}
                    onQuickWin={(m, slot) =>
                      handleQuickResult(
                        m,
                        slot === 1 ? setsToWin : 0,
                        slot === 2 ? setsToWin : 0
                      )
                    }
                    onUndoMatch={handleUndoMatch}
                    onDirectSlotAssign={handleDirectSlotAssign}
                    labels={{
                      round: t.TournamentDetail.round,
                      finalRound: t.TournamentDetail.finalRound.replace(/^[^\wА-Яа-яЁё]+\s*/, ''),
                      table: t.TournamentDetail.table,
                      waitingTable: t.TournamentDetail.waitingTable,
                      chooseWinner: t.TournamentDetail.chooseWinner,
                    }}
                  />
                )}

                {currentStage.format === 'double_elimination' && (
                  <>
                    <BracketView
                      bracketMatches={stageMatches.filter((m) => m.bracket_type === 'losers')}
                      title={t.TournamentDetail.losersBracket}
                      locale={locale}
                      isJuryMode={isJuryMode}
                      fastTestMode={fastTestMode}
                      manualSlotEditMode={manualSlotEditMode}
                      checkedInEntries={checkedInEntries}
                      busyMatchId={busyMatchId}
                      flaggedMatchIds={flaggedMatchIds}
                      formatEntryName={formatEntryName}
                      onQuickWin={(m, slot) =>
                        handleQuickResult(
                          m,
                          slot === 1 ? setsToWin : 0,
                          slot === 2 ? setsToWin : 0
                        )
                      }
                      onUndoMatch={handleUndoMatch}
                      onDirectSlotAssign={handleDirectSlotAssign}
                      labels={{
                        round: t.TournamentDetail.round,
                        finalRound: t.TournamentDetail.finalRound.replace(/^[^\wА-Яа-яЁё]+\s*/, ''),
                        table: t.TournamentDetail.table,
                        waitingTable: t.TournamentDetail.waitingTable,
                        chooseWinner: t.TournamentDetail.chooseWinner,
                      }}
                    />
                    <BracketView
                      bracketMatches={stageMatches.filter((m) => m.bracket_type === 'grand_final')}
                      title={t.TournamentDetail.grandFinal.replace(/^[^\wА-Яа-яЁё]+\s*/, '')}
                      locale={locale}
                      isJuryMode={isJuryMode}
                      fastTestMode={fastTestMode}
                      manualSlotEditMode={manualSlotEditMode}
                      checkedInEntries={checkedInEntries}
                      busyMatchId={busyMatchId}
                      flaggedMatchIds={flaggedMatchIds}
                      formatEntryName={formatEntryName}
                      onQuickWin={(m, slot) =>
                        handleQuickResult(
                          m,
                          slot === 1 ? setsToWin : 0,
                          slot === 2 ? setsToWin : 0
                        )
                      }
                      onUndoMatch={handleUndoMatch}
                      onDirectSlotAssign={handleDirectSlotAssign}
                      labels={{
                        round: t.TournamentDetail.round,
                        finalRound: t.TournamentDetail.finalRound.replace(/^[^\wА-Яа-яЁё]+\s*/, ''),
                        table: t.TournamentDetail.table,
                        waitingTable: t.TournamentDetail.waitingTable,
                        chooseWinner: t.TournamentDetail.chooseWinner,
                      }}
                    />
                  </>
                )}
              </div>
            )}

            {/* VIEW B: ROUND ROBIN GROUPS */}
            {currentStage.format === 'round_robin' && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {distinctGroups.map((gNum) => {
                  const gMatches = stageMatches.filter((m) => (m.group_number || 1) === gNum);
                  const gStandings = liveStandings.filter((r) => r.groupNumber === gNum);
                  const advanceCountForThisGroup = groupAdvanceMap[gNum] ?? 2;

                  return (
                    <div
                      key={gNum}
                      className="border border-[#E3DED2] rounded-xl p-4 bg-[#FAF8F4]/70 space-y-3.5"
                    >
                      <div className="flex justify-between items-center">
                        <h3 className="font-bold text-sm text-[#B91C1C]">
                          {t.TournamentDetail.group} #{gNum}
                        </h3>
                        {isJuryMode && (
                          <label className="flex items-center gap-1.5 text-xs text-[#53605A]">
                            <span>{t.TournamentDetail.advanceFromGroup}</span>
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
                              className="w-12 border border-[#E3DED2] bg-white rounded-md px-1.5 py-0.5 text-center font-num font-bold text-[#B91C1C]"
                            />
                          </label>
                        )}
                      </div>

                      <div className="overflow-x-auto thin-scroll bg-white border border-[#E3DED2] rounded-lg">
                        <table className="w-full text-xs text-left border-collapse">
                          <thead className="bg-[#F7F5F0] text-[#53605A] text-[11px]">
                            <tr>
                              <th className="p-2 border-b border-r border-[#EFECE4]">#</th>
                              <th className="p-2 border-b border-r border-[#EFECE4]">
                                {t.Staff.fullName}
                              </th>
                              {gStandings.map((_, idx) => (
                                <th
                                  key={idx}
                                  className="p-2 border-b border-r border-[#EFECE4] text-center w-8 font-num"
                                >
                                  {idx + 1}
                                </th>
                              ))}
                              <th className="p-2 border-b border-r border-[#EFECE4] text-center">
                                W-L
                              </th>
                              <th className="p-2 border-b border-[#EFECE4] text-center">Sets</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#EFECE4]">
                            {gStandings.map((row, rIdx) => {
                              const isQualifying = qualifiedIdSet.has(row.entry.id);
                              return (
                                <tr
                                  key={row.entry.id}
                                  className={isQualifying ? 'bg-[#FEF2F2]/60' : ''}
                                >
                                  <td
                                    className={`p-2 border-r border-[#EFECE4] font-num font-bold ${
                                      isQualifying
                                        ? 'border-l-2 border-l-[#B91C1C] text-[#B91C1C]'
                                        : 'text-[#828E88]'
                                    }`}
                                  >
                                    {rIdx + 1}
                                  </td>
                                  <td className="p-2 border-r border-[#EFECE4] font-medium text-[#18211D] truncate max-w-[135px]">
                                    {formatEntryName(row.entry)}
                                  </td>
                                  {gStandings.map((col, cIdx) => {
                                    if (rIdx === cIdx) {
                                      return (
                                        <td
                                          key={cIdx}
                                          className="p-2 border-r border-[#EFECE4] bg-[#F1EDE4]"
                                        />
                                      );
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
                                          className="p-2 border-r border-[#EFECE4] text-center text-[#CCC5B6] font-num"
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
                                        className={`p-2 border-r border-[#EFECE4] text-center font-num font-bold ${
                                          myS > oppS ? 'text-[#B91C1C]' : 'text-[#C2412D]'
                                        }`}
                                      >
                                        {myS}:{oppS}
                                      </td>
                                    );
                                  })}
                                  <td className="p-2 border-r border-[#EFECE4] text-center font-num font-semibold text-[#18211D]">
                                    {row.wins}-{row.losses}
                                  </td>
                                  <td className="p-2 text-center font-num text-[#53605A]">
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
                            busyMatchId !== m.id &&
                            (fastTestMode ||
                              m.status === 'in_progress' ||
                              m.status === 'completed');
                          return (
                            <div
                              key={m.id}
                              className={`border rounded-lg px-3 py-2 bg-white flex flex-wrap justify-between items-center gap-2 text-xs ${
                                m.status === 'in_progress'
                                  ? 'border-[#B91C1C] ring-1 ring-[#B91C1C]/15'
                                  : m.status === 'completed'
                                  ? 'border-[#FECACA]'
                                  : 'border-[#E3DED2]'
                              }`}
                            >
                              <div className="truncate max-w-[210px]">
                                <span
                                  className={
                                    m.winner_entry_id === m.entry1_id
                                      ? 'font-bold text-[#B91C1C]'
                                      : 'text-[#18211D]'
                                  }
                                >
                                  {formatEntryName(m.entry1)}
                                </span>{' '}
                                <span className="text-[#828E88]">vs</span>{' '}
                                <span
                                  className={
                                    m.winner_entry_id === m.entry2_id
                                      ? 'font-bold text-[#B91C1C]'
                                      : 'text-[#18211D]'
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
                                      type="button"
                                      disabled={!canScore}
                                      onClick={() => handleQuickResult(m, s1, s2)}
                                      className={`px-2 py-0.5 rounded-md font-num text-[11px] font-semibold transition-colors ${
                                        isSelected
                                          ? 'bg-[#B91C1C] text-white'
                                          : canScore
                                          ? 'bg-[#F1EDE4] hover:bg-[#B91C1C] hover:text-white text-[#53605A]'
                                          : 'bg-[#FAF8F4] text-[#CCC5B6] cursor-default'
                                      }`}
                                    >
                                      {s1}:{s2}
                                    </button>
                                  );
                                })}
                                {isJuryMode && m.status === 'completed' && (
                                  <button
                                    type="button"
                                    disabled={busyMatchId === m.id}
                                    onClick={() => handleUndoMatch(m)}
                                    title="Undo"
                                    className="ml-1 text-[#C2412D] hover:opacity-75 p-0.5"
                                  >
                                    <RotateCcw className="w-3.5 h-3.5" />
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
                      <div
                        key={rNum}
                        className="border border-[#E3DED2] rounded-xl p-4 bg-[#FAF8F4]/70 space-y-3"
                      >
                        <h3 className="font-bold text-xs uppercase tracking-wider text-[#B91C1C]">
                          {t.TournamentDetail.round} {rNum}
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                          {rMatches.map((m) => {
                            const canScore =
                              isJuryMode &&
                              busyMatchId !== m.id &&
                              (fastTestMode ||
                                m.status === 'in_progress' ||
                                m.status === 'completed');
                            return (
                              <div
                                key={m.id}
                                className={`bg-white border rounded-lg p-2.5 flex justify-between items-center gap-2 text-xs ${
                                  m.status === 'in_progress'
                                    ? 'border-[#B91C1C] ring-1 ring-[#B91C1C]/15'
                                    : m.status === 'completed'
                                    ? 'border-[#FECACA]'
                                    : 'border-[#E3DED2]'
                                }`}
                              >
                                <div className="truncate">
                                  <span
                                    className={
                                      m.winner_entry_id === m.entry1_id
                                        ? 'font-bold text-[#B91C1C]'
                                        : 'text-[#18211D]'
                                    }
                                  >
                                    {formatEntryName(m.entry1)}
                                  </span>{' '}
                                  <span className="text-[#828E88]">vs</span>{' '}
                                  <span
                                    className={
                                      m.winner_entry_id === m.entry2_id
                                        ? 'font-bold text-[#B91C1C]'
                                        : 'text-[#18211D]'
                                    }
                                  >
                                    {formatEntryName(m.entry2)}
                                  </span>
                                </div>

                                {m.status === 'walkover' ? (
                                  <span className="font-num text-[#B91C1C] bg-[#FEF2F2] px-2 py-0.5 rounded font-bold shrink-0">
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
                                          type="button"
                                          disabled={!canScore}
                                          onClick={() => handleQuickResult(m, s1, s2)}
                                          className={`px-2 py-0.5 rounded-md font-num text-[11px] font-semibold transition-colors ${
                                            isSelected
                                              ? 'bg-[#B91C1C] text-white'
                                              : canScore
                                              ? 'bg-[#F1EDE4] hover:bg-[#B91C1C] hover:text-white text-[#53605A]'
                                              : 'bg-[#FAF8F4] text-[#CCC5B6] cursor-default'
                                          }`}
                                        >
                                          {s1}:{s2}
                                        </button>
                                      );
                                    })}
                                    {isJuryMode && m.status === 'completed' && (
                                      <button
                                        type="button"
                                        disabled={busyMatchId === m.id}
                                        onClick={() => handleUndoMatch(m)}
                                        title="Undo"
                                        className="ml-1 text-[#C2412D] hover:opacity-75 p-0.5"
                                      >
                                        <RotateCcw className="w-3.5 h-3.5" />
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
            <aside className="w-full xl:w-[340px] shrink-0 space-y-4">
              {isGroupOrSwiss && (
                <div className="bg-white border border-[#E3DED2] rounded-xl p-4 shadow-[0_1px_2px_rgba(20,30,25,0.04)] space-y-3">
                  <div className="flex justify-between items-center">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-[#53605A]">
                      {t.TournamentDetail.standingsTitle.replace(/^[^\wА-Яа-яЁё]+\s*/, '')}
                    </h3>
                    <span className="font-num text-[11px] font-semibold text-[#B91C1C] bg-[#FEF2F2] border border-[#FECACA] px-2 py-0.5 rounded-md">
                      {t.TournamentDetail.qualifyingCount}: {predictedQualifiers.length}
                    </span>
                  </div>

                  {isSwiss && isJuryMode && (
                    <div className="flex items-center justify-between bg-[#FAF8F4] p-2 rounded-lg border border-[#E3DED2] text-xs">
                      <span className="font-medium text-[#53605A]">
                        {t.TournamentDetail.swissTopLabel}
                      </span>
                      <div className="flex gap-1">
                        {[2, 4, 6, 8].map((n) => (
                          <button
                            key={n}
                            type="button"
                            onClick={() => setSwissAdvanceCount(n)}
                            className={`px-2 py-0.5 rounded font-num font-bold transition-colors ${
                              swissAdvanceCount === n
                                ? 'bg-[#B91C1C] text-white'
                                : 'bg-white border border-[#E3DED2] text-[#53605A]'
                            }`}
                          >
                            {t.TournamentDetail.top}-{n}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="max-h-60 overflow-y-auto thin-scroll border border-[#E3DED2] rounded-lg">
                    <table className="w-full text-[11px] text-left border-collapse">
                      <thead className="bg-[#F7F5F0] border-b border-[#E3DED2] text-[#53605A] sticky top-0">
                        <tr>
                          <th className="p-2">#</th>
                          <th className="p-2">{t.Staff.fullName}</th>
                          <th className="p-2 text-center">W-L</th>
                          <th className="p-2 text-center">Diff</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#EFECE4]">
                        {liveStandings.map((row, idx) => {
                          const qualifies = qualifiedIdSet.has(row.entry.id);
                          return (
                            <tr
                              key={row.entry.id}
                              className={qualifies ? 'bg-[#FEF2F2]/70 font-medium' : ''}
                            >
                              <td
                                className={`p-2 font-num font-bold ${
                                  qualifies
                                    ? 'border-l-2 border-l-[#B91C1C] text-[#B91C1C]'
                                    : 'text-[#828E88]'
                                }`}
                              >
                                {isSwiss ? idx + 1 : `G${row.groupNumber}-${row.rankInGroup}`}
                              </td>
                              <td className="p-2 truncate max-w-[140px] text-[#18211D]">
                                {formatEntryName(row.entry)}
                              </td>
                              <td className="p-2 text-center font-num font-bold">
                                {row.wins}-{row.losses}
                              </td>
                              <td className="p-2 text-center font-num text-[#53605A]">
                                {row.setDiff > 0 ? `+${row.setDiff}` : row.setDiff}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {isJuryMode && (
                    <div className="pt-2 border-t border-[#EFECE4] space-y-2">
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-[#53605A]">
                          {t.TournamentDetail.stage2FormatLabel}
                        </span>
                        <select
                          value={stage2Format}
                          onChange={(e) => setStage2Format(e.target.value as StageFormat)}
                          className="border border-[#E3DED2] rounded-lg px-2 py-1 text-xs font-medium bg-white"
                        >
                          <option value="single_elimination">Single Elimination</option>
                          <option value="double_elimination">Double Elimination</option>
                        </select>
                      </div>
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={handleAdvanceToStage2}
                        className="w-full bg-[#B91C1C] text-white py-2 rounded-lg text-xs font-bold hover:bg-[#991B1B] disabled:opacity-50 transition-colors"
                      >
                        {t.TournamentDetail.createStage2Btn.replace(/^[^\wА-Яа-яЁё]+\s*/, '')} (
                        {predictedQualifiers.length})
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* COMPACT 8-TABLE COURT DISPATCHER */}
              <div className="bg-white border border-[#E3DED2] rounded-xl p-4 shadow-[0_1px_2px_rgba(20,30,25,0.04)] space-y-3.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[#53605A]">
                    {t.TournamentDetail.tablesTitle.replace(/^[^\wА-Яа-яЁё]+\s*/, '')}
                  </h3>
                  <span className="font-num text-[11px] font-semibold px-2 py-0.5 rounded-md bg-[#F1EDE4] text-[#B91C1C]">
                    {t.TournamentDetail.free}: {freeTableNumbers.length}/8
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {Array.from({ length: TOTAL_TABLES }, (_, i) => i + 1).map((tNum) => {
                    const active = occupiedTables.get(tNum);
                    return (
                      <div
                        key={tNum}
                        className={`border rounded-lg p-2.5 text-[11px] transition-colors ${
                          active
                            ? 'bg-[#FEF2F2]/80 border-[#B91C1C]/45 border-t-2 border-t-[#B91C1C]'
                            : 'bg-[#FAF8F4] border-[#E3DED2]'
                        }`}
                      >
                        <div className="flex justify-between items-center font-bold mb-1">
                          <span className="inline-flex items-center gap-1 font-num text-[#18211D]">
                            {active && (
                              <CircleDot className="w-2.5 h-2.5 text-[#B91C1C] animate-pulse" />
                            )}
                            #{tNum}
                          </span>
                          {active && isJuryMode ? (
                            <button
                              type="button"
                              onClick={() => handleAssignTable(active.id, null)}
                              className="text-[10px] font-semibold text-[#C2412D] hover:underline"
                            >
                              {t.TournamentDetail.releaseTable}
                            </button>
                          ) : !active ? (
                            <span className="text-[10px] font-medium text-[#B91C1C]">
                              {t.TournamentDetail.tableFree}
                            </span>
                          ) : null}
                        </div>
                        {active ? (
                          <div className="truncate text-[#18211D] leading-snug">
                            <div className="truncate font-medium">
                              {formatEntryName(active.entry1)}
                            </div>
                            <div className="truncate text-[#53605A]">
                              vs {formatEntryName(active.entry2)}
                            </div>
                          </div>
                        ) : (
                          <div className="text-[#828E88] text-[10px]">
                            {t.TournamentDetail.waitingPair}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {isJuryMode && (
                  <div className="border-t border-[#EFECE4] pt-3 space-y-2">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-[#53605A]">
                      {t.TournamentDetail.callQueue.replace(/^[^\wА-Яа-яЁё]+\s*/, '')} (
                      {readyQueue.length})
                    </p>
                    <div className="max-h-56 overflow-y-auto thin-scroll space-y-1.5 pr-1">
                      {readyQueue.slice(0, 8).map((m) => (
                        <div
                          key={m.id}
                          className="border border-[#E3DED2] rounded-lg p-2.5 bg-[#FAF8F4] text-[11px] space-y-1.5"
                        >
                          <div className="font-semibold text-[#18211D] truncate">
                            {formatEntryName(m.entry1)}{' '}
                            <span className="text-[#828E88] font-normal">vs</span>{' '}
                            {formatEntryName(m.entry2)}
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {freeTableNumbers.length > 0 ? (
                              freeTableNumbers.map((tNum) => (
                                <button
                                  key={tNum}
                                  type="button"
                                  onClick={() => handleAssignTable(m.id, tNum)}
                                  className="bg-[#B91C1C] text-white px-2 py-0.5 rounded font-num text-[10px] font-semibold hover:bg-[#991B1B] transition-colors"
                                >
                                  → #{tNum}
                                </button>
                              ))
                            ) : (
                              <span className="text-[#92580A] text-[10px]">
                                {t.TournamentDetail.allTablesBusy}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                      {readyQueue.length === 0 && (
                        <p className="text-[11px] text-[#828E88]">
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
        <section className="bg-white border border-[#E3DED2] rounded-xl p-6 shadow-[0_1px_2px_rgba(20,30,25,0.04)] space-y-4">
          <div className="flex flex-wrap justify-between items-center gap-3 border-b border-[#EFECE4] pb-3">
            <h2 className="text-base font-bold text-[#18211D]">
              {t.TournamentDetail.registrationTitle}
            </h2>
            {isJuryMode && (
              <button
                type="button"
                onClick={() => setShowCsvImport(!showCsvImport)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-[#E3DED2] bg-[#FAF8F4] hover:bg-[#F1EDE4] text-[#53605A]"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span>
                  {t.TournamentDetail.csvImportTitle.replace(/^[^\wА-Яа-яЁё]+\s*/, '')}
                </span>
              </button>
            )}
          </div>

          {showCsvImport && isJuryMode && (
            <div className="bg-[#FAF8F4] border border-[#E3DED2] rounded-xl p-4 space-y-3">
              <p className="text-[11px] text-[#53605A]">
                {locale === 'ru'
                  ? 'Уровень задаёт стартовый Эло для новых игроков: beginner = 800 · amateur = 1000 · intermediate = 1200 · advanced = 1400 (у существующих рейтинг сохраняется).'
                  : 'Level sets starting Elo for new players: beginner = 800 · amateur = 1000 · intermediate = 1200 · advanced = 1400 (existing players keep their earned Elo).'}
              </p>
              <textarea
                rows={4}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder={t.TournamentDetail.csvPlaceholder}
                className="w-full border border-[#E3DED2] bg-white rounded-lg p-2.5 text-xs font-mono"
              />
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={handleCsvImport}
                className="bg-[#B91C1C] text-white px-4 py-1.5 rounded-lg text-xs font-semibold hover:bg-[#991B1B] disabled:opacity-50"
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

            <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
              {isJuryMode ? (
                <label className="flex items-center gap-2 text-sm text-[#53605A] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checkInImmediately}
                    onChange={(e) => setCheckInImmediately(e.target.checked)}
                    className="rounded border-[#CCC5B6] accent-[#B91C1C]"
                  />
                  <span>{t.TournamentDetail.checkInImmediately}</span>
                </label>
              ) : (
                <div />
              )}

              <div className="flex items-center gap-3">
                {regMessage && (
                  <span className="text-sm font-medium text-[#B91C1C]">{regMessage}</span>
                )}
                <button
                  type="submit"
                  disabled={
                    busyAction !== null ||
                    !player1 ||
                    (tournament.type === 'doubles' && !player2)
                  }
                  className="bg-[#B91C1C] text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-[#991B1B] transition-colors disabled:opacity-50"
                >
                  {t.TournamentDetail.registerBtn}
                </button>
              </div>
            </div>
          </form>
        </section>
      )}

      {/* 4. PARTICIPANTS & CHECK-IN + MANUAL SEED ORDER */}
      <section className="bg-white border border-[#E3DED2] rounded-xl p-6 shadow-[0_1px_2px_rgba(20,30,25,0.04)] space-y-4">
        <div className="flex flex-wrap justify-between items-center gap-4">
          <h2 className="text-base font-bold text-[#18211D]">
            {t.TournamentDetail.participantsTitle}
          </h2>
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            {entries.length > 6 && (
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[#828E88] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={participantSearch}
                  onChange={(e) => setParticipantSearch(e.target.value)}
                  placeholder={t.Leaderboard.searchPlaceholder}
                  className="border border-[#E3DED2] bg-[#FAF8F4] rounded-lg pl-7 pr-2.5 py-1 text-xs"
                />
              </div>
            )}
            <span className="px-3 py-1 bg-[#F1EDE4] text-[#53605A] rounded-full font-medium">
              {t.TournamentDetail.totalRegistered}:{' '}
              <strong className="font-num text-[#18211D]">{entries.length}</strong>
            </span>
            <span className="px-3 py-1 bg-[#FEF2F2] text-[#B91C1C] border border-[#FECACA] rounded-full font-medium">
              {t.TournamentDetail.checkedInCount}:{' '}
              <strong className="font-num">{checkedInEntries.length}</strong>
            </span>
          </div>
        </div>

        <div className="overflow-x-auto thin-scroll border border-[#E3DED2] rounded-xl">
          <table className="w-full text-sm text-left border-collapse">
            <thead className="bg-[#F7F5F0] border-b border-[#E3DED2] text-[11px] uppercase tracking-wider text-[#53605A]">
              <tr>
                <th className="p-3 font-semibold">Seed #</th>
                <th className="p-3 font-semibold">{t.Staff.fullName}</th>
                <th className="p-3 font-semibold">Seed Elo</th>
                <th className="p-3 font-semibold">{t.TournamentDetail.changeStatus}</th>
                {isJuryMode && <th className="p-3 text-right font-semibold">Check-In</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EFECE4]">
              {filteredEntries.map((entry, idx) => (
                <tr key={entry.id} className="hover:bg-[#FAF8F4]">
                  <td className="p-3 text-[#828E88] w-24 font-num">
                    {isJuryMode ? (
                      <input
                        type="number"
                        min={1}
                        value={entry.seed_number ?? idx + 1}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) =>
                          handleSeedNumberChange(entry.id, Number(e.target.value))
                        }
                        className="w-14 border border-[#E3DED2] bg-white rounded-md px-1.5 py-0.5 text-xs font-bold text-center text-[#18211D]"
                        title="Задайте номер посева вручную и выберите «Ручной (Seed #)» при генерации сетки"
                      />
                    ) : (
                      entry.seed_number ?? idx + 1
                    )}
                  </td>
                  <td className="p-3 font-medium text-[#18211D]">
                    {entry.final_placement === 1 && '🥇 '}
                    {entry.final_placement === 2 && '🥈 '}
                    {entry.final_placement === 3 && '🥉 '}
                    {formatEntryName(entry)}
                  </td>
                  <td className="p-3 font-num font-semibold text-[#B91C1C]">
                    {entry.seed_elo}
                  </td>
                  <td className="p-3">
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${
                        entry.attendance === 'checked_in'
                          ? 'bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]'
                          : entry.attendance === 'no_show'
                          ? 'bg-[#FBECE9] text-[#C2412D] border-[#F0C9C2]'
                          : 'bg-[#F1EDE4] text-[#53605A] border-[#E3DED2]'
                      }`}
                    >
                      {t.TournamentDetail.attendance[entry.attendance]}
                    </span>
                  </td>
                  {isJuryMode && (
                    <td className="p-3 text-right whitespace-nowrap space-x-1.5">
                      <button
                        type="button"
                        onClick={() => handleAttendanceChange(entry.id, 'checked_in')}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                          entry.attendance === 'checked_in'
                            ? 'bg-[#B91C1C] text-white'
                            : 'bg-[#F1EDE4] hover:bg-[#FEF2F2] text-[#53605A]'
                        }`}
                      >
                        <Check className="w-3 h-3" />
                        <span>{t.TournamentDetail.markCheckedIn}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAttendanceChange(entry.id, 'no_show')}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                          entry.attendance === 'no_show'
                            ? 'bg-[#C2412D] text-white'
                            : 'bg-[#F1EDE4] hover:bg-[#FBECE9] text-[#53605A]'
                        }`}
                      >
                        <X className="w-3 h-3" />
                        <span>{t.TournamentDetail.markNoShow}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteEntry(entry.id)}
                        title={t.TournamentDetail.remove}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs text-[#828E88] hover:text-[#C2412D]"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
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