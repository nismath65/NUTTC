'use client';

import Link from 'next/link';
import { useLanguage } from './LanguageProvider';
import { useAuth } from './AuthProvider';

export default function Navbar() {
  const { locale, setLocale, t } = useLanguage();
  const { isStaff, staffProfile, signOut } = useAuth();

  return (
    <header className="bg-white border-b shadow-xs">
      <nav className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="text-xl font-bold text-blue-600">
          NUTTC
        </Link>

        <div className="flex items-center gap-5">
          <Link href="/" className="text-sm font-medium hover:text-blue-600">
            {t.Nav.tournaments}
          </Link>
          <Link href="/leaderboard" className="text-sm font-medium hover:text-blue-600">
            {t.Nav.leaderboard}
          </Link>

          {isStaff ? (
            <div className="flex items-center gap-3">
              <Link
                href="/staff"
                className="text-xs font-semibold px-3 py-1.5 rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100"
              >
                {t.Nav.staffPanel} ({staffProfile?.role})
              </Link>
              <button
                onClick={signOut}
                className="text-xs text-gray-500 hover:text-red-600 font-medium"
              >
                {locale === 'ru' ? 'Выйти' : 'Logout'}
              </button>
            </div>
          ) : (
            <Link
              href="/login"
              className="text-xs font-semibold px-3 py-1.5 rounded-md border hover:bg-gray-50 text-gray-700"
            >
              {locale === 'ru' ? 'Вход для жюри' : 'Jury Login'}
            </Link>
          )}

          <div className="flex border rounded-md overflow-hidden text-xs font-semibold">
            <button
              onClick={() => setLocale('ru')}
              className={`px-2.5 py-1 ${
                locale === 'ru' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'
              }`}
            >
              RU
            </button>
            <button
              onClick={() => setLocale('en')}
              className={`px-2.5 py-1 ${
                locale === 'en' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'
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