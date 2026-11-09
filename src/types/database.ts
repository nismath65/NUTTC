export type PlayerCategory = 'student' | 'staff' | 'professor' | 'guest';
export type MatchType = 'singles' | 'doubles';
export type TournamentStatus = 'scheduled' | 'registration_open' | 'check_in' | 'in_progress' | 'completed' | 'archived';
export type AttendanceStatus = 'registered' | 'checked_in' | 'no_show';
export type StageFormat = 'single_elimination' | 'double_elimination' | 'round_robin' | 'swiss';
export type StageStatus = 'pending' | 'in_progress' | 'completed';
export type MatchStatus = 'scheduled' | 'in_progress' | 'completed' | 'walkover';

export interface Player {
  id: string;
  full_name: string;
  university_id: string | null;
  category: PlayerCategory;
  elo_rating: number;
  wins: number;
  losses: number;
}

export interface Tournament {
  id: string;
  title: string;
  description: string | null;
  event_date: string;
  type: MatchType;
  best_of: number;
  is_rated: boolean;
  status: TournamentStatus;
}

export interface TournamentEntry {
  id: string;
  tournament_id: string;
  player1_id: string;
  player2_id: string | null;
  attendance: AttendanceStatus;
  seed_elo: number;
  seed_number: number | null;
  final_placement: number | null;
  player1?: Player;
  player2?: Player | null;
}

export interface TournamentStage {
  id: string;
  tournament_id: string;
  stage_order: number;
  name: string;
  format: StageFormat;
  config: Record<string, unknown>;
  status: StageStatus;
}

export interface Match {
  id: string;
  tournament_id: string;
  stage_id: string;
  round_number: number;
  match_number: number;
  group_number: number | null;
  bracket_type: string;
  entry1_id: string | null;
  entry2_id: string | null;
  entry1_score: number;
  entry2_score: number;
  winner_entry_id: string | null;
  next_match_id: string | null;
  next_match_slot: 1 | 2 | null;
  loser_next_match_id: string | null;
  loser_next_match_slot: 1 | 2 | null;
  table_number: number | null;
  status: MatchStatus;
  entry1?: TournamentEntry | null;
  entry2?: TournamentEntry | null;
}