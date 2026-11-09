'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { Tournament, TournamentEntry } from '@/types/database';
import { useLanguage } from '@/components/LanguageProvider';

interface TournamentWithWinners extends Tournament {
  entries?: TournamentEntry[];
}

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

    return (
      <Link
        key={item.id}
        href={`/tournaments/${item.id}`}
        className="bg-white border rounded-lg p-5 shadow-xs hover:border-blue-500 transition flex flex-col md:flex-row justify-between gap-4"
      >
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold text-blue-600">{item.title}</h2>
          <p className="text-xs text-gray-600">
            {new Date(item.event_date).toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}{' '}
            • {item.type === 'singles' ? t.Tournaments.singles : t.Tournaments.doubles} • Bo
            {item.best_of}
          </p>
          {item.description && <p className="text-sm text-gray-700">{item.description}</p>}

          {winners.length > 0 && (
            <div className="flex flex-wrap gap-4 pt-2 text-xs font-semibold text-amber-900">
              {winners.map((w) => (
                <span key={w.id} className="bg-amber-50 border border-amber-200 px-2.5 py-1 rounded">
                  {w.final_placement === 1 ? '🥇 ' : w.final_placement === 2 ? '🥈 ' : '🥉 '}
                  {formatEntry(w)}
                </span>
              ))}
            </div>
          )}
        </div>

        <span className="self-start px-3 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 shrink-0">
          {t.Tournaments.status[item.status]}
        </span>
      </Link>
    );
  };

  return (
    <main className="max-w-5xl mx-auto p-6 space-y-10">
      <section className="space-y-4">
        <h1 className="text-2xl font-bold">{t.Tournaments.upcoming}</h1>
        {loading ? (
          <p className="text-gray-500 text-sm">Loading...</p>
        ) : upcoming.length === 0 ? (
          <p className="text-gray-500 text-sm">{t.Tournaments.empty}</p>
        ) : (
          <div className="grid gap-4">{upcoming.map(renderCard)}</div>
        )}
      </section>

      {completed.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-xl font-bold">{t.Tournaments.past}</h2>
          <div className="grid gap-4">{completed.map(renderCard)}</div>
        </section>
      )}
    </main>
  );
}