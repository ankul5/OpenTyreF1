import React, { createContext, useContext, useMemo, useState } from 'react';
import type { StintPlan } from '../services/api';

/** What the Strategy tab currently has on screen.
 *
 *  The assistant needs this to answer "explain my strategy" without the user
 *  retyping a stint plan into a chat box. It lives in context rather than in
 *  the query cache because it is unsaved editor state, not fetched data: it
 *  changes on every stepper tap and must not be revalidated or evicted.
 *
 *  Only the inputs are shared, never the simulation result. The assistant
 *  re-runs the simulation server-side so its numbers come from the same code
 *  path as the Strategy tab's, rather than from a snapshot that may be stale.
 */
export interface StrategyDraft {
  raceId: string;
  raceName: string | null;
  driverId: string;
  driverCode: string | null;
  stints: StintPlan[];
  hasRun: boolean;
}

interface StrategyContextValue {
  draft: StrategyDraft | null;
  setDraft: (draft: StrategyDraft | null) => void;
  /** Question handed over from another tab, for the assistant to ask on arrival. */
  pendingQuestion: string | null;
  askAssistant: (question: string) => void;
  clearPendingQuestion: () => void;
}

const StrategyContext = createContext<StrategyContextValue | undefined>(undefined);

export function StrategyDraftProvider({ children }: { children: React.ReactNode }) {
  const [draft, setDraft] = useState<StrategyDraft | null>(null);

  // The Strategy tab's "ask about this" button needs to both navigate to the
  // assistant and give it a question. Routing params would put the question in
  // the URL and re-fire it on every re-render of that route, so it is handed
  // over here instead and cleared once the assistant has taken it.
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);

  const value = useMemo(
    () => ({
      draft,
      setDraft,
      pendingQuestion,
      askAssistant: setPendingQuestion,
      clearPendingQuestion: () => setPendingQuestion(null),
    }),
    [draft, pendingQuestion],
  );
  return <StrategyContext.Provider value={value}>{children}</StrategyContext.Provider>;
}

export function useStrategyDraft() {
  const ctx = useContext(StrategyContext);
  if (!ctx) throw new Error('useStrategyDraft must be used within StrategyDraftProvider');
  return ctx;
}
