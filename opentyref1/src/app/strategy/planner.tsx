import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  fetchRaces, fetchStrategyOptions, runSimulation,
  Compound, RaceListItem, SimulationResult, StintPlan, StrategyDriverOption,
} from '../../services/api';
import { OpenTyreF1Theme } from '../../constants/theme';
import { Hairline } from '../../components/hairline';
import { StateBox } from '../../components/state-box';
import { DriverAvatar } from '../../components/driver-avatar';
import { RacePicker } from '../../components/race-picker';
import { RaceReplayPlayer } from '../../components/race-replay-player';
import { DegradationChart } from '../../components/charts/degradation-chart';
import { compoundOf, inkOn, formatLapTime } from '../../components/charts/chart-kit';
import { useStrategyDraft } from '../../context/strategy-context';

const MAX_STINTS = 6;

function formatClock(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const secs = rest.toFixed(3).padStart(6, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

function ordinal(position: number | null) {
  return position == null ? 'unclassified' : `P${position}`;
}

/** A sensible opening plan when a driver has no usable real stint data:
 *  a two-stopper split evenly across the distance. */
function defaultPlan(raceLaps: number, compounds: Compound[]): StintPlan[] {
  const medium = compounds.includes('MEDIUM') ? 'MEDIUM' : compounds[0];
  const hard = compounds.includes('HARD') ? 'HARD' : compounds[compounds.length - 1];
  const first = Math.round(raceLaps / 3);
  const second = Math.round(raceLaps / 3);
  return [
    { compound: medium, laps: first },
    { compound: hard, laps: second },
    { compound: medium, laps: raceLaps - first - second },
  ].filter((s) => s.laps > 0);
}

function planFromDriver(driver: StrategyDriverOption, raceLaps: number, compounds: Compound[]): StintPlan[] {
  const real = driver.actualStints
    .filter((s) => s.compound && s.laps > 0)
    .map((s) => ({ compound: s.compound!.toUpperCase() as Compound, laps: s.laps }));
  return real.length ? real : defaultPlan(raceLaps, compounds);
}

export default function StrategyPlannerScreen() {
  const { setDraft, askAssistant } = useStrategyDraft();
  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [race, setRace] = useState<RaceListItem | null>(null);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [stints, setStints] = useState<StintPlan[]>([]);
  const [result, setResult] = useState<SimulationResult | null>(null);

  // Opening race: the most recent one with ingested lap data, so the screen is
  // usable the moment it mounts rather than demanding a choice first.
  const recentRaces = useQuery({
    queryKey: ['races', 'strategy-default'],
    queryFn: () => fetchRaces({}),
    staleTime: 1000 * 60 * 30,
  });
  const raceId = race?.raceId ?? recentRaces.data?.items[0]?.raceId ?? null;

  const options = useQuery({
    queryKey: ['strategyOptions', raceId],
    queryFn: () => fetchStrategyOptions(raceId!),
    enabled: !!raceId,
    staleTime: 1000 * 60 * 30,
  });

  const data = options.data;
  const driver = data?.drivers.find((d) => d.driverId === driverId) ?? null;

  // Seed the driver and their real stint plan whenever the race changes.
  useEffect(() => {
    if (!data) return;
    const stillValid = data.drivers.some((d) => d.driverId === driverId);
    if (stillValid) return;
    const next = data.drivers.find((d) => d.driverId === data.defaultDriverId) ?? data.drivers[0];
    if (!next) return;
    setDriverId(next.driverId);
    setStints(planFromDriver(next, data.raceLaps, data.compounds));
    setResult(null);
  }, [data, driverId]);

  const simulation = useMutation({
    mutationFn: () => runSimulation({ raceId: raceId!, driverId: driverId!, stints }),
    onSuccess: setResult,
  });

  // Publish the plan so the Assistant tab can explain it without the user
  // retyping a stint sequence into a chat box.
  useEffect(() => {
    if (!raceId || !driverId || !stints.length) {
      setDraft(null);
      return;
    }
    setDraft({
      raceId,
      raceName: data ? `${data.season} ${data.raceName}` : null,
      driverId,
      driverCode: driver?.code ?? null,
      stints,
      hasRun: !!result,
    });
  }, [raceId, driverId, stints, data, driver, result, setDraft]);

  const totalLaps = useMemo(() => stints.reduce((sum, s) => sum + s.laps, 0), [stints]);
  const raceLaps = data?.raceLaps ?? 0;
  const lapsMatch = totalLaps === raceLaps;

  const lapRanges = useMemo(() => {
    let cursor = 1;
    return stints.map((s) => {
      const range = { from: cursor, to: cursor + s.laps - 1 };
      cursor += s.laps;
      return range;
    });
  }, [stints]);

  const compounds = data?.compounds ?? ['SOFT', 'MEDIUM', 'HARD'];

  const cycleCompound = (index: number) =>
    setStints((prev) =>
      prev.map((s, i) => {
        if (i !== index) return s;
        const at = compounds.indexOf(s.compound);
        return { ...s, compound: compounds[(at + 1) % compounds.length] };
      }),
    );

  const adjustLaps = (index: number, delta: number) =>
    setStints((prev) =>
      prev.map((s, i) => (i === index ? { ...s, laps: Math.max(1, Math.min(90, s.laps + delta)) } : s)),
    );

  const addStint = () =>
    setStints((prev) =>
      prev.length >= MAX_STINTS ? prev : [...prev, { compound: compounds[0], laps: 10 }],
    );

  const removeStint = (index: number) =>
    setStints((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));

  /** Absorb the shortfall or overflow into the longest stint, so "make it fit"
   *  is one tap rather than a dozen presses on a stepper. */
  const fitToDistance = () =>
    setStints((prev) => {
      if (!raceLaps || !prev.length) return prev;
      const difference = raceLaps - prev.reduce((sum, s) => sum + s.laps, 0);
      if (difference === 0) return prev;
      let longest = 0;
      prev.forEach((s, i) => {
        if (s.laps > prev[longest].laps) longest = i;
      });
      return prev.map((s, i) =>
        i === longest ? { ...s, laps: Math.max(1, s.laps + difference) } : s,
      );
    });

  const loadActual = () => {
    if (!driver || !data) return;
    setStints(planFromDriver(driver, data.raceLaps, data.compounds));
    setResult(null);
  };

  const canRun = !!raceId && !!driverId && stints.length > 0 && !simulation.isPending;

  // Hand the plan to the assistant. The stint plan is already published to
  // context above, so the question only has to name what to explain — the
  // assistant re-runs the simulation itself rather than trusting these numbers.
  const askAboutStrategy = () => {
    askAssistant('Explain why my strategy loses time');
    router.push('/assistant');
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.backButton}>
          <Ionicons name="chevron-back" size={22} color={OpenTyreF1Theme.colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Stint planner</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.pageSubtitle}>
          Build a stint plan, then run it against what really happened.
        </Text>

        {/* Race */}
        <TouchableOpacity style={styles.picker} activeOpacity={0.7} onPress={() => setPickerOpen(true)}>
          <View style={{ flex: 1 }}>
            <Text style={styles.pickerLabel}>Race</Text>
            <Text style={styles.pickerValue} numberOfLines={1}>
              {data ? `${data.season} ${data.raceName}` : 'Loading races'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={OpenTyreF1Theme.colors.textTertiary} />
        </TouchableOpacity>
        <Hairline />

        {recentRaces.isError || options.isError ? (
          <StateBox
            icon="cloud-offline-outline"
            text="Could not reach the backend"
            hint="Start the API with --host 0.0.0.0 and check EXPO_PUBLIC_API_URL in .env."
            onRetry={() => {
              recentRaces.refetch();
              options.refetch();
            }}
          />
        ) : !data ? (
          <StateBox icon="hourglass-outline" text="Loading race data" hint="Reading laps, stints and pit data." />
        ) : (
          <>
            {/* Driver */}
            <Text style={styles.sectionTitle}>Driver</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.driverRow}
            >
              {data.drivers.map((d) => {
                const active = d.driverId === driverId;
                return (
                  <Pressable
                    key={d.driverId}
                    onPress={() => {
                      setDriverId(d.driverId);
                      setStints(planFromDriver(d, data.raceLaps, data.compounds));
                      setResult(null);
                    }}
                    style={[styles.driverChip, active && styles.driverChipActive]}
                  >
                    <DriverAvatar
                      url={d.headshotUrl}
                      code={d.code}
                      teamColour={d.teamColour}
                      size={28}
                    />
                    <View>
                      <Text style={[styles.driverCode, active && styles.driverCodeActive]}>
                        {d.code ?? d.driverId.slice(0, 3).toUpperCase()}
                      </Text>
                      <Text style={styles.driverFinish}>
                        {d.dnf ? 'DNF' : ordinal(d.finishPosition)}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>

            {/* Stint timeline */}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Stint plan</Text>
              <Text style={[styles.lapCount, !lapsMatch && styles.lapCountOff]}>
                {totalLaps} / {raceLaps} laps
              </Text>
            </View>

            <View style={styles.timelineTrack}>
              {stints.map((s, i) => {
                const meta = compoundOf(s.compound);
                return (
                  <TouchableOpacity
                    key={i}
                    activeOpacity={0.85}
                    onPress={() => cycleCompound(i)}
                    onLongPress={() => removeStint(i)}
                    style={{ flex: s.laps, backgroundColor: meta.color }}
                  >
                    <View style={styles.timelineSegmentInner}>
                      <Text style={[styles.timelineCompoundText, { color: inkOn(meta.color) }]}>
                        {meta.letter}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={styles.timelineFooter}>
              <Text style={styles.timelineEndLabel}>START</Text>
              <Text style={styles.timelineEndLabel}>FINISH</Text>
            </View>

            <View style={styles.stintControls}>
              {stints.map((s, i) => {
                const meta = compoundOf(s.compound);
                return (
                  <View key={i} style={styles.stintControlRow}>
                    <View style={[styles.stintSwatch, { backgroundColor: meta.color }]} />
                    <Text style={styles.stintRangeText}>
                      {meta.label}, lap {lapRanges[i].from} to {lapRanges[i].to}
                    </Text>
                    <View style={styles.stepperRow}>
                      <TouchableOpacity onPress={() => adjustLaps(i, -1)} hitSlop={10} style={styles.stepperButton}>
                        <Ionicons name="remove" size={14} color={OpenTyreF1Theme.colors.textSecondary} />
                      </TouchableOpacity>
                      <Text style={styles.stintLaps}>{s.laps}</Text>
                      <TouchableOpacity onPress={() => adjustLaps(i, 1)} hitSlop={10} style={styles.stepperButton}>
                        <Ionicons name="add" size={14} color={OpenTyreF1Theme.colors.textSecondary} />
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
            </View>

            <View style={styles.actionRow}>
              {stints.length < MAX_STINTS && (
                <TouchableOpacity onPress={addStint} style={styles.textButton} activeOpacity={0.7}>
                  <Ionicons name="add-circle-outline" size={16} color={OpenTyreF1Theme.colors.accent} />
                  <Text style={styles.textButtonLabel}>Add stint</Text>
                </TouchableOpacity>
              )}
              {!lapsMatch && (
                <TouchableOpacity onPress={fitToDistance} style={styles.textButton} activeOpacity={0.7}>
                  <Ionicons name="resize-outline" size={16} color={OpenTyreF1Theme.colors.accent} />
                  <Text style={styles.textButtonLabel}>Fit to {raceLaps} laps</Text>
                </TouchableOpacity>
              )}
              {driver && driver.actualStints.length > 0 && (
                <TouchableOpacity onPress={loadActual} style={styles.textButton} activeOpacity={0.7}>
                  <Ionicons name="refresh-outline" size={16} color={OpenTyreF1Theme.colors.accent} />
                  <Text style={styles.textButtonLabel}>Load real plan</Text>
                </TouchableOpacity>
              )}
            </View>
            <Text style={styles.hint}>
              Tap a block to change compound, long-press to remove it.
            </Text>

            <TouchableOpacity
              style={[styles.runButton, !canRun && styles.runButtonDisabled]}
              activeOpacity={0.85}
              disabled={!canRun}
              onPress={() => simulation.mutate()}
            >
              <Ionicons
                name={simulation.isPending ? 'hourglass' : 'play'}
                size={16}
                color={OpenTyreF1Theme.colors.onAccent}
              />
              <Text style={styles.runButtonText}>
                {simulation.isPending ? 'Simulating' : 'Run simulation'}
              </Text>
            </TouchableOpacity>

            {/* Results */}
            {simulation.isError ? (
              <StateBox
                icon="warning-outline"
                iconColor={OpenTyreF1Theme.colors.error}
                text="The simulation did not run"
                hint={
                  (simulation.error as any)?.response?.data?.detail ??
                  'The backend rejected the request or is unreachable.'
                }
                onRetry={() => simulation.mutate()}
              />
            ) : !result ? (
              <View style={styles.emptyResults}>
                <Ionicons name="speedometer-outline" size={22} color={OpenTyreF1Theme.colors.textTertiary} />
                <Text style={styles.emptyResultsText}>
                  Run the plan to see predicted lap times, a projected finish, and a lap-by-lap
                  replay against the real field.
                </Text>
              </View>
            ) : (
              <SimulationResultView result={result} onAskAssistant={askAboutStrategy} />
            )}
          </>
        )}
      </ScrollView>

      <RacePicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(r) => {
          setRace(r);
          setDriverId(null);
          setResult(null);
        }}
        selectedRaceId={raceId}
      />
    </SafeAreaView>
  );
}

function SimulationResultView({
  result,
  onAskAssistant,
}: {
  result: SimulationResult;
  onAskAssistant: () => void;
}) {
  const delta = result.projectedFinishDelta;
  const faster = delta != null && delta < 0;
  const margin = result.uncertainty.totalTimeMarginSeconds;

  return (
    <View>
      <Text style={[styles.sectionTitle, { marginTop: OpenTyreF1Theme.spacing.xxl }]}>Result</Text>
      <Hairline style={{ marginBottom: OpenTyreF1Theme.spacing.md }} />

      <View style={styles.deltaBlock}>
        <Text style={styles.deltaLabel}>
          Against {result.driver.code ?? 'their'} real race, over {result.comparedOverLaps} laps
        </Text>
        <Text
          style={[
            styles.deltaValue,
            { color: faster ? OpenTyreF1Theme.colors.success : OpenTyreF1Theme.colors.error },
          ]}
        >
          {delta == null ? 'n/a' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}s`}
        </Text>
        {margin != null && (
          <Text style={styles.deltaMargin}>
            give or take {margin.toFixed(0)}s of model error
          </Text>
        )}
      </View>

      <View style={styles.resultRow}>
        <Text style={styles.resultLabel}>Projected finish</Text>
        <Text style={styles.resultValue}>
          {ordinal(result.projectedPosition)}
          {result.actual.position != null && (
            <Text style={styles.resultValueMuted}>  was {ordinal(result.actual.position)}</Text>
          )}
        </Text>
      </View>
      <Hairline />
      <View style={styles.resultRow}>
        <Text style={styles.resultLabel}>Predicted race time</Text>
        <Text style={styles.resultValue}>{formatClock(result.totalTime)}</Text>
      </View>
      <Hairline />
      <View style={styles.resultRow}>
        <Text style={styles.resultLabel}>Pit stops</Text>
        <Text style={styles.resultValue}>
          {result.pitStops}
          <Text style={styles.resultValueMuted}>  {result.timeLostInPits.toFixed(1)}s lost</Text>
        </Text>
      </View>
      <Hairline />
      <View style={styles.resultRow}>
        <Text style={styles.resultLabel}>Pit loss used</Text>
        <Text style={styles.resultValue}>
          {result.pitLossSeconds.toFixed(1)}s
          <Text style={styles.resultValueMuted}>  {result.pitLossSource}</Text>
        </Text>
      </View>
      {result.neutralisedLaps > 0 && (
        <>
          <Hairline />
          <View style={styles.resultRow}>
            <Text style={styles.resultLabel}>Laps behind a safety car</Text>
            <Text style={styles.resultValue}>
              {result.neutralisedLaps}
              <Text style={styles.resultValueMuted}>  held at the field's pace</Text>
            </Text>
          </View>
        </>
      )}

      {/* Per-stint breakdown: where the total actually comes from */}
      <Text style={[styles.sectionTitle, { marginTop: OpenTyreF1Theme.spacing.xl }]}>Stint by stint</Text>
      {result.stintBreakdown.map((stint) => {
        const meta = compoundOf(stint.compound);
        return (
          <View key={stint.stint}>
            <View style={styles.breakdownRow}>
              <View style={[styles.stintSwatch, { backgroundColor: meta.color }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.breakdownTitle}>
                  {meta.label}, {stint.laps} laps
                </Text>
                <Text style={styles.breakdownMeta}>
                  lap {stint.lapStart} to {stint.lapEnd}, average {formatLapTime(stint.averageLap)}
                </Text>
              </View>
              <Text
                style={[
                  styles.breakdownDeg,
                  stint.degradationPerLap > 0.06 && { color: OpenTyreF1Theme.colors.highlight },
                ]}
              >
                {stint.degradationPerLap >= 0 ? '+' : ''}
                {stint.degradationPerLap.toFixed(3)}s/lap
              </Text>
            </View>
            <Hairline />
          </View>
        );
      })}

      <View style={styles.chartBlock}>
        <DegradationChart points={result.degradationCurve} />
      </View>

      <View style={styles.chartBlock}>
        <RaceReplayPlayer
          frames={result.frames}
          title="Simulated race"
          subtitle={`${result.driver.code ?? 'Your driver'} on your plan against the real field`}
        />
      </View>

      {(result.warnings.length > 0 || result.uncertainty.notes.length > 0) && (
        <View style={styles.noticeBlock}>
          {[...result.warnings, ...result.uncertainty.notes].map((note) => (
            <View key={note} style={styles.noticeRow}>
              <Ionicons
                name="information-circle-outline"
                size={14}
                color={OpenTyreF1Theme.colors.textTertiary}
                style={{ marginTop: 1 }}
              />
              <Text style={styles.noticeText}>{note}</Text>
            </View>
          ))}
        </View>
      )}

      <Text style={styles.provenance}>{result.modelDetail}</Text>

      {/* The numbers above say what the plan costs; this says why. */}
      <TouchableOpacity
        style={styles.askButton}
        activeOpacity={0.85}
        onPress={onAskAssistant}
        accessibilityRole="button"
      >
        <Ionicons
          name="chatbubble-ellipses-outline"
          size={17}
          color={OpenTyreF1Theme.colors.accent}
        />
        <View style={{ flex: 1 }}>
          <Text style={styles.askButtonText}>Ask DegradF1AI about this strategy</Text>
          <Text style={styles.askButtonHint}>
            Where the time goes, and what a better plan would look like
          </Text>
        </View>
        <Ionicons
          name="chevron-forward"
          size={16}
          color={OpenTyreF1Theme.colors.textTertiary}
        />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: OpenTyreF1Theme.colors.background },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: OpenTyreF1Theme.spacing.lg,
    paddingTop: OpenTyreF1Theme.spacing.sm,
    paddingBottom: OpenTyreF1Theme.spacing.md,
  },
  backButton: { padding: 4, marginLeft: -4 },
  headerTitle: {
    fontFamily: OpenTyreF1Theme.fonts.displayBold,
    fontSize: OpenTyreF1Theme.type.displayMd.fontSize,
    color: OpenTyreF1Theme.colors.textPrimary,
  },

  askButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: OpenTyreF1Theme.spacing.xl,
    padding: OpenTyreF1Theme.spacing.md,
    borderRadius: OpenTyreF1Theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: OpenTyreF1Theme.colors.hairlineStrong,
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised,
  },
  askButtonText: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  askButtonHint: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 2,
  },
  scrollContent: { paddingHorizontal: OpenTyreF1Theme.spacing.lg, paddingBottom: 80 },

  pageSubtitle: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 4,
    marginBottom: OpenTyreF1Theme.spacing.lg,
  },

  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: OpenTyreF1Theme.spacing.md,
  },
  pickerLabel: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 10,
    letterSpacing: 1,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginBottom: 3,
  },
  pickerValue: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 16,
    color: OpenTyreF1Theme.colors.textPrimary,
  },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 15,
    color: OpenTyreF1Theme.colors.textPrimary,
    marginTop: OpenTyreF1Theme.spacing.xl,
    marginBottom: OpenTyreF1Theme.spacing.md,
  },
  lapCount: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  lapCountOff: { color: OpenTyreF1Theme.colors.highlight },

  driverRow: { gap: 8, paddingBottom: 4 },
  driverChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 6,
    paddingRight: 14,
    paddingVertical: 6,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    borderWidth: 1,
    borderColor: OpenTyreF1Theme.colors.hairlineStrong,
  },
  driverChipActive: {
    borderColor: OpenTyreF1Theme.colors.accent,
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised,
  },
  driverCode: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  driverCodeActive: { color: OpenTyreF1Theme.colors.textPrimary },
  driverFinish: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 9,
    color: OpenTyreF1Theme.colors.textTertiary,
  },

  timelineTrack: {
    flexDirection: 'row',
    height: 56,
    borderRadius: OpenTyreF1Theme.borderRadius.lg,
    overflow: 'hidden',
  },
  timelineSegmentInner: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  timelineCompoundText: { fontFamily: OpenTyreF1Theme.fonts.displayBold, fontSize: 20 },
  timelineFooter: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  timelineEndLabel: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 10,
    letterSpacing: 1,
    color: OpenTyreF1Theme.colors.textTertiary,
  },

  stintControls: { marginTop: OpenTyreF1Theme.spacing.md },
  stintControlRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  stintSwatch: { width: 12, height: 12, borderRadius: 3 },
  stintRangeText: {
    flex: 1,
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepperButton: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    borderWidth: 1,
    borderColor: OpenTyreF1Theme.colors.hairlineStrong,
  },
  stintLaps: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
    minWidth: 22,
    textAlign: 'center',
  },

  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 18, marginTop: 6 },
  textButton: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 },
  textButtonLabel: {
    fontFamily: OpenTyreF1Theme.fonts.bodyMedium,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.accent,
  },
  hint: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 2,
  },

  runButton: {
    marginTop: OpenTyreF1Theme.spacing.xl,
    backgroundColor: OpenTyreF1Theme.colors.accent,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    paddingVertical: 15,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  runButtonDisabled: { opacity: 0.5 },
  runButtonText: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 15,
    color: OpenTyreF1Theme.colors.onAccent,
  },

  emptyResults: { alignItems: 'center', gap: 8, paddingVertical: 32 },
  emptyResultsText: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 13,
    lineHeight: 19,
    color: OpenTyreF1Theme.colors.textTertiary,
    textAlign: 'center',
  },

  deltaBlock: { alignItems: 'center', paddingVertical: OpenTyreF1Theme.spacing.lg },
  deltaLabel: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
    textAlign: 'center',
  },
  deltaValue: { fontFamily: OpenTyreF1Theme.fonts.mono, fontSize: 44, marginTop: 6 },
  deltaMargin: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 4,
  },

  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    gap: 12,
  },
  resultLabel: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  resultValue: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
    textAlign: 'right',
  },
  resultValueMuted: { color: OpenTyreF1Theme.colors.textTertiary, fontSize: 12 },

  breakdownRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  breakdownTitle: {
    fontFamily: OpenTyreF1Theme.fonts.bodyMedium,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  breakdownMeta: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 2,
  },
  breakdownDeg: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textSecondary,
  },

  chartBlock: { marginTop: OpenTyreF1Theme.spacing.xl },

  noticeBlock: { marginTop: OpenTyreF1Theme.spacing.xl, gap: 8 },
  noticeRow: { flexDirection: 'row', gap: 8 },
  noticeText: {
    flex: 1,
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 12,
    lineHeight: 17,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  provenance: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 10,
    lineHeight: 15,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: OpenTyreF1Theme.spacing.lg,
  },
});
