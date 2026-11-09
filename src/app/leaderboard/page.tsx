'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Player, PlayerCategory } from '@/types/database';
import { useLanguage } from '@/components/LanguageProvider';

interface RatingLog {
  id: string;
  elo_before: number;
  elo_after: number;
  reason: string;
  created_at: string;
}

export default function LeaderboardPage() {
  const { locale, t } = useLanguage();
  const [players, setPlayers] = useState<Player[]>([]);
  const [medalsMap, setMedalsMap] = useState<Record<string, number[]>>({});
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState<string>('all');

  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  const [logs, setLogs] = useState<RatingLog[]>([]);

  useEffect(() => {
    const loadLeaderboard = async () => {
      const { data: pData } = await supabase
        .from('players')
        .select('*')
        .order('elo_rating', { ascending: false });
      if (pData) setPlayers(pData as Player[]);

      // Load all podium placements (1st, 2nd, 3rd)
      const { data: mData } = await supabase
        .from('tournament_entries')
        .select('player1_id, player2_id, final_placement')
        .lte('final_placement', 3);

      if (mData) {
        const map: Record<string, number[]> = {};
        mData.forEach((row) => {
          if (!row.final_placement) return;
          [row.player1_id, row.player2_id].filter(Boolean).forEach((pid) => {
            if (!map[pid]) map[pid] = [];
            map[pid].push(row.final_placement);
          });
        });
        setMedalsMap(map);
      }
    };
    loadLeaderboard();
  }, []);

  const handleSelectPlayer = async (p: Player) => {
    setSelectedPlayer(p);
    const { data } = await supabase
      .from('rating_logs')
      .select('*')
      .eq('player_id', p.id)
      .order('created_at', { ascending: false })
      .limit(20);
    setLogs((data as RatingLog[]) || []);
  };

  const filtered = players.filter((p) => {
    if (catFilter !== 'all' && p.category !== catFilter) return false;
    const q = search.toLowerCase().trim();
    if (!q) return true;
    return (
      p.full_name.toLowerCase().includes(q) ||
      (p.university_id && p.university_id.toLowerCase().includes(q))
    );
  });

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <h1 className="text-2xl font-bold">{t.Leaderboard.title}</h1>

        <div className="flex flex-wrap gap-3 w-full md:w-auto">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.Leaderboard.searchPlaceholder}
            className="border bg-white rounded-md px-3 py-1.5 text-sm"
          />
          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            className="border bg-white rounded-md px-3 py-1.5 text-sm"
          >
            <option value="all">{t.Leaderboard.allCategories}</option>
            <option value="student">{t.Staff.categories.student}</option>
            <option value="staff">{t.Staff.categories.staff}</option>
            <option value="professor">{t.Staff.categories.professor}</option>
            <option value="guest">{t.Staff.categories.guest}</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* MAIN LEADERBOARD TABLE */}
        <div className="lg:col-span-2 bg-white border rounded-lg shadow-xs overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-50 border-b text-gray-600">
              <tr>
                <th className="p-3">{t.Leaderboard.rank}</th>
                <th className="p-3">{t.Leaderboard.player}</th>
                <th className="p-3">{t.Leaderboard.category}</th>
                <th className="p-3">{t.Leaderboard.elo}</th>
                <th className="p-3">{t.Leaderboard.matches}</th>
                <th className="p-3">{t.Leaderboard.winrate}</th>
                <th className="p-3">{t.Leaderboard.medals}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((p, idx) => {
                const total = p.wins + p.losses;
                const winrate = total > 0 ? Math.round((p.wins / total) * 100) : 0;
                const pMedals = medalsMap[p.id] || [];
                return (
                  <tr
                    key={p.id}
                    onClick={() => handleSelectPlayer(p)}
                    className={`cursor-pointer transition ${
                      selectedPlayer?.id === p.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <td className="p-3 font-bold text-gray-500">#{idx + 1}</td>
                    <td className="p-3 font-medium">
                      {p.full_name}
                      {p.university_id && (
                        <span className="text-xs text-gray-400 ml-1">({p.university_id})</span>
                      )}
                    </td>
                    <td className="p-3 text-xs">
                      {t.Staff.categories[p.category as PlayerCategory]}
                    </td>
                    <td className="p-3 font-bold text-blue-700">{p.elo_rating}</td>
                    <td className="p-3">
                      {p.wins}W - {p.losses}L
                    </td>
                    <td className="p-3 text-gray-600">{winrate}%</td>
                    <td className="p-3">
                      {pMedals.map((m, i) => (
                        <span key={i}>{m === 1 ? '🥇' : m === 2 ? '🥈' : '🥉'}</span>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* PLAYER RATING HISTORY PANEL */}
        <div className="bg-white border rounded-lg p-5 shadow-xs space-y-4">
          <h2 className="font-bold text-base">{t.Leaderboard.historyTitle}</h2>
          {!selectedPlayer ? (
            <p className="text-xs text-gray-500">{t.Leaderboard.selectPlayerHint}</p>
          ) : (
            <div className="space-y-3">
              <div className="bg-blue-50 p-3 rounded-md border border-blue-100">
                <p className="font-bold text-blue-950">{selectedPlayer.full_name}</p>
                <p className="text-xs text-blue-700">
                  Elo: <strong>{selectedPlayer.elo_rating}</strong> • {selectedPlayer.wins}W -{' '}
                  {selectedPlayer.losses}L
                </p>
              </div>

              {logs.length === 0 ? (
                <p className="text-xs text-gray-400">{t.Leaderboard.noLogs}</p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                  {logs.map((log) => {
                    const diff = log.elo_after - log.elo_before;
                    return (
                      <div
                        key={log.id}
                        className="border rounded p-2.5 text-xs flex justify-between items-center"
                      >
                        <div>
                          <p className="font-medium text-gray-800">{log.reason}</p>
                          <p className="text-[11px] text-gray-400">
                            {new Date(log.created_at).toLocaleDateString(
                              locale === 'ru' ? 'ru-RU' : 'en-US'
                            )}
                          </p>
                        </div>
                        <div className="text-right">
                          <span
                            className={`font-bold ${
                              diff >= 0 ? 'text-green-700' : 'text-red-600'
                            }`}
                          >
                            {log.elo_before} → {log.elo_after}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}