'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { Plus, UserPlus, GitMerge, Search, ShieldAlert, Check } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useLanguage } from '@/components/LanguageProvider';
import { useAuth } from '@/components/AuthProvider';
import { Player, PlayerCategory, MatchType, StageFormat } from '@/types/database';

export default function StaffDashboardPage() {
  const { locale, t } = useLanguage();
  const { isStaff, loadingAuth } = useAuth();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [matchType, setMatchType] = useState<MatchType>('singles');
  const [bestOf, setBestOf] = useState<number>(3);
  const [initialFormat, setInitialFormat] = useState<StageFormat>('single_elimination');
  const [tournamentMsg, setTournamentMsg] = useState<string | null>(null);

  const [players, setPlayers] = useState<Player[]>([]);
  const [playerSearch, setPlayerSearch] = useState('');
  const [fullName, setFullName] = useState('');
  const [universityId, setUniversityId] = useState('');
  const [category, setCategory] = useState<PlayerCategory>('student');
  const [initialElo, setInitialElo] = useState<number>(1000);
  const [eloEdits, setEloEdits] = useState<Record<string, number>>({});
  const [playerMsg, setPlayerMsg] = useState<string | null>(null);

  const [duplicateId, setDuplicateId] = useState('');
  const [targetId, setTargetId] = useState('');

  const fetchPlayers = async () => {
    const { data } = await supabase
      .from('players')
      .select('*')
      .order('elo_rating', { ascending: false });

    if (data) {
      setPlayers(data as Player[]);
      const initialMap: Record<string, number> = {};
      data.forEach((p: Player) => {
        initialMap[p.id] = p.elo_rating;
      });
      setEloEdits(initialMap);
    }
  };

  useEffect(() => {
    fetchPlayers();
  }, []);

  if (loadingAuth) {
    return <div className="p-8 text-center text-sm text-[#828E88]">Loading...</div>;
  }

  if (!isStaff) {
    return (
      <div className="max-w-md mx-auto mt-16 p-6 bg-white border border-[#E3DED2] rounded-xl text-center space-y-4 shadow-[0_1px_2px_rgba(20,30,25,0.04)]">
        <ShieldAlert className="w-8 h-8 text-[#C2412D] mx-auto" />
        <p className="font-semibold text-[#18211D]">Доступ только для Жюри / Staff Access Only</p>
        <Link
          href="/login"
          className="inline-block bg-[#14533C] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#0E3E2C]"
        >
          Войти / Login
        </Link>
      </div>
    );
  }

  const handleCreateTournament = async (e: React.FormEvent) => {
    e.preventDefault();
    setTournamentMsg(null);

    const { data: newTournament, error: tError } = await supabase
      .from('tournaments')
      .insert({
        title,
        description: description.trim() || null,
        event_date: new Date(eventDate).toISOString(),
        type: matchType,
        best_of: bestOf,
        status: 'scheduled',
      })
      .select()
      .single();

    if (tError || !newTournament) {
      setTournamentMsg(`Error: ${tError?.message}`);
      return;
    }

    const { error: sError } = await supabase.from('tournament_stages').insert({
      tournament_id: newTournament.id,
      stage_order: 1,
      name: 'Stage 1',
      format: initialFormat,
      status: 'pending',
    });

    if (sError) {
      setTournamentMsg(`Error: ${sError.message}`);
      return;
    }

    setTitle('');
    setDescription('');
    setEventDate('');
    setTournamentMsg('✓ Турнир успешно создан!');
  };

  const handleAddPlayer = async (e: React.FormEvent) => {
    e.preventDefault();
    setPlayerMsg(null);

    const { error } = await supabase.from('players').insert({
      full_name: fullName.trim(),
      university_id: universityId.trim() || null,
      category,
      elo_rating: initialElo,
    });

    if (error) {
      setPlayerMsg(`Error: ${error.message}`);
      return;
    }

    setFullName('');
    setUniversityId('');
    setInitialElo(1000);
    setPlayerMsg('✓ Игрок добавлен!');
    fetchPlayers();
  };

  const handleUpdateElo = async (player: Player) => {
    const newElo = eloEdits[player.id];
    if (newElo === undefined || newElo === player.elo_rating) return;

    const { error } = await supabase
      .from('players')
      .update({ elo_rating: newElo })
      .eq('id', player.id);

    if (!error) {
      await supabase.from('rating_logs').insert({
        player_id: player.id,
        elo_before: player.elo_rating,
        elo_after: newElo,
        reason: 'Manual Jury calibration',
      });
      fetchPlayers();
    }
  };

  const handleMergePlayers = async () => {
    if (!duplicateId || !targetId || duplicateId === targetId) return;
    setPlayerMsg(null);

    try {
      const dupPlayer = players.find((p) => p.id === duplicateId);
      const targetPlayer = players.find((p) => p.id === targetId);
      if (!dupPlayer || !targetPlayer) return;

      const { data: allEntries, error: fetchErr } = await supabase
        .from('tournament_entries')
        .select('*')
        .or(
          `player1_id.eq.${duplicateId},player2_id.eq.${duplicateId},player1_id.eq.${targetId},player2_id.eq.${targetId}`
        );

      if (fetchErr) throw new Error(fetchErr.message);

      const entriesList = allEntries || [];

      const dupAsPlayer1 = entriesList.filter((e) => e.player1_id === duplicateId);

      for (const dupEntry of dupAsPlayer1) {
        const existingTargetEntry = entriesList.find(
          (e) =>
            e.tournament_id === dupEntry.tournament_id &&
            e.player1_id === targetId &&
            e.id !== dupEntry.id
        );

        if (existingTargetEntry) {
          await supabase
            .from('matches')
            .update({ entry1_id: existingTargetEntry.id })
            .eq('entry1_id', dupEntry.id);
          await supabase
            .from('matches')
            .update({ entry2_id: existingTargetEntry.id })
            .eq('entry2_id', dupEntry.id);
          await supabase
            .from('matches')
            .update({ winner_entry_id: existingTargetEntry.id })
            .eq('winner_entry_id', dupEntry.id);

          const { error: delEntryErr } = await supabase
            .from('tournament_entries')
            .delete()
            .eq('id', dupEntry.id);
          if (delEntryErr) throw new Error(delEntryErr.message);
        } else if (dupEntry.player2_id === targetId) {
          const { error: selfErr } = await supabase
            .from('tournament_entries')
            .update({ player1_id: targetId, player2_id: null })
            .eq('id', dupEntry.id);
          if (selfErr) throw new Error(selfErr.message);
        } else {
          const { error: updErr } = await supabase
            .from('tournament_entries')
            .update({ player1_id: targetId })
            .eq('id', dupEntry.id);
          if (updErr) throw new Error(updErr.message);
        }
      }

      const dupAsPlayer2 = entriesList.filter((e) => e.player2_id === duplicateId);

      for (const dupEntry of dupAsPlayer2) {
        if (dupEntry.player1_id === targetId) {
          const { error: p2SelfErr } = await supabase
            .from('tournament_entries')
            .update({ player2_id: null })
            .eq('id', dupEntry.id);
          if (p2SelfErr) throw new Error(p2SelfErr.message);
        } else {
          const { error: p2UpdErr } = await supabase
            .from('tournament_entries')
            .update({ player2_id: targetId })
            .eq('id', dupEntry.id);
          if (p2UpdErr) throw new Error(p2UpdErr.message);
        }
      }

      await supabase
        .from('rating_logs')
        .update({ player_id: targetId })
        .eq('player_id', duplicateId);

      await supabase
        .from('players')
        .update({
          wins: targetPlayer.wins + dupPlayer.wins,
          losses: targetPlayer.losses + dupPlayer.losses,
        })
        .eq('id', targetId);

      const { error: deletePlayerErr } = await supabase
        .from('players')
        .delete()
        .eq('id', duplicateId);

      if (deletePlayerErr) throw new Error(deletePlayerErr.message);

      setDuplicateId('');
      setTargetId('');
      setPlayerMsg('✓ Дубликат успешно объединён с основным профилем!');
      fetchPlayers();
    } catch (err: unknown) {
      setPlayerMsg(
        `Ошибка объединения: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    }
  };

  const filteredPlayers = players.filter((p) => {
    const q = playerSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      p.full_name.toLowerCase().includes(q) ||
      (p.university_id && p.university_id.toLowerCase().includes(q))
    );
  });

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <div className="pb-5 border-b border-[#E3DED2] space-y-1">
        <p className="text-[11px] font-bold uppercase tracking-widest text-[#14533C]">
          NUTTC Operations
        </p>
        <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-[#18211D]">
          {t.Staff.title}
        </h1>
      </div>

      {/* SECTION 1: CREATE TOURNAMENT */}
      <section className="bg-white p-6 rounded-xl border border-[#E3DED2] shadow-[0_1px_2px_rgba(20,30,25,0.04)] space-y-5">
        <div className="flex items-center justify-between border-b border-[#EFECE4] pb-3">
          <h2 className="text-lg font-bold text-[#18211D]">{t.Staff.createTournament}</h2>
        </div>

        <form onSubmit={handleCreateTournament} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-[#53605A] mb-1.5">
              {t.Staff.tournamentTitle}
            </label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="NUTTC Open Cup #1"
              className="w-full border border-[#E3DED2] bg-[#FAF8F4] rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#53605A] mb-1.5">
              {t.Staff.eventDate}
            </label>
            <input
              type="datetime-local"
              required
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
              className="w-full border border-[#E3DED2] bg-[#FAF8F4] rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#53605A] mb-1.5">
              {t.Staff.matchType}
            </label>
            <select
              value={matchType}
              onChange={(e) => setMatchType(e.target.value as MatchType)}
              className="w-full border border-[#E3DED2] bg-[#FAF8F4] rounded-lg px-3 py-2 text-sm"
            >
              <option value="singles">{t.Tournaments.singles}</option>
              <option value="doubles">{t.Tournaments.doubles}</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#53605A] mb-1.5">
              {t.Staff.bestOf}
            </label>
            <select
              value={bestOf}
              onChange={(e) => setBestOf(Number(e.target.value))}
              className="w-full border border-[#E3DED2] bg-[#FAF8F4] rounded-lg px-3 py-2 text-sm"
            >
              <option value={1}>Bo1</option>
              <option value={3}>Bo3</option>
              <option value={5}>Bo5</option>
              <option value={7}>Bo7</option>
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs font-semibold text-[#53605A] mb-1.5">
              {t.Staff.initialFormat}
            </label>
            <select
              value={initialFormat}
              onChange={(e) => setInitialFormat(e.target.value as StageFormat)}
              className="w-full border border-[#E3DED2] bg-[#FAF8F4] rounded-lg px-3 py-2 text-sm"
            >
              <option value="single_elimination">{t.Staff.formats.single_elimination}</option>
              <option value="double_elimination">{t.Staff.formats.double_elimination}</option>
              <option value="round_robin">{t.Staff.formats.round_robin}</option>
              <option value="swiss">{t.Staff.formats.swiss}</option>
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs font-semibold text-[#53605A] mb-1.5">
              {t.Staff.description}
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full border border-[#E3DED2] bg-[#FAF8F4] rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div className="md:col-span-2 flex flex-wrap items-center gap-4 pt-1">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 bg-[#14533C] text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#0E3E2C] transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>{t.Staff.createBtn}</span>
            </button>
            {tournamentMsg && (
              <span className="text-sm font-medium text-[#14533C]">{tournamentMsg}</span>
            )}
          </div>
        </form>
      </section>

      {/* SECTION 2: PLAYER REGISTRY, ELO CALIBRATION & DUPLICATE MERGER */}
      <section className="bg-white p-6 rounded-xl border border-[#E3DED2] shadow-[0_1px_2px_rgba(20,30,25,0.04)] space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#EFECE4] pb-3">
          <h2 className="text-lg font-bold text-[#18211D]">{t.Staff.playersRegistry}</h2>
          <span className="font-num text-xs text-[#828E88]">
            {players.length} {locale === 'ru' ? 'игроков' : 'players'}
          </span>
        </div>

        <form onSubmit={handleAddPlayer} className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <div>
            <label className="block text-xs font-semibold text-[#53605A] mb-1.5">
              {t.Staff.fullName}
            </label>
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full border border-[#E3DED2] bg-[#FAF8F4] rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#53605A] mb-1.5">
              {t.Staff.universityId}
            </label>
            <input
              type="text"
              value={universityId}
              onChange={(e) => setUniversityId(e.target.value)}
              className="w-full border border-[#E3DED2] bg-[#FAF8F4] rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#53605A] mb-1.5">
              {t.Staff.category}
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as PlayerCategory)}
              className="w-full border border-[#E3DED2] bg-[#FAF8F4] rounded-lg px-3 py-2 text-sm"
            >
              <option value="student">{t.Staff.categories.student}</option>
              <option value="staff">{t.Staff.categories.staff}</option>
              <option value="professor">{t.Staff.categories.professor}</option>
              <option value="guest">{t.Staff.categories.guest}</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#53605A] mb-1.5">
              {t.Staff.initialElo}
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                value={initialElo}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setInitialElo(Number(e.target.value))}
                className="w-24 border border-[#E3DED2] bg-[#FAF8F4] rounded-lg px-3 py-2 text-sm font-num"
              />
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 bg-[#18211D] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#2C3732] whitespace-nowrap transition-colors"
              >
                <UserPlus className="w-4 h-4" />
                <span>{t.Staff.addPlayerBtn}</span>
              </button>
            </div>
          </div>
        </form>

        {/* DUPLICATE PLAYER MERGER */}
        <div className="bg-[#FDF7EC] border border-[#EAD9B7] rounded-xl p-3.5 flex flex-wrap items-center gap-2.5 text-xs">
          <span className="inline-flex items-center gap-1.5 font-bold text-[#784A04]">
            <GitMerge className="w-4 h-4" />
            <span>Объединить дубликат:</span>
          </span>
          <select
            value={duplicateId}
            onChange={(e) => setDuplicateId(e.target.value)}
            className="border border-[#E3DED2] bg-white rounded-lg px-2.5 py-1.5 text-xs"
          >
            <option value="">Удаляемый дубликат...</option>
            {players.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name} ({p.university_id || 'без ID'})
              </option>
            ))}
          </select>
          <span className="text-[#828E88]">→ в профиль →</span>
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="border border-[#E3DED2] bg-white rounded-lg px-2.5 py-1.5 text-xs"
          >
            <option value="">Основной профиль...</option>
            {players.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name} ({p.university_id || 'без ID'})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleMergePlayers}
            className="bg-[#C2412D] text-white px-3 py-1.5 rounded-lg font-semibold hover:bg-[#A33322] transition-colors"
          >
            Объединить
          </button>
        </div>

        {playerMsg && (
          <p className="text-sm font-medium text-[#14533C]">{playerMsg}</p>
        )}

        <div className="relative max-w-xs">
          <Search className="w-3.5 h-3.5 text-[#828E88] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={playerSearch}
            onChange={(e) => setPlayerSearch(e.target.value)}
            placeholder={t.Leaderboard.searchPlaceholder}
            className="w-full border border-[#E3DED2] bg-[#FAF8F4] rounded-lg pl-8 pr-3 py-1.5 text-xs"
          />
        </div>

        <div className="overflow-x-auto thin-scroll border border-[#E3DED2] rounded-xl">
          <table className="w-full text-sm text-left border-collapse">
            <thead className="bg-[#F7F5F0] border-b border-[#E3DED2] text-[11px] uppercase tracking-wider text-[#53605A]">
              <tr>
                <th className="p-3 font-semibold">{t.Staff.fullName}</th>
                <th className="p-3 font-semibold">ID</th>
                <th className="p-3 font-semibold">{t.Staff.category}</th>
                <th className="p-3 font-semibold">W / L</th>
                <th className="p-3 font-semibold">Elo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EFECE4]">
              {filteredPlayers.map((p) => (
                <tr key={p.id} className="hover:bg-[#FAF8F4]">
                  <td className="p-3 font-medium text-[#18211D]">{p.full_name}</td>
                  <td className="p-3 font-num text-xs text-[#828E88]">
                    {p.university_id || '—'}
                  </td>
                  <td className="p-3 text-xs text-[#53605A]">
                    {t.Staff.categories[p.category]}
                  </td>
                  <td className="p-3 font-num text-xs text-[#53605A]">
                    {p.wins}W – {p.losses}L
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        value={eloEdits[p.id] ?? p.elo_rating}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) =>
                          setEloEdits({ ...eloEdits, [p.id]: Number(e.target.value) })
                        }
                        className="w-20 border border-[#E3DED2] bg-white rounded-lg px-2 py-1 text-sm font-num"
                      />
                      {eloEdits[p.id] !== undefined && eloEdits[p.id] !== p.elo_rating && (
                        <button
                          type="button"
                          onClick={() => handleUpdateElo(p)}
                          className="inline-flex items-center gap-1 text-xs bg-[#14533C] text-white px-2.5 py-1 rounded-lg font-semibold hover:bg-[#0E3E2C]"
                        >
                          <Check className="w-3 h-3" />
                          <span>{t.Staff.updateEloBtn}</span>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
