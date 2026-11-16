'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useLanguage } from '@/components/LanguageProvider';
import ClubEmblem from '@/components/ClubEmblem';

export default function LoginPage() {
  const router = useRouter();
  const { locale } = useLanguage();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg(null);

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      setErrorMsg(error.message);
      setLoading(false);
      return;
    }

    router.push('/staff');
    router.refresh();
  };

  return (
    <main className="max-w-md mx-auto px-4 mt-14 sm:mt-20">
      <div className="bg-white border border-[#E3DED2] rounded-xl p-6 sm:p-7 shadow-[0_2px_8px_rgba(20,30,25,0.05)] space-y-6">
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="w-11 h-11 rounded-full bg-[#FEF2F2] border border-[#FECACA] flex items-center justify-center">
            <ClubEmblem className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-bold text-[#18211D]">
            {locale === 'ru' ? 'Вход для Жюри и Организаторов' : 'Jury & Staff Login'}
          </h1>
          <p className="text-xs text-[#828E88]">
            {locale === 'ru'
              ? 'Доступ для судей и организаторов клуба NUTTC'
              : 'Access for NUTTC referees and event staff'}
          </p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-[#53605A] mb-1.5">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jury@nu.edu.kz"
              className="w-full border border-[#E3DED2] bg-[#FAF8F4] rounded-lg px-3 py-2 text-sm text-[#18211D]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#53605A] mb-1.5">
              {locale === 'ru' ? 'Пароль' : 'Password'}
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-[#E3DED2] bg-[#FAF8F4] rounded-lg px-3 py-2 text-sm text-[#18211D]"
            />
          </div>

          {errorMsg && (
            <p className="text-xs text-[#C2412D] bg-[#FBECE9] border border-[#F0C9C2] rounded-lg px-3 py-2 font-medium">
              {errorMsg}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full inline-flex items-center justify-center gap-2 bg-[#B91C1C] text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-[#991B1B] transition-colors disabled:opacity-50"
          >
            <Lock className="w-4 h-4" />
            <span>
              {loading
                ? '...'
                : locale === 'ru'
                ? 'Войти в панель жюри'
                : 'Sign In'}
            </span>
          </button>
        </form>
      </div>
    </main>
  );
}