import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { fetchRaceRecap, fetchRaceReplay, fetchRaceAnalysis, fetchTelemetryCompare } from '../../services/api';
import { OpenTyreF1Theme } from '../../constants/theme';
import { Hairline } from '../../components/hairline';
import { RaceReplayPlayer } from '../../components/race-replay-player';
import { TyreStrategyChart } from '../../components/charts/tyre-strategy-chart';
import { PositionChart } from '../../components/charts/position-chart';
import { BarRanking, BarRow } from '../../components/charts/bar-ranking';
import { formatLapTime, compoundOf, inkOn } from '../../components/charts/chart-kit';
import { DriverAvatar } from '../../components/driver-avatar';
import { TelemetryPanel, TraceDriver } from '../../components/charts/telemetry-trace';
import { DriverListSkeleton } from '../../components/skeleton';
import { StateBox } from '../../components/state-box';

type Tab = 'replay' | 'strategy' | 'telemetry' | 'pace' | 'control' | 'analysis';

// Order runs from what happened to why: the replay, the strategy behind it,
// the telemetry that explains a given lap, then the aggregate pace/analysis
// views. Telemetry sits next to Strategy because they are read together.
const TABS: { key: Tab; label: string }[] = [
  { key: 'replay', label: 'Replay' },
  { key: 'strategy', label: 'Strategy' },
  { key: 'telemetry', label: 'Telemetry' },
  { key: 'pace', label: 'Pace' },
  { key: 'control', label: 'Race control' },
  { key: 'analysis', label: 'Analysis' },
];

const FLAG_COLOUR: Record<string, string> = {
  RED: '#FF453A',
  YELLOW: '#FFD12E',
  'DOUBLE YELLOW': '#FFD12E',
  GREEN: '#30D158',
  CHEQUERED: '#F5F5F7',
  BLUE: '#3671C6',
};

export default function RaceDetailScreen() {
  const { raceId } = useLocalSearchParams<{ raceId: string }>();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('replay');

  const recapQuery = useQuery({
    queryKey: ['recap', raceId],
    queryFn: () => fetchRaceRecap(raceId!),
    enabled: !!raceId,
  });

  // Replay frames are the heaviest payload, so only fetch on that tab.
  const replayQuery = useQuery({
    queryKey: ['replay', raceId],
    queryFn: () => fetchRaceReplay(raceId!),
    enabled: !!raceId && tab === 'replay',
  });

  const analysisQuery = useQuery({
    queryKey: ['analysis', raceId],
    queryFn: () => fetchRaceAnalysis(raceId!),
    enabled: !!raceId && tab === 'analysis',
  });

  const recap = recapQuery.data;

  // Telemetry compare: default to winner vs runner-up on the winner's
  // fastest lap, picked once the recap is in.
  const [driverA, setDriverA] = useState<string | null>(null);
  const [driverB, setDriverB] = useState<string | null>(null);
  const [compareLap, setCompareLap] = useState<number | null>(null);

  const defaultDriverA = recap?.classification.find((c) => c.position === 1)?.driverId ?? null;
  const defaultDriverB = recap?.classification.find((c) => c.position === 2)?.driverId ?? null;
  const defaultLap = recap?.pace.find((p) => p.driverId === defaultDriverA)?.bestLapNumber
    ?? recap?.pace[0]?.bestLapNumber
    ?? 1;

  const activeDriverA = driverA ?? defaultDriverA;
  const activeDriverB = driverB ?? defaultDriverB;
  const activeLap = compareLap ?? defaultLap;

  const telemetryQuery = useQuery({
    queryKey: ['telemetryCompare', recap?.sessionKey, activeDriverA, activeDriverB, activeLap],
    queryFn: () =>
      fetchTelemetryCompare({
        sessionKey: recap!.sessionKey,
        driverA: activeDriverA!,
        driverB: activeDriverB!,
        lapA: activeLap!,
      }),
    enabled: !!recap?.sessionKey && !!activeDriverA && !!activeDriverB && !!activeLap && tab === 'telemetry',
  });

  const traceDrivers: TraceDriver[] = useMemo(() => {
    if (!telemetryQuery.data || !recap) return [];
    return telemetryQuery.data.drivers.map((d, i) => {
      const meta = recap.classification.find((c) => c.driverId === d.driverId);
      return {
        driverId: d.driverId,
        code: meta?.code ?? d.driverId,
        colour: meta?.teamColour ?? OpenTyreF1Theme.colors.textSecondary,
        lap: d.lap,
        lapTime: d.lapTime,
        samples: d.samples,
      };
    });
  }, [telemetryQuery.data, recap]);
  // Teammates share a team colour — the second trace goes dashed, the same
  // composite-encoding trick position-chart.tsx already uses.
  if (traceDrivers.length === 2 && traceDrivers[0].colour === traceDrivers[1].colour) {
    traceDrivers[1] = { ...traceDrivers[1], dashed: true };
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.backButton}>
          <Ionicons name="chevron-back" size={22} color={OpenTyreF1Theme.colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {recap?.raceName ?? 'Race'}
          </Text>
          {!!recap?.season && (
            <Text style={styles.headerSubtitle}>
              {recap.season} · {recap.circuitName ?? ''}
            </Text>
          )}
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabRow}
      >
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            onPress={() => setTab(t.key)}
            style={[styles.tab, tab === t.key && styles.tabActive]}
            activeOpacity={0.7}
          >
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {recapQuery.isLoading ? (
          <ActivityIndicator color={OpenTyreF1Theme.colors.accent} style={{ marginTop: 40 }} />
        ) : recapQuery.isError || !recap ? (
          <View style={styles.stateBox}>
            <Text style={styles.stateText}>Couldn't load this race.</Text>
            <Text style={styles.stateHint}>
              It may not be ingested yet (OpenF1 covers 2023 onward).
            </Text>
          </View>
        ) : (
          <>
            {tab === 'replay' && (
              <>
                {replayQuery.isLoading ? (
                  <ActivityIndicator color={OpenTyreF1Theme.colors.accent} style={{ marginTop: 40 }} />
                ) : replayQuery.data ? (
                  <RaceReplayPlayer
                    frames={replayQuery.data.frames}
                    title="Race replay"
                    subtitle="Play, pause or scrub through the race lap by lap"
                  />
                ) : (
                  <Text style={styles.stateHint}>No replay data.</Text>
                )}

                <Text style={styles.sectionTitle}>Final classification</Text>
                <Hairline style={{ marginBottom: 4 }} />
                {recap.classification.map((row, i) => (
                  <View key={`${row.driverId}-${i}`}>
                    <View style={styles.resultRow}>
                      <View style={[styles.teamBar, { backgroundColor: row.teamColour }]} />
                      <DriverAvatar url={row.headshotUrl} code={row.code} teamColour={row.teamColour} size={24} />
                      <Text style={styles.resultPos}>{row.position ?? '—'}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.resultName}>{row.code ?? row.name}</Text>
                        <Text style={styles.resultTeam} numberOfLines={1}>
                          {row.team}
                        </Text>
                      </View>
                      <Text style={styles.resultGap}>
                        {row.dns ? 'DNS' : row.dsq ? 'DSQ' : row.dnf ? 'DNF' : row.gap ?? '—'}
                      </Text>
                      <Text style={styles.resultPoints}>
                        {row.points ? `${row.points}` : ''}
                      </Text>
                    </View>
                    {i < recap.classification.length - 1 && <Hairline />}
                  </View>
                ))}
              </>
            )}

            {tab === 'strategy' && (
              <>
                <TyreStrategyChart data={recap.tyreStrategy} totalLaps={recap.totalLaps} />

                <View style={styles.blockGap} />
                <BarRanking
                  title="Pit stop times"
                  subtitle="Stationary time, fastest first"
                  rows={recap.pitStops.map<BarRow>((p, i) => ({
                    key: `${p.driverId}-${p.lap}-${i}`,
                    label: p.code ?? '—',
                    note: p.lap != null ? `lap ${p.lap}` : undefined,
                    value: p.duration,
                    display: `${p.duration.toFixed(2)}s`,
                    color: p.teamColour,
                  }))}
                  emptyMessage="OpenF1 has no pit data for this season (available 2024 onward)."
                  maxRows={12}
                />

                <View style={styles.blockGap} />
                <BarRanking
                  title="Overtakes"
                  subtitle="Positions gained on track"
                  rows={recap.overtakes.map<BarRow>((o) => ({
                    key: o.driverId ?? o.code ?? Math.random().toString(),
                    label: o.code ?? '—',
                    value: o.count,
                    display: `${o.count}`,
                    color: o.teamColour,
                  }))}
                  emptyMessage="No overtake data for this race."
                  maxRows={10}
                />
              </>
            )}

            {tab === 'pace' && (
              <>
                <PositionChart series={recap.positionChart} />

                <View style={styles.blockGap} />
                <BarRanking
                  title="Race pace"
                  subtitle="Median green-flag lap, slowest 25% trimmed"
                  rows={recap.pace.map<BarRow>((p) => ({
                    key: p.driverId,
                    label: p.code ?? '—',
                    note: `best ${formatLapTime(p.bestLap)}`,
                    // Bar length shows the deficit; the leader's bar is the floor.
                    value: (p.deltaToBest ?? 0) + 0.05,
                    display: p.deltaToBest ? `+${p.deltaToBest.toFixed(3)}` : 'fastest',
                    color: p.teamColour,
                  }))}
                  emptyMessage="No lap time data."
                />
              </>
            )}

            {tab === 'control' && (
              <>
                <Text style={styles.sectionTitle}>Race control</Text>
                <Hairline style={{ marginBottom: OpenTyreF1Theme.spacing.sm }} />
                {recap.raceControl.length === 0 ? (
                  <Text style={styles.stateHint}>No race control messages.</Text>
                ) : (
                  recap.raceControl.map((m, i) => (
                    <View key={i} style={styles.controlRow}>
                      <View
                        style={[
                          styles.flagDot,
                          {
                            backgroundColor:
                              FLAG_COLOUR[(m.flag ?? '').toUpperCase()] ??
                              OpenTyreF1Theme.colors.textTertiary,
                          },
                        ]}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.controlMessage}>{m.message}</Text>
                        <Text style={styles.controlMeta}>
                          {m.lap != null ? `Lap ${m.lap}` : '—'}
                          {m.category ? ` · ${m.category}` : ''}
                          {m.scope ? ` · ${m.scope}` : ''}
                        </Text>
                      </View>
                    </View>
                  ))
                )}

                {recap.weather.length > 0 && (
                  <>
                    <Text style={styles.sectionTitle}>Conditions</Text>
                    <Hairline style={{ marginBottom: OpenTyreF1Theme.spacing.sm }} />
                    <View style={styles.weatherRow}>
                      <WeatherStat
                        label="Air"
                        value={`${recap.weather[0].airTemperature?.toFixed(0) ?? '—'}°C`}
                      />
                      <WeatherStat
                        label="Track"
                        value={`${recap.weather[0].trackTemperature?.toFixed(0) ?? '—'}°C`}
                      />
                      <WeatherStat
                        label="Humidity"
                        value={`${recap.weather[0].humidity?.toFixed(0) ?? '—'}%`}
                      />
                      <WeatherStat
                        label="Wind"
                        value={`${recap.weather[0].windSpeed?.toFixed(1) ?? '—'} m/s`}
                      />
                    </View>
                  </>
                )}
              </>
            )}

            {tab === 'analysis' && (
              <>
                {analysisQuery.isLoading ? (
                  <ActivityIndicator color={OpenTyreF1Theme.colors.accent} style={{ marginTop: 40 }} />
                ) : analysisQuery.isError || !analysisQuery.data ? (
                  <StateBox
                    icon="stats-chart-outline"
                    text="Couldn't load analysis for this race."
                    hint="It needs the same lap data as Replay and Pace."
                    onRetry={() => analysisQuery.refetch()}
                  />
                ) : (
                  <>
                    <BarRanking
                      title="Tyre degradation"
                      subtitle="Fuel-corrected seconds lost per lap of tyre age, by stint"
                      rows={analysisQuery.data.degradation.map<BarRow>((d, i) => ({
                        key: `${d.driverId}-${d.stint}-${i}`,
                        label: d.code ?? '—',
                        note: `${d.compound ?? '—'} · stint ${d.stint}`,
                        value: Math.max(d.degradationPerLap, 0.01),
                        display: `${d.degradationPerLap.toFixed(3)}s/lap`,
                        color: d.teamColour,
                      }))}
                      emptyMessage="Not enough clean laps to estimate degradation."
                      maxRows={12}
                    />

                    <View style={styles.blockGap} />
                    <BarRanking
                      title="Teammate gaps"
                      subtitle="Median clean-lap gap between team pairings"
                      rows={analysisQuery.data.teammateGaps.map<BarRow>((t) => ({
                        key: t.team,
                        label: `${t.fasterCode ?? '—'} / ${t.slowerCode ?? '—'}`,
                        note: t.team,
                        value: t.gapSeconds,
                        display: `${t.gapSeconds.toFixed(3)}s`,
                        color: t.teamColour,
                      }))}
                      emptyMessage="No teammate pairings with clean laps."
                    />

                    <View style={styles.blockGap} />
                    <BarRanking
                      title="Biggest gainers"
                      subtitle="Grid position minus finishing position"
                      rows={analysisQuery.data.biggestGainers
                        .filter((g) => g.positionsGained > 0)
                        .map<BarRow>((g) => ({
                          key: g.driverId,
                          label: g.code ?? '—',
                          note: `P${g.grid} → P${g.finish}`,
                          value: g.positionsGained,
                          display: `+${g.positionsGained}`,
                          color: g.teamColour,
                        }))}
                      emptyMessage="No positions gained this race."
                      maxRows={10}
                    />

                    <View style={styles.blockGap} />
                    <BarRanking
                      title="Consistency"
                      subtitle="Std. deviation of clean lap times — lower is steadier"
                      rows={analysisQuery.data.consistency.map<BarRow>((c) => ({
                        key: c.driverId,
                        label: c.code ?? '—',
                        value: c.stdDevSeconds,
                        display: `${c.stdDevSeconds.toFixed(3)}s`,
                        color: c.teamColour,
                      }))}
                      emptyMessage="Not enough clean laps to measure consistency."
                    />

                    <View style={styles.blockGap} />
                    <Text style={styles.sectionTitle}>Dirty air</Text>
                    <Hairline style={{ marginBottom: OpenTyreF1Theme.spacing.sm }} />
                    {analysisQuery.data.dirtyAirLoss.lossSeconds != null ? (
                      <Text style={styles.controlMessage}>
                        Following within 1.5s cost a median {analysisQuery.data.dirtyAirLoss.lossSeconds.toFixed(3)}s
                        per lap ({analysisQuery.data.dirtyAirLoss.followingSampleSize} laps) vs. clear air (
                        {analysisQuery.data.dirtyAirLoss.clearAirSampleSize} laps).
                      </Text>
                    ) : (
                      <Text style={styles.stateHint}>Not enough gap data to measure dirty-air loss.</Text>
                    )}
                  </>
                )}
              </>
            )}

            {tab === 'telemetry' && (
              <>
                <Text style={styles.sectionTitle}>Compare</Text>
                <Hairline style={{ marginBottom: OpenTyreF1Theme.spacing.sm }} />
                <View style={styles.pickerRow}>
                  {recap.classification.slice(0, 10).map((c) => (
                    <TouchableOpacity
                      key={`a-${c.driverId}`}
                      onPress={() => setDriverA(c.driverId)}
                      style={[styles.pickerChip, activeDriverA === c.driverId && styles.pickerChipActiveA]}
                    >
                      <Text style={styles.pickerChipText}>{c.code ?? '—'}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.pickerLabel}>vs.</Text>
                <View style={styles.pickerRow}>
                  {recap.classification.slice(0, 10).map((c) => (
                    <TouchableOpacity
                      key={`b-${c.driverId}`}
                      onPress={() => setDriverB(c.driverId)}
                      style={[styles.pickerChip, activeDriverB === c.driverId && styles.pickerChipActiveB]}
                    >
                      <Text style={styles.pickerChipText}>{c.code ?? '—'}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <View style={styles.blockGap} />
                {telemetryQuery.isLoading ? (
                  <DriverListSkeleton rows={3} />
                ) : telemetryQuery.isError ? (
                  <StateBox
                    icon="cloud-offline-outline"
                    iconColor={OpenTyreF1Theme.colors.error}
                    text="Couldn't load telemetry."
                    hint="This fetches live from OpenF1, so it can be slower or briefly unavailable — try again."
                    onRetry={() => telemetryQuery.refetch()}
                  />
                ) : traceDrivers.length === 2 ? (
                  <TelemetryPanel drivers={traceDrivers} />
                ) : (
                  <Text style={styles.stateHint}>Pick two drivers to compare.</Text>
                )}
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function WeatherStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.weatherStat}>
      <Text style={styles.weatherValue}>{value}</Text>
      <Text style={styles.weatherLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: OpenTyreF1Theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: OpenTyreF1Theme.spacing.lg,
    paddingTop: OpenTyreF1Theme.spacing.sm,
    paddingBottom: OpenTyreF1Theme.spacing.md,
  },
  backButton: { padding: 4 },
  headerTitle: {
    fontFamily: OpenTyreF1Theme.fonts.displayBold,
    fontSize: OpenTyreF1Theme.type.displayMd.fontSize,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  headerSubtitle: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
  },

  tabRow: { gap: 8, paddingHorizontal: OpenTyreF1Theme.spacing.lg, paddingBottom: OpenTyreF1Theme.spacing.md },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    borderWidth: 1,
    borderColor: OpenTyreF1Theme.colors.hairline,
    height: 34,
  },
  tabActive: {
    backgroundColor: OpenTyreF1Theme.colors.accent,
    borderColor: OpenTyreF1Theme.colors.accent,
  },
  tabText: {
    fontFamily: OpenTyreF1Theme.fonts.bodyMedium,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  tabTextActive: { color: OpenTyreF1Theme.colors.onAccent },

  content: { paddingHorizontal: OpenTyreF1Theme.spacing.lg, paddingBottom: 72 },
  blockGap: { height: OpenTyreF1Theme.spacing.xxl },

  pickerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pickerLabel: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginVertical: 6,
  },
  pickerChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    borderWidth: 1,
    borderColor: OpenTyreF1Theme.colors.hairlineStrong,
  },
  pickerChipActiveA: {
    backgroundColor: OpenTyreF1Theme.colors.accent,
    borderColor: OpenTyreF1Theme.colors.accent,
  },
  pickerChipActiveB: {
    backgroundColor: OpenTyreF1Theme.colors.highlight,
    borderColor: OpenTyreF1Theme.colors.highlight,
  },
  pickerChipText: {
    fontFamily: OpenTyreF1Theme.fonts.bodyMedium,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textPrimary,
  },

  sectionTitle: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 15,
    color: OpenTyreF1Theme.colors.textPrimary,
    marginTop: OpenTyreF1Theme.spacing.xl,
    marginBottom: OpenTyreF1Theme.spacing.sm,
  },

  resultRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 10 },
  teamBar: { width: 3, height: 26, borderRadius: 2 },
  resultPos: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
    width: 22,
  },
  resultName: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  resultTeam: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 10,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  resultGap: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textSecondary,
    width: 72,
    textAlign: 'right',
  },
  resultPoints: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.highlight,
    width: 26,
    textAlign: 'right',
  },

  controlRow: { flexDirection: 'row', gap: 10, paddingVertical: 10, alignItems: 'flex-start' },
  flagDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  controlMessage: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  controlMeta: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 10,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 2,
  },

  weatherRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  weatherStat: { alignItems: 'flex-start' },
  weatherValue: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 18,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  weatherLabel: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 2,
  },

  stateBox: { alignItems: 'center', gap: 6, paddingVertical: 40 },
  stateText: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  stateHint: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
    textAlign: 'center',
  },
});
