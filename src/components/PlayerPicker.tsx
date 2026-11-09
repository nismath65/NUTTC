'use client';

import React, { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Player, PlayerCategory } from '@/types/database';
import { useLanguage } from './LanguageProvider';

interface PlayerPickerProps {
  label: string;
  players: Player[];
  selectedPlayer: Player | null;
  onSelect: (player: Player | null) => void;
  onPlayerCreated: (newPlayer: Player) => void;
}

export default function PlayerPicker({
  label,
  players,
  selectedPlayer,
  onSelect,
  onPlayerCreated,
}: PlayerPickerProps) {
  const { t } = useLanguage();
  const [search, setSearch] = useState('');
  const [isCreatingNew, setIsCreatingNew] = useState(false);

  // New player mini-form states
  const [newName, setNewName] = useState('');
  const [newUniId, setNewUniId] = useState('');
  const [newCategory, setNewCategory] = useState<PlayerCategory>('student');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Filter players by name or university_id
  const filteredPlayers = players.filter((p) => {
    const q = search.toLowerCase().trim();
    if (!q) return true;
    return (
      p.full_name.toLowerCase().includes(q) ||
      (p.university_id && p.university_id.toLowerCase().includes(q))
    );
  });

  const handleCreateNewPlayer = async () => {
    setErrorMsg(null);
    if (!newName.trim()) return;

    const { data, error } = await supabase
      .from('players')
      .insert({
        full_name: newName.trim(),
        university_id: newUniId.trim() || null,
        category: newCategory,
        elo_rating: 1000,
      })
      .select()
      .single();

    if (error || !data) {
      setErrorMsg(error?.message || 'Error');
      return;
    }

    const created = data as Player;
    onPlayerCreated(created);
    onSelect(created);
    setIsCreatingNew(false);
    setNewName('');
    setNewUniId('');
  };

  return (
    <div className="border rounded-lg p-4 bg-gray-50 space-y-3">
      <div className="flex justify-between items-center">
        <span className="text-sm font-semibold text-gray-800">{label}</span>
        {selectedPlayer && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="text-xs text-red-600 hover:underline"
          >
            ✕ Сбросить / Clear
          </button>
        )}
      </div>

      {/* STATE 1: Player already chosen */}
      {selectedPlayer ? (
        <div className="bg-blue-50 border border-blue-200 rounded-md p-3 flex justify-between items-center">
          <div>
            <p className="font-medium text-blue-900">{selectedPlayer.full_name}</p>
            <p className="text-xs text-blue-700">
              {selectedPlayer.university_id ? `ID: ${selectedPlayer.university_id} • ` : ''}
              {t.Staff.categories[selectedPlayer.category]} • Elo: {selectedPlayer.elo_rating}
            </p>
          </div>
        </div>
      ) : !isCreatingNew ? (
        /* STATE 2: Autocomplete Search Dropdown */
        <div className="space-y-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.TournamentDetail.searchPlaceholder}
            className="w-full border bg-white rounded-md px-3 py-2 text-sm"
          />

          <div className="max-h-40 overflow-y-auto border rounded-md bg-white divide-y">
            {filteredPlayers.slice(0, 8).map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelect(p)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 flex justify-between items-center"
              >
                <span>
                  <span className="font-medium">{p.full_name}</span>{' '}
                  {p.university_id && (
                    <span className="text-gray-500 text-xs">({p.university_id})</span>
                  )}
                </span>
                <span className="text-xs text-gray-500">Elo {p.elo_rating}</span>
              </button>
            ))}
            {filteredPlayers.length === 0 && (
              <p className="p-2 text-xs text-gray-500">Ничего не найдено / No match</p>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              setNewName(search);
              setIsCreatingNew(true);
            }}
            className="text-xs font-medium text-blue-600 hover:underline"
          >
            {t.TournamentDetail.notInListCreateNew}
          </button>
        </div>
      ) : (
        /* STATE 3: Create New Player Inline */
        <div className="space-y-2 bg-white p-3 rounded-md border">
          <button
            type="button"
            onClick={() => setIsCreatingNew(false)}
            className="text-xs text-gray-500 hover:underline"
          >
            {t.TournamentDetail.backToSearch}
          </button>

          <input
            type="text"
            placeholder={t.Staff.fullName}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full border rounded px-2.5 py-1.5 text-sm"
          />

          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              placeholder="University ID"
              value={newUniId}
              onChange={(e) => setNewUniId(e.target.value)}
              className="border rounded px-2.5 py-1.5 text-sm"
            />
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as PlayerCategory)}
              className="border rounded px-2.5 py-1.5 text-sm"
            >
              <option value="student">{t.Staff.categories.student}</option>
              <option value="staff">{t.Staff.categories.staff}</option>
              <option value="professor">{t.Staff.categories.professor}</option>
              <option value="guest">{t.Staff.categories.guest}</option>
            </select>
          </div>

          {errorMsg && <p className="text-xs text-red-600">{errorMsg}</p>}

          <button
            type="button"
            onClick={handleCreateNewPlayer}
            className="w-full bg-gray-900 text-white py-1.5 rounded text-xs font-medium hover:bg-gray-800"
          >
            {t.Staff.addPlayerBtn}
          </button>
        </div>
      )}
    </div>
  );
}