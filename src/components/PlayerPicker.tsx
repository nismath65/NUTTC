'use client';

import React, { useState } from 'react';
import { Search, UserPlus, ArrowLeft, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import {
  DEFAULT_SKILL_LEVEL,
  getInitialEloForLevel,
  PlayerSkillLevel,
  SKILL_LEVEL_OPTIONS,
} from '@/lib/playerLevels';
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

  const [newName, setNewName] = useState('');
  const [newUniId, setNewUniId] = useState('');
  const [newCategory, setNewCategory] = useState<PlayerCategory>('student');
  const [newLevel, setNewLevel] = useState<PlayerSkillLevel>(DEFAULT_SKILL_LEVEL);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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
        elo_rating: getInitialEloForLevel(newLevel),
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
    setNewLevel(DEFAULT_SKILL_LEVEL);
  };

  return (
    <div className="border border-[#E3DED2] rounded-xl p-4 bg-[#FAF8F4] space-y-3">
      <div className="flex justify-between items-center">
        <span className="text-xs font-bold uppercase tracking-wider text-[#53605A]">
          {label}
        </span>
        {selectedPlayer && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="inline-flex items-center gap-1 text-xs font-medium text-[#C2412D] hover:underline"
          >
            <X className="w-3.5 h-3.5" />
            <span>Сбросить / Clear</span>
          </button>
        )}
      </div>

      {selectedPlayer ? (
        <div className="bg-[#EFF6FF] border border-[#BFDBFE] rounded-lg p-3 flex justify-between items-center">
          <div>
            <p className="font-semibold text-[#18211D]">{selectedPlayer.full_name}</p>
            <p className="text-xs text-[#1D4ED8]">
              {selectedPlayer.university_id ? (
                <span className="font-num mr-1.5">ID {selectedPlayer.university_id} •</span>
              ) : null}
              {t.Staff.categories[selectedPlayer.category]} •{' '}
              <span className="font-num font-semibold">Elo {selectedPlayer.elo_rating}</span>
            </p>
          </div>
        </div>
      ) : !isCreatingNew ? (
        <div className="space-y-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#828E88] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t.TournamentDetail.searchPlaceholder}
              className="w-full border border-[#E3DED2] bg-white rounded-lg pl-8 pr-3 py-2 text-sm text-[#18211D] placeholder:text-[#828E88]"
            />
          </div>

          <div className="max-h-40 overflow-y-auto thin-scroll border border-[#E3DED2] rounded-lg bg-white divide-y divide-[#EFECE4]">
            {filteredPlayers.slice(0, 8).map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelect(p)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-[#EFF6FF] transition-colors flex justify-between items-center gap-2"
              >
                <span className="truncate">
                  <span className="font-medium text-[#18211D]">{p.full_name}</span>{' '}
                  {p.university_id && (
                    <span className="font-num text-[#828E88] text-xs">({p.university_id})</span>
                  )}
                </span>
                <span className="font-num text-xs font-semibold text-[#1D4ED8] shrink-0">
                  {p.elo_rating}
                </span>
              </button>
            ))}
            {filteredPlayers.length === 0 && (
              <p className="p-2.5 text-xs text-[#828E88]">Ничего не найдено / No match</p>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              setNewName(search);
              setIsCreatingNew(true);
            }}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1D4ED8] hover:underline"
          >
            <UserPlus className="w-3.5 h-3.5" />
            <span>{t.TournamentDetail.notInListCreateNew.replace(/^\+\s*/, '')}</span>
          </button>
        </div>
      ) : (
        <div className="space-y-2.5 bg-white p-3.5 rounded-lg border border-[#E3DED2]">
          <button
            type="button"
            onClick={() => setIsCreatingNew(false)}
            className="inline-flex items-center gap-1 text-xs text-[#53605A] hover:text-[#18211D]"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>{t.TournamentDetail.backToSearch.replace(/^←\s*/, '')}</span>
          </button>

          <input
            type="text"
            placeholder={t.Staff.fullName}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full border border-[#E3DED2] rounded-lg px-2.5 py-1.5 text-sm"
          />

          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              placeholder="University ID"
              value={newUniId}
              onChange={(e) => setNewUniId(e.target.value)}
              className="border border-[#E3DED2] rounded-lg px-2.5 py-1.5 text-sm"
            />
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as PlayerCategory)}
              className="border border-[#E3DED2] rounded-lg px-2.5 py-1.5 text-sm bg-white"
            >
              <option value="student">{t.Staff.categories.student}</option>
              <option value="staff">{t.Staff.categories.staff}</option>
              <option value="professor">{t.Staff.categories.professor}</option>
              <option value="guest">{t.Staff.categories.guest}</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-[#53605A] mb-1">
              {t.Staff.skillLevel}
            </label>
            <select
              value={newLevel}
              onChange={(e) => setNewLevel(e.target.value as PlayerSkillLevel)}
              className="w-full border border-[#E3DED2] rounded-lg px-2.5 py-1.5 text-sm bg-white"
            >
              {SKILL_LEVEL_OPTIONS.map((lvl) => (
                <option key={lvl} value={lvl}>
                  {t.Staff.levels[lvl]}
                </option>
              ))}
            </select>
          </div>

          {errorMsg && <p className="text-xs text-[#C2412D]">{errorMsg}</p>}

          <button
            type="button"
            onClick={handleCreateNewPlayer}
            className="w-full bg-[#1D4ED8] text-white py-2 rounded-lg text-xs font-semibold hover:bg-[#1E40AF] transition-colors"
          >
            {t.Staff.addPlayerBtn}
          </button>
        </div>
      )}
    </div>
  );
}