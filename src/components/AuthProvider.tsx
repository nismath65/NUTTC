'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

export type StaffRole = 'jury' | 'head_of_event' | 'admin';

export interface StaffProfile {
  id: string;
  full_name: string;
  role: StaffRole;
}

interface AuthContextType {
  user: User | null;
  staffProfile: StaffProfile | null;
  isStaff: boolean;
  loadingAuth: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  staffProfile: null,
  isStaff: false,
  loadingAuth: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [staffProfile, setStaffProfile] = useState<StaffProfile | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);

  const loadStaffProfile = async (currentUser: User | null) => {
    if (!currentUser) {
      setStaffProfile(null);
      setLoadingAuth(false);
      return;
    }
    const { data } = await supabase
      .from('staff_profiles')
      .select('id, full_name, role')
      .eq('id', currentUser.id)
      .maybeSingle();

    setStaffProfile((data as StaffProfile) || null);
    setLoadingAuth(false);
  };

  useEffect(() => {
    // 1. Check active session on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      const currentUser = session?.user ?? null;
      setUser(currentUser);
      loadStaffProfile(currentUser);
    });

    // 2. Listen for login/logout events
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      const currentUser = session?.user ?? null;
      setUser(currentUser);
      loadStaffProfile(currentUser);
    });

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setStaffProfile(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        staffProfile,
        isStaff: Boolean(user && staffProfile),
        loadingAuth,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}