import './globals.css';
import type { Metadata } from 'next';
import { LanguageProvider } from '@/components/LanguageProvider';
import { AuthProvider } from '@/components/AuthProvider';
import Navbar from '@/components/Navbar';

export const metadata: Metadata = {
  title: 'NUTTC — Table Tennis Club',
  description: 'Турниры и рейтинг клуба настольного тенниса',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru">
      <body className="bg-[#F7F5F0] text-[#18211D] min-h-screen antialiased selection:bg-[#B91C1C]/15 selection:text-[#B91C1C]">
        <LanguageProvider>
          <AuthProvider>
            <Navbar />
            {children}
          </AuthProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}