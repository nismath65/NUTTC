'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Calendar, Users, ArrowRight, Trophy, CircleDot } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { Tournament, TournamentEntry, TournamentStatus } from '@/types/database';
import { useLanguage } from '@/components/LanguageProvider';

interface TournamentWithWinners extends Tournament {
  entries?: TournamentEntry[];
}

const STATUS_STYLE: Record<TournamentStatus, string> = {
  in_progress: 'bg-[#EFF6FF] text-[#1D4ED8] border-[#93C5FD]',
  registration_open: 'bg-[#FEF7E6] text-[#92580A] border-[#EDD6A3]',
  check_in: 'bg-[#EDF4FA] text-[#1D527C] border-[#C2D8EC]',
  scheduled: 'bg-[#F1EDE4] text-[#53605A] border-[#DCD5C7]',
  completed: 'bg-[#F4F2ED] text-[#66726D] border-[#E3DED2]',
  archived: 'bg-[#F4F2ED] text-[#828E88] border-[#E3DED2]',
};

export default function HomePage() {
  const { locale, t } = useLanguage();
  const [tournaments, setTournaments] = useState<TournamentWithWinners[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadTournaments = async () => {
      const { data } = await supabase
        .from('tournaments')
        .select(
          `*, entries:tournament_entries(id, final_placement, player1:players!player1_id(full_name), player2:players!player2_id(full_name))`
        )
        .order('event_date', { ascending: false });
      if (data) setTournaments(data as TournamentWithWinners[]);
      setLoading(false);
    };
    loadTournaments();
  }, []);

  const upcoming = tournaments.filter((item) => item.status !== 'completed');
  const completed = tournaments.filter((item) => item.status === 'completed');

  const formatEntry = (e: TournamentEntry) =>
    e.player2 ? `${e.player1?.full_name} / ${e.player2?.full_name}` : e.player1?.full_name;

  const renderCard = (item: TournamentWithWinners) => {
    const winners = (item.entries || [])
      .filter((e) => e.final_placement && e.final_placement <= 3)
      .sort((a, b) => (a.final_placement || 99) - (b.final_placement || 99));

    const isLive = item.status === 'in_progress';
    const participantCount = item.entries?.length ?? 0;

    return (
      <Link
        key={item.id}
        href={`/tournaments/${item.id}`}
        className={`group block bg-white border rounded-xl p-5 transition-all duration-150 shadow-[0_1px_2px_rgba(20,30,25,0.04)] hover:shadow-[0_4px_12px_rgba(20,30,25,0.06)] hover:border-[#1D4ED8]/45 ${
          isLive ? 'border-[#1D4ED8]/40 border-l-4 border-l-[#1D4ED8]' : 'border-[#E3DED2]'
        }`}
      >
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div className="space-y-2 min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-lg font-bold text-[#18211D] group-hover:text-[#1D4ED8] transition-colors">
                {item.title}
              </h2>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${
                  STATUS_STYLE[item.status]
                }`}
              >
                {isLive && (
                  <CircleDot className="w-3 h-3 text-[#1D4ED8] animate-pulse" />
                )}
                {t.Tournaments.status[item.status]}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#53605A]">
              <span className="inline-flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-[#828E88]" />
                {new Date(item.event_date).toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-[#828E88]" />
                {item.type === 'singles' ? t.Tournaments.singles : t.Tournaments.doubles}
                {participantCount > 0 && (
                  <span className="font-num text-[#828E88]">({participantCount})</span>
                )}
              </span>
              <span className="font-num px-1.5 py-0.5 rounded bg-[#F1EDE4] text-[#53605A] text-[11px] font-semibold">
                Bo{item.best_of}
              </span>
            </div>

            {item.description && (
              <p className="text-sm text-[#53605A] leading-relaxed">{item.description}</p>
            )}
          </div>

          <span className="hidden sm:inline-flex items-center gap-1 text-xs font-semibold text-[#1D4ED8] opacity-70 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all shrink-0 pt-1">
            <span>{locale === 'ru' ? 'Открыть' : 'Open'}</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </span>
        </div>

        {winners.length > 0 && (
          <div className="mt-4 pt-3 border-t border-dashed border-[#E3DED2] flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-[#828E88] mr-1">
              <Trophy className="w-3 h-3 text-[#B45309]" />
              {t.Tournaments.podium}
            </span>
            {winners.map((w) => (
              <span
                key={w.id}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border ${
                  w.final_placement === 1
                    ? 'bg-[#FEF7E0] text-[#784A04] border-[#ECD58E]'
                    : w.final_placement === 2
                    ? 'bg-[#F4F5F6] text-[#3E474C] border-[#D8DDE0]'
                    : 'bg-[#FDF1E8] text-[#7D3E16] border-[#EAC6AD]'
                }`}
              >
                <span>
                  {w.final_placement === 1 ? '🥇' : w.final_placement === 2 ? '🥈' : '🥉'}
                </span>
                <span>{formatEntry(w)}</span>
              </span>
            ))}
          </div>
        )}
      </Link>
    );
  };

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-10">
      {/* Compact club header strip */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 border-b border-[#E3DED2]">
        <div className="space-y-1">
          <p className="text-[11px] font-bold uppercase tracking-widest text-[#1D4ED8]">
            Nazarbayev University Table Tennis Club
          </p>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-[#18211D]">
            {t.Tournaments.upcoming}
          </h1>
        </div>
        <div className="flex items-center gap-2 text-xs text-[#53605A]">
          <span className="px-2.5 py-1 rounded-md bg-white border border-[#E3DED2] font-num">
            {locale === 'ru' ? 'Активных' : 'Active'}:{' '}
            <strong className="text-[#1D4ED8]">{upcoming.length}</strong>
          </span>
          <span className="px-2.5 py-1 rounded-md bg-white border border-[#E3DED2] font-num">
            {locale === 'ru' ? 'Завершено' : 'Finished'}:{' '}
            <strong className="text-[#18211D]">{completed.length}</strong>
          </span>
        </div>
      </div>

      <section className="space-y-3.5">
        {loading ? (
          <div className="space-y-3">
            {[1, 2].map((n) => (
              <div
                key={n}
                className="h-28 bg-white border border-[#E3DED2] rounded-xl animate-pulse"
              />
            ))}
          </div>
        ) : upcoming.length === 0 ? (
          <div className="bg-white border border-dashed border-[#CCC5B6] rounded-xl p-8 text-center text-sm text-[#53605A]">
            {t.Tournaments.empty}
          </div>
        ) : (
          <div className="grid gap-3.5">{upcoming.map(renderCard)}</div>
        )}
      </section>

      {completed.length > 0 && (
        <section className="space-y-4 pt-2">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-[#18211D]">{t.Tournaments.past}</h2>
            <div className="h-px flex-1 bg-[#E3DED2]" />
          </div>
          <div className="grid gap-3.5">{completed.map(renderCard)}</div>
        </section>
      )}
    </main>
  );
}