'use client';

import React, { useEffect, useState } from 'react';
import { Search, Trophy, TrendingUp, TrendingDown, Minus } from 'lucide-react';
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

function EloSparkline({ logs }: { logs: RatingLog[] }) {
  if (logs.length < 2) return null;
  const chrono = [...logs].reverse();
  const points = [chrono[0].elo_before, ...chrono.map((l) => l.elo_after)];
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(10, max - min);
  const w = 240;
  const h = 44;
  const pad = 4;

  const coords = points.map((val, i) => {
    const x = pad + (i / (points.length - 1)) * (w - pad * 2);
    const y = h - pad - ((val - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const last = coords[coords.length - 1].split(',');
  const trendingUp = points[points.length - 1] >= points[0];

  return (
    <div className="bg-[#F7F5F0] border border-[#E3DED2] rounded-lg px-3 py-2 space-y-1">
      <div className="flex justify-between text-[10px] font-num text-[#828E88]">
        <span>min {min}</span>
        <span>max {max}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-11 overflow-visible">
        <polyline
          fill="none"
          stroke={trendingUp ? '#B91C1C' : '#C2412D'}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={coords.join(' ')}
        />
        <circle
          cx={last[0]}
          cy={last[1]}
          r="3.2"
          fill={trendingUp ? '#B91C1C' : '#C2412D'}
          stroke="#FFFFFF"
          strokeWidth="1.2"
        />
      </svg>
    </div>
  );
}

export default function LeaderboardPage() {
  const { locale, t } = useLanguage();
  const [players, setPlayers] = useState<Player[]>([]);
  const [medalsMap, setMedalsMap] = useState<Record<string, number[]>>({});
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState<string>('all');

  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  const [logs, setLogs] = useState<RatingLog[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  useEffect(() => {
    const loadLeaderboard = async () => {
      const { data: pData } = await supabase
        .from('players')
        .select('*')
        .order('elo_rating', { ascending: false });
      if (pData) setPlayers(pData as Player[]);

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
    setLoadingLogs(true);
    const { data } = await supabase
      .from('rating_logs')
      .select('*')
      .eq('player_id', p.id)
      .order('created_at', { ascending: false })
      .limit(20);
    setLogs((data as RatingLog[]) || []);
    setLoadingLogs(false);
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
    <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 pb-5 border-b border-[#E3DED2]">
        <div className="space-y-1">
          <p className="text-[11px] font-bold uppercase tracking-widest text-[#B91C1C]">
            NUTTC Elo Standings
          </p>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-[#18211D]">
            {t.Leaderboard.title}
          </h1>
        </div>

        <div className="flex flex-wrap gap-2.5 w-full md:w-auto">
          <div className="relative flex-1 sm:flex-initial sm:min-w-[230px]">
            <Search className="w-4 h-4 text-[#828E88] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t.Leaderboard.searchPlaceholder}
              className="w-full border border-[#E3DED2] bg-white rounded-lg pl-9 pr-3 py-2 text-sm text-[#18211D] placeholder:text-[#828E88]"
            />
          </div>
          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            className="border border-[#E3DED2] bg-white rounded-lg px-3 py-2 text-sm text-[#18211D]"
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
        <div className="lg:col-span-2 bg-white border border-[#E3DED2] rounded-xl shadow-[0_1px_2px_rgba(20,30,25,0.04)] overflow-hidden">
          <div className="overflow-x-auto thin-scroll">
            <table className="w-full text-sm text-left border-collapse">
              <thead className="bg-[#F7F5F0] border-b border-[#E3DED2] text-[11px] uppercase tracking-wider text-[#53605A]">
                <tr>
                  <th className="py-3 px-4 font-semibold">{t.Leaderboard.rank}</th>
                  <th className="py-3 px-3 font-semibold">{t.Leaderboard.player}</th>
                  <th className="py-3 px-3 font-semibold">{t.Leaderboard.category}</th>
                  <th className="py-3 px-3 font-semibold text-right">{t.Leaderboard.elo}</th>
                  <th className="py-3 px-3 font-semibold text-center">{t.Leaderboard.matches}</th>
                  <th className="py-3 px-3 font-semibold text-right">{t.Leaderboard.winrate}</th>
                  <th className="py-3 px-4 font-semibold">{t.Leaderboard.medals}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFECE4]">
                {filtered.map((p, idx) => {
                  const total = p.wins + p.losses;
                  const winrate = total > 0 ? Math.round((p.wins / total) * 100) : 0;
                  const pMedals = (medalsMap[p.id] || []).slice().sort((a, b) => a - b);
                  const isSelected = selectedPlayer?.id === p.id;

                  return (
                    <tr
                      key={p.id}
                      onClick={() => handleSelectPlayer(p)}
                      className={`cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-[#FEF2F2]'
                          : 'hover:bg-[#FAF8F4]'
                      }`}
                    >
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center justify-center min-w-[28px] h-6 px-1.5 rounded-md font-num text-xs font-bold ${
                            idx === 0
                              ? 'bg-[#FEF7E0] text-[#784A04] border border-[#ECD58E]'
                              : idx === 1
                              ? 'bg-[#F1F3F5] text-[#3E474C] border border-[#D4D9DD]'
                              : idx === 2
                              ? 'bg-[#FDF1E8] text-[#7D3E16] border border-[#EAC6AD]'
                              : 'text-[#828E88]'
                          }`}
                        >
                          {idx + 1}
                        </span>
                      </td>
                      <td className="py-3 px-3">
                        <div className="font-semibold text-[#18211D]">{p.full_name}</div>
                        {p.university_id && (
                          <div className="font-num text-[11px] text-[#828E88]">
                            {p.university_id}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <span className="inline-block px-2 py-0.5 rounded bg-[#F1EDE4] text-[#53605A] text-[11px] font-medium">
                          {t.Staff.categories[p.category as PlayerCategory]}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-right font-num font-bold text-[#B91C1C] text-base">
                        {p.elo_rating}
                      </td>
                      <td className="py-3 px-3 text-center font-num text-xs text-[#53605A]">
                        <span className="text-[#B91C1C] font-semibold">{p.wins}W</span>
                        <span className="text-[#828E88] mx-1">-</span>
                        <span>{p.losses}L</span>
                      </td>
                      <td className="py-3 px-3 text-right font-num text-xs text-[#53605A]">
                        {total > 0 ? `${winrate}%` : '—'}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        {pMedals.length > 0 ? (
                          <span className="inline-flex gap-0.5">
                            {pMedals.map((m, i) => (
                              <span key={i}>{m === 1 ? '🥇' : m === 2 ? '🥈' : '🥉'}</span>
                            ))}
                          </span>
                        ) : (
                          <span className="text-xs text-[#CCC5B6]">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-sm text-[#828E88]">
                      —
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* PLAYER RATING HISTORY PANEL */}
        <aside className="bg-white border border-[#E3DED2] rounded-xl p-5 shadow-[0_1px_2px_rgba(20,30,25,0.04)] space-y-4 lg:sticky lg:top-20">
          <div className="flex items-center justify-between border-b border-[#EFECE4] pb-3">
            <h2 className="font-bold text-sm uppercase tracking-wider text-[#53605A]">
              {t.Leaderboard.historyTitle}
            </h2>
            <Trophy className="w-4 h-4 text-[#828E88]" />
          </div>

          {!selectedPlayer ? (
            <p className="text-xs text-[#828E88] leading-relaxed py-4">
              {t.Leaderboard.selectPlayerHint}
            </p>
          ) : (
            <div className="space-y-3.5">
              <div className="bg-[#FEF2F2] p-3.5 rounded-lg border border-[#FECACA] space-y-1">
                <p className="font-bold text-[#18211D]">{selectedPlayer.full_name}</p>
                <div className="flex items-center justify-between text-xs text-[#B91C1C]">
                  <span className="font-num">
                    Elo <strong className="text-sm">{selectedPlayer.elo_rating}</strong>
                  </span>
                  <span className="font-num">
                    {selectedPlayer.wins}W – {selectedPlayer.losses}L
                  </span>
                </div>
              </div>

              <EloSparkline logs={logs} />

              {loadingLogs ? (
                <p className="text-xs text-[#828E88] py-2">Loading...</p>
              ) : logs.length === 0 ? (
                <p className="text-xs text-[#828E88] py-2">{t.Leaderboard.noLogs}</p>
              ) : (
                <div className="space-y-2 max-h-[380px] overflow-y-auto thin-scroll pr-1">
                  {logs.map((log) => {
                    const diff = log.elo_after - log.elo_before;
                    return (
                      <div
                        key={log.id}
                        className="border border-[#EFECE4] rounded-lg p-2.5 text-xs flex justify-between items-center gap-2 bg-[#FAF8F4]/60"
                      >
                        <div className="min-w-0">
                          <p className="font-medium text-[#18211D] truncate">{log.reason}</p>
                          <p className="text-[11px] text-[#828E88]">
                            {new Date(log.created_at).toLocaleDateString(
                              locale === 'ru' ? 'ru-RU' : 'en-US'
                            )}
                          </p>
                        </div>
                        <div className="text-right shrink-0 space-y-0.5">
                          <div
                            className={`inline-flex items-center gap-1 font-num font-bold ${
                              diff > 0
                                ? 'text-[#B91C1C]'
                                : diff < 0
                                ? 'text-[#C2412D]'
                                : 'text-[#53605A]'
                            }`}
                          >
                            {diff > 0 ? (
                              <TrendingUp className="w-3 h-3" />
                            ) : diff < 0 ? (
                              <TrendingDown className="w-3 h-3" />
                            ) : (
                              <Minus className="w-3 h-3" />
                            )}
                            <span>
                              {diff > 0 ? `+${diff}` : diff}
                            </span>
                          </div>
                          <div className="font-num text-[11px] text-[#828E88]">
                            {log.elo_before} → {log.elo_after}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}