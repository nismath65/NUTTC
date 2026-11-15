'use client';

import React, { useLayoutEffect, useRef, useState, useCallback } from 'react';
import { RotateCcw, Trophy, AlertTriangle, CircleDot } from 'lucide-react';
import type { Match, TournamentEntry } from '@/types/database';

interface ConnectorLine {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  midX: number;
  active: boolean;
}

interface BracketViewProps {
  bracketMatches: Match[];
  title: string;
  locale: 'ru' | 'en';
  isJuryMode: boolean;
  fastTestMode: boolean;
  manualSlotEditMode: boolean;
  checkedInEntries: TournamentEntry[];
  busyMatchId: string | null;
  flaggedMatchIds: Set<string>;
  formatEntryName: (entry?: TournamentEntry | null) => string;
  onQuickWin: (match: Match, winnerSlot: 1 | 2) => void;
  onUndoMatch: (match: Match) => void;
  onDirectSlotAssign: (match: Match, slot: 1 | 2, newEntryId: string) => void;
  labels: {
    round: string;
    finalRound: string;
    table: string;
    waitingTable: string;
    chooseWinner: string;
  };
}

export default function BracketView({
  bracketMatches,
  title,
  locale,
  isJuryMode,
  fastTestMode,
  manualSlotEditMode,
  checkedInEntries,
  busyMatchId,
  flaggedMatchIds,
  formatEntryName,
  onQuickWin,
  onUndoMatch,
  onDirectSlotAssign,
  labels,
}: BracketViewProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [lines, setLines] = useState<ConnectorLine[]>([]);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const rounds = Array.from(new Set(bracketMatches.map((m) => m.round_number))).sort(
    (a, b) => a - b
  );
  const bracketType = bracketMatches[0]?.bracket_type || 'main';

  const getRoundTitle = (rNum: number, rIdx: number) => {
    const total = rounds.length;
    if (bracketType === 'third_place') {
      return locale === 'ru' ? 'За 3-е место' : '3rd Place';
    }
    if (bracketType === 'grand_final') {
      return locale === 'ru' ? 'Гранд-финал' : 'Grand Final';
    }
    if (bracketType === 'losers') {
      if (rIdx === total - 1 && total > 1) {
        return locale === 'ru' ? 'Финал нижней' : 'LB Final';
      }
      return `${labels.round} ${rNum}`;
    }
    // Main / Winners bracket
    const fromEnd = total - 1 - rIdx;
    if (fromEnd === 0) return labels.finalRound;
    if (fromEnd === 1 && total >= 2) return locale === 'ru' ? 'Полуфинал' : 'Semifinals';
    if (fromEnd === 2 && total >= 3) return locale === 'ru' ? '1/4 финала' : 'Quarterfinals';
    if (fromEnd === 3 && total >= 4) return locale === 'ru' ? '1/8 финала' : 'Round of 16';
    return `${labels.round} ${rNum}`;
  };

  const measureConnectors = useCallback(() => {
    const root = canvasRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const nextLines: ConnectorLine[] = [];

    for (const m of bracketMatches) {
      if (!m.next_match_id) continue;
      const fromEl = cardRefs.current.get(m.id);
      const toEl = cardRefs.current.get(m.next_match_id);
      if (!fromEl || !toEl) continue;

      const fromRect = fromEl.getBoundingClientRect();
      const toRect = toEl.getBoundingClientRect();

      const x1 = fromRect.right - rootRect.left;
      const y1 = fromRect.top + fromRect.height * 0.56 - rootRect.top;
      const x2 = toRect.left - rootRect.left;
      // Aim into the divider between the two player rows of the parent match
      const y2 = toRect.top + toRect.height * 0.58 - rootRect.top;
      const midX = x1 + Math.max(12, (x2 - x1) / 2);

      nextLines.push({
        id: `${m.id}->${m.next_match_id}`,
        x1,
        y1,
        x2,
        y2,
        midX,
        active: Boolean(m.winner_entry_id),
      });
    }

    setCanvasSize({ w: root.scrollWidth, h: root.scrollHeight });
    setLines(nextLines);
  }, [bracketMatches]);

  useLayoutEffect(() => {
    measureConnectors();
    const root = canvasRef.current;
    const obs =
      root && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => measureConnectors())
        : null;
    if (obs && root) obs.observe(root);
    window.addEventListener('resize', measureConnectors);
    return () => {
      obs?.disconnect();
      window.removeEventListener('resize', measureConnectors);
    };
  }, [measureConnectors, manualSlotEditMode, isJuryMode]);

  if (rounds.length === 0) return null;

  const setCardRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[#53605A]">{title}</h3>
        <div className="h-px flex-1 bg-[#EFECE4]" />
      </div>

      <div className="overflow-x-auto thin-scroll pb-3">
        <div
          ref={canvasRef}
          className="relative inline-flex gap-10 items-stretch min-w-full py-1 px-1"
        >
          {/* Hand-drawn style orthogonal bracket connectors */}
          {canvasSize.w > 0 && lines.length > 0 && (
            <svg
              width={canvasSize.w}
              height={canvasSize.h}
              className="pointer-events-none absolute inset-0 z-0"
              aria-hidden="true"
            >
              {lines.map((line) => (
                <path
                  key={line.id}
                  d={`M ${line.x1} ${line.y1} H ${line.midX} V ${line.y2} H ${line.x2}`}
                  fill="none"
                  stroke={line.active ? '#14533C' : '#D5CFC1'}
                  strokeWidth={line.active ? 1.75 : 1.25}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={line.active ? 0.85 : 0.9}
                />
              ))}
            </svg>
          )}

          {rounds.map((rNum, rIdx) => {
            const rMatches = bracketMatches
              .filter((m) => m.round_number === rNum)
              .sort((a, b) => a.match_number - b.match_number);

            return (
              <div
                key={rNum}
                className="relative z-10 w-[248px] shrink-0 flex flex-col gap-3"
              >
                <div className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-[#F7F5F0] border border-[#E3DED2]">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-[#53605A]">
                    {getRoundTitle(rNum, rIdx)}
                  </span>
                  <span className="font-num text-[10px] text-[#828E88]">
                    {rMatches.length}
                  </span>
                </div>

                <div className="flex flex-col justify-around flex-1 gap-4">
                  {rMatches.map((m) => {
                    const p1Won = Boolean(m.winner_entry_id && m.winner_entry_id === m.entry1_id);
                    const p2Won = Boolean(m.winner_entry_id && m.winner_entry_id === m.entry2_id);
                    const isCompleted = m.status === 'completed';
                    const isWalkover = m.status === 'walkover';
                    const isLive = m.status === 'in_progress';
                    const isFlagged = flaggedMatchIds.has(m.id);
                    const isBusy = busyMatchId === m.id;
                    const bothPresent = Boolean(m.entry1_id && m.entry2_id);
                    const canScore =
                      isJuryMode &&
                      bothPresent &&
                      !isBusy &&
                      (fastTestMode || m.status === 'in_progress' || m.status === 'completed');

                    return (
                      <div
                        key={m.id}
                        ref={setCardRef(m.id)}
                        className={`rounded-xl overflow-hidden transition-all shadow-[0_1px_2px_rgba(20,30,25,0.04)] ${
                          isFlagged
                            ? 'bg-white border-[1.5px] border-[#C2412D] ring-2 ring-[#C2412D]/15'
                            : isLive
                            ? 'bg-white border-[1.5px] border-[#14533C] ring-2 ring-[#14533C]/12'
                            : isCompleted
                            ? 'bg-white border border-[#BFD7C9]'
                            : isWalkover
                            ? 'bg-[#FAF8F4] border border-dashed border-[#D5CFC1]'
                            : 'bg-white border border-[#DFD9CC]'
                        }`}
                      >
                        {/* Slim top match bar */}
                        <div
                          className={`px-2.5 py-1 text-[11px] flex justify-between items-center border-b ${
                            isLive
                              ? 'bg-[#EBF3EE] border-[#C5DDD0] text-[#14533C]'
                              : isFlagged
                              ? 'bg-[#FBECE9] border-[#F0C9C2] text-[#C2412D]'
                              : 'bg-[#FAF8F4] border-[#EFECE4] text-[#828E88]'
                          }`}
                        >
                          <span className="inline-flex items-center gap-1 font-num font-semibold">
                            {isFlagged && <AlertTriangle className="w-3 h-3 text-[#C2412D]" />}
                            <span>#{m.match_number}</span>
                          </span>

                          <div className="flex items-center gap-2">
                            {m.table_number ? (
                              <span className="inline-flex items-center gap-1 font-num font-bold text-[#14533C]">
                                <CircleDot className="w-2.5 h-2.5 animate-pulse" />
                                {labels.table} #{m.table_number}
                              </span>
                            ) : bothPresent && m.status === 'scheduled' && !fastTestMode && isJuryMode ? (
                              <span className="text-[10px] text-[#92580A] font-medium">
                                {labels.waitingTable}
                              </span>
                            ) : isWalkover ? (
                              <span className="font-num text-[10px] uppercase tracking-wider px-1.5 py-0.2 rounded bg-[#EFECE4] text-[#828E88]">
                                BYE
                              </span>
                            ) : null}

                            {isJuryMode && isCompleted && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => onUndoMatch(m)}
                                className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-[#C2412D] hover:underline disabled:opacity-40"
                              >
                                <RotateCcw className="w-2.5 h-2.5" />
                                <span>Undo</span>
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Manual slot placement OR Player rows */}
                        {isJuryMode && manualSlotEditMode && !isCompleted ? (
                          <div className="p-2 space-y-1.5 bg-[#FDF7EC]/60">
                            <select
                              value={m.entry1_id || ''}
                              onChange={(e) => onDirectSlotAssign(m, 1, e.target.value)}
                              className="w-full border border-[#E3DED2] rounded-md px-2 py-1 text-xs bg-white text-[#18211D]"
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
                              onChange={(e) => onDirectSlotAssign(m, 2, e.target.value)}
                              className="w-full border border-[#E3DED2] rounded-md px-2 py-1 text-xs bg-white text-[#18211D]"
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
                          <div className="divide-y divide-[#EFECE4]">
                            {([1, 2] as const).map((slot) => {
                              const entry = slot === 1 ? m.entry1 : m.entry2;
                              const won = slot === 1 ? p1Won : p2Won;
                              const lost = isCompleted && !won;
                              const score = slot === 1 ? m.entry1_score : m.entry2_score;
                              const seed = entry?.seed_number;

                              return (
                                <button
                                  key={slot}
                                  type="button"
                                  disabled={!canScore}
                                  onClick={() => onQuickWin(m, slot)}
                                  className={`group/row w-full px-2.5 py-2 text-left text-xs flex items-center justify-between gap-2 transition-colors ${
                                    won
                                      ? 'bg-[#EBF3EE]/75 text-[#14533C] font-semibold'
                                      : canScore
                                      ? 'hover:bg-[#F7F5F0] text-[#18211D]'
                                      : 'text-[#18211D] cursor-default'
                                  }`}
                                >
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    {seed ? (
                                      <span className="font-num text-[10px] text-[#9AA49E] w-4 shrink-0 text-right">
                                        {seed}
                                      </span>
                                    ) : null}
                                    <span
                                      className={`truncate ${
                                        !entry
                                          ? 'italic text-[#A4AEA8] font-normal'
                                          : lost
                                          ? 'text-[#828E88]'
                                          : ''
                                      }`}
                                    >
                                      {formatEntryName(entry)}
                                    </span>
                                  </div>

                                  <div className="flex items-center gap-1.5 shrink-0">
                                    {isCompleted && (
                                      <>
                                        {won && <Trophy className="w-3 h-3 text-[#14533C]" />}
                                        <span
                                          className={`font-num text-[11px] font-bold px-1.5 py-0.5 rounded ${
                                            won
                                              ? 'bg-[#14533C] text-white'
                                              : 'bg-[#F1EDE4] text-[#828E88]'
                                          }`}
                                        >
                                          {score}
                                        </span>
                                      </>
                                    )}
                                    {!isCompleted && canScore && (
                                      <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold border border-[#DED8CA] bg-[#FAF8F4] text-[#53605A] group-hover/row:bg-[#14533C] group-hover/row:text-white group-hover/row:border-[#14533C] transition-colors">
                                        {labels.chooseWinner}
                                      </span>
                                    )}
                                  </div>
                                </button>
                              );
                            })}
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
      </div>
    </div>
  );
}
