'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import ruMessages from '../../messages/ru.json';
import enMessages from '../../messages/en.json';

type Locale = 'ru' | 'en';
type Messages = typeof ruMessages;

interface LanguageContextType {
  locale: Locale;
  setLocale: (lang: Locale) => void;
  t: Messages;
}

const dictionaries: Record<Locale, Messages> = {
  ru: ruMessages,
  en: enMessages,
};

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('ru');

  // Load saved language choice from browser localStorage on startup
  useEffect(() => {
    const saved = localStorage.getItem('nuttc_locale') as Locale;
    if (saved === 'ru' || saved === 'en') {
      setLocaleState(saved);
    }
  }, []);

  const setLocale = (lang: Locale) => {
    setLocaleState(lang);
    localStorage.setItem('nuttc_locale', lang);
  };

  return (
    <LanguageContext.Provider value={{ locale, setLocale, t: dictionaries[locale] }}>
      {children}
    </LanguageContext.Provider>
  );
}

// Custom hook so any component can easily grab translations
export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used inside a LanguageProvider');
  }
  return context;
}