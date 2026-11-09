'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useLanguage } from '@/components/LanguageProvider';
import { useAuth } from '@/components/AuthProvider';
import { Player, PlayerCategory, MatchType, StageFormat } from '@/types/database';

export default function StaffDashboardPage() {
  const { t } = useLanguage();
  const { isStaff, loadingAuth } = useAuth();

  // Tournament form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [matchType, setMatchType] = useState<MatchType>('singles');
  const [bestOf, setBestOf] = useState<number>(3);
  const [initialFormat, setInitialFormat] = useState<StageFormat>('single_elimination');
  const [tournamentMsg, setTournamentMsg] = useState<string | null>(null);

  // Player registry state
  const [players, setPlayers] = useState<Player[]>([]);
  const [fullName, setFullName] = useState('');
  const [universityId, setUniversityId] = useState('');
  const [category, setCategory] = useState<PlayerCategory>('student');
  const [initialElo, setInitialElo] = useState<number>(1000);
  const [eloEdits, setEloEdits] = useState<Record<string, number>>({});
  const [playerMsg, setPlayerMsg] = useState<string | null>(null);

  // Duplicate Merger state
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

  if (loadingAuth) return <div className="p-8 text-center text-gray-500">Loading...</div>;
  if (!isStaff) {
    return (
      <div className="max-w-md mx-auto mt-16 p-6 bg-white border rounded-lg text-center space-y-4">
        <p className="font-semibold text-red-600">Доступ только для Жюри / Staff Access Only</p>
        <Link href="/login" className="inline-block bg-blue-600 text-white px-4 py-2 rounded text-sm">
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

  // --- MERGE DUPLICATE PLAYER INTO TARGET PLAYER ---
  const handleMergePlayers = async () => {
    if (!duplicateId || !targetId || duplicateId === targetId) return;
    setPlayerMsg(null);

    await supabase
      .from('tournament_entries')
      .update({ player1_id: targetId })
      .eq('player1_id', duplicateId);
    await supabase
      .from('tournament_entries')
      .update({ player2_id: targetId })
      .eq('player2_id', duplicateId);
    await supabase
      .from('rating_logs')
      .update({ player_id: targetId })
      .eq('player_id', duplicateId);

    const { error } = await supabase.from('players').delete().eq('id', duplicateId);
    if (error) {
      setPlayerMsg(`Ошибка объединения: ${error.message}`);
      return;
    }

    setDuplicateId('');
    setTargetId('');
    setPlayerMsg('✓ Дубликат успешно объединён с основным профилем!');
    fetchPlayers();
  };

  return (
    <main className="max-w-5xl mx-auto p-6 space-y-10">
      <h1 className="text-2xl font-bold">{t.Staff.title}</h1>

      {/* SECTION 1: CREATE TOURNAMENT */}
      <section className="bg-white p-6 rounded-lg border shadow-xs">
        <h2 className="text-xl font-semibold mb-4">{t.Staff.createTournament}</h2>
        <form onSubmit={handleCreateTournament} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">{t.Staff.tournamentTitle}</label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="NUTTC Open Cup #1"
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">{t.Staff.eventDate}</label>
            <input
              type="datetime-local"
              required
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">{t.Staff.matchType}</label>
            <select
              value={matchType}
              onChange={(e) => setMatchType(e.target.value as MatchType)}
              className="w-full border rounded-md px-3 py-2 text-sm"
            >
              <option value="singles">{t.Tournaments.singles}</option>
              <option value="doubles">{t.Tournaments.doubles}</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">{t.Staff.bestOf}</label>
            <select
              value={bestOf}
              onChange={(e) => setBestOf(Number(e.target.value))}
              className="w-full border rounded-md px-3 py-2 text-sm"
            >
              <option value={1}>Bo1</option>
              <option value={3}>Bo3</option>
              <option value={5}>Bo5</option>
              <option value={7}>Bo7</option>
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium mb-1">{t.Staff.initialFormat}</label>
            <select
              value={initialFormat}
              onChange={(e) => setInitialFormat(e.target.value as StageFormat)}
              className="w-full border rounded-md px-3 py-2 text-sm"
            >
              <option value="single_elimination">{t.Staff.formats.single_elimination}</option>
              <option value="double_elimination">{t.Staff.formats.double_elimination}</option>
              <option value="round_robin">{t.Staff.formats.round_robin}</option>
              <option value="swiss">{t.Staff.formats.swiss}</option>
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium mb-1">{t.Staff.description}</label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>

          <div className="md:col-span-2 flex items-center gap-4">
            <button
              type="submit"
              className="bg-blue-600 text-white px-5 py-2 rounded-md text-sm font-medium hover:bg-blue-700"
            >
              {t.Staff.createBtn}
            </button>
            {tournamentMsg && <span className="text-sm text-green-700">{tournamentMsg}</span>}
          </div>
        </form>
      </section>

      {/* SECTION 2: PLAYER REGISTRY, ELO CALIBRATION & DUPLICATE MERGER */}
      <section className="bg-white p-6 rounded-lg border shadow-xs space-y-6">
        <h2 className="text-xl font-semibold">{t.Staff.playersRegistry}</h2>

        <form onSubmit={handleAddPlayer} className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <div>
            <label className="block text-xs font-medium mb-1">{t.Staff.fullName}</label>
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">{t.Staff.universityId}</label>
            <input
              type="text"
              value={universityId}
              onChange={(e) => setUniversityId(e.target.value)}
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">{t.Staff.category}</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as PlayerCategory)}
              className="w-full border rounded-md px-3 py-2 text-sm"
            >
              <option value="student">{t.Staff.categories.student}</option>
              <option value="staff">{t.Staff.categories.staff}</option>
              <option value="professor">{t.Staff.categories.professor}</option>
              <option value="guest">{t.Staff.categories.guest}</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">{t.Staff.initialElo}</label>
            <div className="flex gap-2">
              <input
                type="number"
                value={initialElo}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setInitialElo(Number(e.target.value))}
                className="w-24 border rounded-md px-3 py-2 text-sm"
              />
              <button
                type="submit"
                className="bg-gray-900 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-800 whitespace-nowrap"
              >
                {t.Staff.addPlayerBtn}
              </button>
            </div>
          </div>
        </form>

        {/* DUPLICATE PLAYER MERGER */}
        <div className="bg-gray-50 border rounded-md p-3.5 flex flex-wrap items-center gap-3 text-xs">
          <span className="font-bold text-gray-700">Объединить дубликат:</span>
          <select
            value={duplicateId}
            onChange={(e) => setDuplicateId(e.target.value)}
            className="border bg-white rounded px-2 py-1.5"
          >
            <option value="">Удаляемый дубликат...</option>
            {players.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name} ({p.university_id || 'без ID'})
              </option>
            ))}
          </select>
          <span>→ в профиль →</span>
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="border bg-white rounded px-2 py-1.5"
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
            className="bg-red-600 text-white px-3 py-1.5 rounded font-semibold hover:bg-red-700"
          >
            Объединить
          </button>
        </div>

        {playerMsg && <p className="text-sm text-green-700">{playerMsg}</p>}

        <div className="overflow-x-auto border rounded-md">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-50 border-b text-gray-600">
              <tr>
                <th className="p-3">{t.Staff.fullName}</th>
                <th className="p-3">ID</th>
                <th className="p-3">{t.Staff.category}</th>
                <th className="p-3">W / L</th>
                <th className="p-3">Elo</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {players.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="p-3 font-medium">{p.full_name}</td>
                  <td className="p-3 text-gray-500">{p.university_id || '—'}</td>
                  <td className="p-3">{t.Staff.categories[p.category]}</td>
                  <td className="p-3 text-gray-500">
                    {p.wins}W - {p.losses}L
                  </td>
                  <td className="p-3 flex items-center gap-2">
                    <input
                      type="number"
                      value={eloEdits[p.id] ?? p.elo_rating}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) =>
                        setEloEdits({ ...eloEdits, [p.id]: Number(e.target.value) })
                      }
                      className="w-20 border rounded px-2 py-1 text-sm"
                    />
                    {eloEdits[p.id] !== undefined && eloEdits[p.id] !== p.elo_rating && (
                      <button
                        onClick={() => handleUpdateElo(p)}
                        className="text-xs bg-blue-600 text-white px-2.5 py-1 rounded hover:bg-blue-700"
                      >
                        {t.Staff.updateEloBtn}
                      </button>
                    )}
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