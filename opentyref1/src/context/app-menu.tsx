import React, { createContext, useContext, useMemo, useState } from 'react';

interface AppMenuContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

const AppMenuContext = createContext<AppMenuContextValue | undefined>(undefined);

export function AppMenuProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const value = useMemo(
    () => ({ isOpen, open: () => setIsOpen(true), close: () => setIsOpen(false) }),
    [isOpen],
  );
  return <AppMenuContext.Provider value={value}>{children}</AppMenuContext.Provider>;
}

export function useAppMenu() {
  const ctx = useContext(AppMenuContext);
  if (!ctx) throw new Error('useAppMenu must be used within AppMenuProvider');
  return ctx;
}
