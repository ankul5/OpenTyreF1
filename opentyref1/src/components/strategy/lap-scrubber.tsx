import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Pressable, GestureResponderEvent } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { fetchRaces, fetchStrategyOptions, RaceListItem } from '../../services/api';
import { fetchRaceState } from '../../services/api';
import { OpenTyreF1Theme } from '../../constants/theme';
import { Hairline } from '../hairline';
import { StateBox } from '../state-box';
import { DriverAvatar } from '../driver-avatar';
import { RacePicker } from '../race-picker';
import { usePitwallSelection } from '../../context/pitwall-context';

const EVENT_COLOUR: Record<string, string> = {
  SC: OpenTyreF1Theme.colors.accent,
  VSC: OpenTyreF1Theme.colors.highlight,
  RED: OpenTyreF1Theme.colors.error,
  DOUBLE_YELLOW: '#E0A500',
  YELLOW: '#E0A500',
  OTHER: OpenTyreF1Theme.colors.textTertiary,
  UNKNOWN: OpenTyreF1Theme.colors.textTertiary,
};

/** The shared header every pitwall module mounts: pick a race, pick a
 *  driver, scrub to a lap. Every module reads the result from
 *  `usePitwallSelection()` rather than re-fetching this bootstrap itself. */
export function LapScrubber() {
  const { raceId, raceName, driverId, raceLaps, lap, setRace, setDriverId, setLap } = usePitwallSelection();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [barWidth, setBarWidth] = useState(0);

  const recentRaces = useQuery({
    queryKey: ['races', 'pitwall-default'],
    queryFn: () => fetchRaces({}),
    staleTime: 1000 * 60 * 30,
    enabled: !raceId,
  });
  const effectiveRaceId = raceId ?? recentRaces.data?.items[0]?.raceId ?? null;

  const options = useQuery({
    queryKey: ['strategyOptions', effectiveRaceId],
    queryFn: () => fetchStrategyOptions(effectiveRaceId!),
    enabled: !!effectiveRaceId,
    staleTime: 1000 * 60 * 30,
  });

  // Seed the context the first time a race resolves, and whenever the driver
  // on file no longer raced in the newly chosen race.
  useEffect(() => {
    if (!options.data || !effectiveRaceId) return;
    if (raceId !== effectiveRaceId) {
      setRace(effectiveRaceId, `${options.data.season} ${options.data.raceName}`, options.data.raceLaps);
    }
    const stillValid = driverId && options.data.drivers.some((d) => d.driverId === driverId);
    if (!stillValid) {
      const next = options.data.defaultDriverId ?? options.data.drivers[0]?.driverId ?? null;
      if (next) setDriverId(next);
    }
  }, [options.data, effectiveRaceId, raceId, driverId, setRace, setDriverId]);

  const stateQuery = useQuery({
    queryKey: ['raceState', effectiveRaceId, lap],
    queryFn: () => fetchRaceState(effectiveRaceId!, lap),
    enabled: !!effectiveRaceId && lap > 0,
    staleTime: 1000 * 60 * 5,
  });

  const drivers = options.data?.drivers ?? [];
  const events = stateQuery.data?.events ?? [];
  const clampLap = (n: number) => Math.max(1, Math.min(raceLaps || 1, Math.round(n)));

  const onScrub = (evt: GestureResponderEvent) => {
    if (!barWidth || !raceLaps) return;
    const x = evt.nativeEvent.locationX;
    setLap(clampLap((x / barWidth) * raceLaps));
  };

  if (recentRaces.isError || options.isError) {
    return (
      <StateBox
        icon="cloud-offline-outline"
        text="Could not reach the backend"
        hint="Start the API with --host 0.0.0.0 and check EXPO_PUBLIC_API_URL in .env."
        onRetry={() => { recentRaces.refetch(); options.refetch(); }}
      />
    );
  }

  return (
    <View>
      <TouchableOpacity style={styles.picker} activeOpacity={0.7} onPress={() => setPickerOpen(true)}>
        <View style={{ flex: 1 }}>
          <Text style={styles.pickerLabel}>Race</Text>
          <Text style={styles.pickerValue} numberOfLines={1}>
            {options.data ? `${options.data.season} ${options.data.raceName}` : raceName ?? 'Loading races'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={OpenTyreF1Theme.colors.textTertiary} />
      </TouchableOpacity>
      <Hairline />

      {!options.data ? (
        <StateBox icon="hourglass-outline" text="Loading race data" hint="Reading laps and events." />
      ) : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.driverRow}>
            {drivers.map((d) => {
              const active = d.driverId === driverId;
              return (
                <Pressable
                  key={d.driverId}
                  onPress={() => setDriverId(d.driverId)}
                  style={[styles.driverChip, active && styles.driverChipActive]}
                >
                  <DriverAvatar url={d.headshotUrl} code={d.code} teamColour={d.teamColour} size={26} />
                  <Text style={[styles.driverCode, active && styles.driverCodeActive]}>
                    {d.code ?? d.driverId.slice(0, 3).toUpperCase()}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={styles.lapHeader}>
            <Text style={styles.lapLabel}>LAP</Text>
            <Text style={styles.lapValue}>{lap} / {raceLaps}</Text>
          </View>

          <Pressable
            onPress={onScrub}
            onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
            style={styles.track}
          >
            {events.map((e, i) => {
              if (!raceLaps) return null;
              const from = ((e.deployedLap - 1) / raceLaps) * 100;
              const to = ((((e.clearedLap ?? e.deployedLap)) ) / raceLaps) * 100;
              return (
                <View
                  key={i}
                  style={[
                    styles.eventBand,
                    { left: `${from}%`, width: `${Math.max(to - from, 0.8)}%`, backgroundColor: EVENT_COLOUR[e.type] ?? OpenTyreF1Theme.colors.textTertiary },
                  ]}
                />
              );
            })}
            <View style={[styles.cursor, { left: `${raceLaps ? ((lap - 1) / raceLaps) * 100 : 0}%` }]} />
          </Pressable>

          <View style={styles.stepperRow}>
            <StepButton label="⏮" onPress={() => setLap(1)} />
            <StepButton label="-5" onPress={() => setLap(clampLap(lap - 5))} />
            <StepButton label="-1" onPress={() => setLap(clampLap(lap - 1))} />
            <StepButton label="+1" onPress={() => setLap(clampLap(lap + 1))} />
            <StepButton label="+5" onPress={() => setLap(clampLap(lap + 5))} />
            <StepButton label="⏭" onPress={() => setLap(raceLaps)} />
          </View>

          {stateQuery.data && (
            <Text style={styles.weatherLine}>
              {stateQuery.data.weather.isWet ? 'Wet' : stateQuery.data.weather.isWet === false ? 'Dry' : 'Conditions unknown'}
              {stateQuery.data.weather.trackTemp != null ? ` · ${stateQuery.data.weather.trackTemp.toFixed(0)}°C track` : ''}
              {events.some((e) => e.deployedLap <= lap && lap <= (e.clearedLap ?? e.deployedLap))
                ? ` · ${events.find((e) => e.deployedLap <= lap && lap <= (e.clearedLap ?? e.deployedLap))?.type.replace('_', ' ')} active`
                : ''}
            </Text>
          )}
        </>
      )}

      <RacePicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selectedRaceId={effectiveRaceId}
        onSelect={(r: RaceListItem) => {
          setRace(r.raceId, `${r.season} ${r.raceName}`, 0);
          setDriverId('');
        }}
      />
    </View>
  );
}

function StepButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.stepButton} onPress={onPress} activeOpacity={0.7}>
      <Text style={styles.stepButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  picker: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: OpenTyreF1Theme.spacing.md,
  },
  pickerLabel: {
    fontFamily: OpenTyreF1Theme.fonts.mono, fontSize: 10, letterSpacing: 1,
    color: OpenTyreF1Theme.colors.textTertiary, marginBottom: 3,
  },
  pickerValue: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold, fontSize: 16,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  driverRow: { gap: 8, paddingVertical: OpenTyreF1Theme.spacing.md },
  driverChip: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingLeft: 5, paddingRight: 12, paddingVertical: 5,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    borderWidth: 1, borderColor: OpenTyreF1Theme.colors.hairlineStrong,
  },
  driverChipActive: {
    borderColor: OpenTyreF1Theme.colors.accent,
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised,
  },
  driverCode: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold, fontSize: 12,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  driverCodeActive: { color: OpenTyreF1Theme.colors.textPrimary },
  lapHeader: {
    flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between',
    marginTop: OpenTyreF1Theme.spacing.sm,
  },
  lapLabel: {
    fontFamily: OpenTyreF1Theme.fonts.mono, fontSize: 10, letterSpacing: 1,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  lapValue: {
    fontFamily: OpenTyreF1Theme.fonts.mono, fontSize: 15,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  track: {
    height: 28, borderRadius: OpenTyreF1Theme.borderRadius.md,
    backgroundColor: OpenTyreF1Theme.colors.surfaceSunken,
    marginTop: 8, overflow: 'hidden',
  },
  eventBand: { position: 'absolute', top: 0, bottom: 0, opacity: 0.55 },
  cursor: {
    position: 'absolute', top: 0, bottom: 0, width: 3,
    backgroundColor: OpenTyreF1Theme.colors.textPrimary,
  },
  stepperRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  stepButton: {
    flex: 1, paddingVertical: 8, borderRadius: OpenTyreF1Theme.borderRadius.md,
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised, alignItems: 'center',
  },
  stepButtonText: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold, fontSize: 13,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  weatherLine: {
    fontFamily: OpenTyreF1Theme.fonts.body, fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary, marginTop: 8,
  },
});
