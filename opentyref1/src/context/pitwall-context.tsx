import React, { createContext, useContext, useMemo, useState } from 'react';

/** The race/driver/lap the pitwall modules currently agree on.
 *
 *  Kept separate from `StrategyDraftProvider` (the stint-plan draft the
 *  assistant reads): that one is unsaved editor state for a specific stint
 *  plan, this one is just "which real race, driver and moment are we
 *  looking at" — the picker sets it once and every module screen
 *  (safety-car, flags, weather, overtake, defence, outcome, risk) reads and
 *  can adjust it via the shared lap scrubber.
 */
interface PitwallSelection {
  raceId: string | null;
  raceName: string | null;
  driverId: string | null;
  raceLaps: number;
  lap: number;
}

interface PitwallContextValue extends PitwallSelection {
  setRace: (raceId: string, raceName: string | null, raceLaps: number) => void;
  setDriverId: (driverId: string) => void;
  setLap: (lap: number) => void;
}

const PitwallContext = createContext<PitwallContextValue | undefined>(undefined);

export function PitwallSelectionProvider({ children }: { children: React.ReactNode }) {
  const [selection, setSelection] = useState<PitwallSelection>({
    raceId: null, raceName: null, driverId: null, raceLaps: 0, lap: 1,
  });

  const value = useMemo<PitwallContextValue>(
    () => ({
      ...selection,
      setRace: (raceId, raceName, raceLaps) =>
        setSelection((prev) => ({
          ...prev, raceId, raceName, raceLaps,
          lap: Math.min(prev.lap || raceLaps, raceLaps) || raceLaps,
        })),
      setDriverId: (driverId) => setSelection((prev) => ({ ...prev, driverId })),
      setLap: (lap) => setSelection((prev) => ({ ...prev, lap })),
    }),
    [selection],
  );

  return <PitwallContext.Provider value={value}>{children}</PitwallContext.Provider>;
}

export function usePitwallSelection() {
  const ctx = useContext(PitwallContext);
  if (!ctx) throw new Error('usePitwallSelection must be used within PitwallSelectionProvider');
  return ctx;
}
