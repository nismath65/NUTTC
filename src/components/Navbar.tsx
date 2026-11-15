'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut, ShieldCheck, Lock } from 'lucide-react';
import { useLanguage } from './LanguageProvider';
import { useAuth } from './AuthProvider';
import ClubEmblem from './ClubEmblem';

export default function Navbar() {
  const pathname = usePathname();
  const { locale, setLocale, t } = useLanguage();
  const { isStaff, staffProfile, signOut } = useAuth();

  const isTournamentsActive = pathname === '/' || pathname.startsWith('/tournaments');
  const isLeaderboardActive = pathname.startsWith('/leaderboard');
  const isStaffActive = pathname.startsWith('/staff');

  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-xs border-b border-[#E3DED2]">
      <nav className="max-w-7xl mx-auto px-4 sm:px-6 h-15 flex items-center justify-between gap-3">
        <Link href="/" className="flex items-center gap-2.5 group shrink-0">
          <ClubEmblem className="w-7 h-7 transition-transform duration-200 group-hover:-rotate-6" />
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-extrabold tracking-tight text-[#14533C]">
              NUTTC
            </span>
            <span className="hidden md:inline-block text-[11px] font-medium text-[#828E88] border-l border-[#E3DED2] pl-2">
              Table Tennis Club
            </span>
          </div>
        </Link>

        <div className="flex items-center gap-1.5 sm:gap-3">
          <div className="flex items-center bg-[#F1EDE4] p-0.5 rounded-lg border border-[#E3DED2]">
            <Link
              href="/"
              className={`px-2.5 sm:px-3 py-1 rounded-md text-xs sm:text-sm font-medium transition-colors ${
                isTournamentsActive
                  ? 'bg-white text-[#14533C] font-semibold shadow-[0_1px_2px_rgba(20,30,25,0.06)]'
                  : 'text-[#53605A] hover:text-[#18211D]'
              }`}
            >
              {t.Nav.tournaments}
            </Link>
            <Link
              href="/leaderboard"
              className={`px-2.5 sm:px-3 py-1 rounded-md text-xs sm:text-sm font-medium transition-colors ${
                isLeaderboardActive
                  ? 'bg-white text-[#14533C] font-semibold shadow-[0_1px_2px_rgba(20,30,25,0.06)]'
                  : 'text-[#53605A] hover:text-[#18211D]'
              }`}
            >
              {t.Nav.leaderboard}
            </Link>
          </div>

          {isStaff ? (
            <div className="flex items-center gap-1.5">
              <Link
                href="/staff"
                className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 sm:px-3 py-1.5 rounded-lg border transition-colors ${
                  isStaffActive
                    ? 'bg-[#14533C] text-white border-[#14533C]'
                    : 'bg-[#EBF3EE] text-[#14533C] border-[#C5DDD0] hover:bg-[#DCEBE3]'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                <span className="hidden sm:inline">{t.Nav.staffPanel}</span>
                <span className="font-num text-[10px] opacity-80">
                  ({staffProfile?.role})
                </span>
              </Link>
              <button
                type="button"
                onClick={signOut}
                title={locale === 'ru' ? 'Выйти' : 'Logout'}
                className="inline-flex items-center gap-1 text-xs text-[#53605A] hover:text-[#C2412D] px-2 py-1.5 rounded-lg hover:bg-[#FBECE9] transition-colors font-medium"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="hidden md:inline">
                  {locale === 'ru' ? 'Выйти' : 'Logout'}
                </span>
              </button>
            </div>
          ) : (
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 sm:px-3 py-1.5 rounded-lg border border-[#E3DED2] bg-white hover:bg-[#F1EDE4] text-[#53605A] hover:text-[#18211D] transition-colors"
            >
              <Lock className="w-3.5 h-3.5 text-[#828E88]" />
              <span className="hidden sm:inline">
                {locale === 'ru' ? 'Вход для жюри' : 'Jury Login'}
              </span>
            </Link>
          )}

          <div
            className="flex border border-[#E3DED2] rounded-lg overflow-hidden text-[11px] font-bold bg-[#F1EDE4]"
            role="group"
            aria-label="Language"
          >
            <button
              type="button"
              onClick={() => setLocale('ru')}
              className={`px-2 py-1.5 transition-colors ${
                locale === 'ru'
                  ? 'bg-[#14533C] text-white'
                  : 'text-[#53605A] hover:text-[#18211D]'
              }`}
            >
              RU
            </button>
            <button
              type="button"
              onClick={() => setLocale('en')}
              className={`px-2 py-1.5 transition-colors ${
                locale === 'en'
                  ? 'bg-[#14533C] text-white'
                  : 'text-[#53605A] hover:text-[#18211D]'
              }`}
            >
              EN
            </button>
          </div>
        </div>
      </nav>
    </header>
  );
}