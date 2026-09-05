import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  fetchLatestSession,
  fetchTrackMap,
  fetchRaceRecap,
  fetchUpcomingRaces,
  fetchSessionTrack,
} from '../../services/api';
import { OpenTyreF1Theme } from '../../constants/theme';
import { Hairline } from '../../components/hairline';
import { MenuButton } from '../../components/menu-button';
import { TimingTowerSkeleton } from '../../components/skeleton';
import { compoundOf, inkOn } from '../../components/charts/chart-kit';
import { DriverAvatar } from '../../components/driver-avatar';
import { RaceSummaryCard } from '../../components/race-summary-card';
import { UpcomingRaces } from '../../components/upcoming-races';
import { SegmentedControl, Segment } from '../../components/segmented-control';
import { TrackPanel } from '../../components/track-panel';

type PanelKey = 'drivers' | 'track';

const PANELS: Segment<PanelKey>[] = [
  { key: 'drivers', label: 'Drivers', icon: 'people-outline' },
  { key: 'track', label: 'Track', icon: 'map-outline' },
];

export default function LiveScreen() {
  const router = useRouter();
  const [panel, setPanel] = useState<PanelKey>('drivers');

  const sessionQuery = useQuery({
    queryKey: ['session', 'latest'],
    queryFn: fetchLatestSession,
    refetchInterval: 60000,
  });

  const session = sessionQuery.data;

  // Track map is a heavier on-demand call (it traces real telemetry), so it is
  // deferred until the user actually opens the Track panel.
  const mapQuery = useQuery({
    queryKey: ['trackMap', session?.sessionKey],
    queryFn: () => fetchTrackMap(session!.sessionKey),
    enabled: !!session?.sessionKey && panel === 'track',
    retry: 0,
  });

  const trackQuery = useQuery({
    queryKey: ['sessionTrack', session?.sessionKey],
    queryFn: () => fetchSessionTrack(session!.sessionKey),
    enabled: !!session?.sessionKey && panel === 'track',
    staleTime: 60 * 60 * 1000,
  });

  const weather = session?.weather;

  // Summary card reuses the recap already built for the race-detail screen,
  // so the two never compute "podium"/"fastest lap" differently.
  const recapQuery = useQuery({
    queryKey: ['recap', session?.raceId],
    queryFn: () => fetchRaceRecap(session!.raceId!),
    enabled: !!session?.raceId,
  });

  const upcomingQuery = useQuery({
    queryKey: ['races', 'upcoming'],
    queryFn: () => fetchUpcomingRaces(5),
    staleTime: 60 * 60 * 1000,
  });

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.statusRow}>
          <MenuButton />
          <View style={styles.liveIndicator}>
            <View style={[styles.liveDot, session?.mode !== 'live' && styles.liveDotReplay]} />
            <Text style={styles.liveText}>
              {session?.mode === 'live' ? 'LIVE' : 'LATEST RESULT'}
            </Text>
          </View>
          <View style={{ flex: 1 }} />
          {sessionQuery.isError && (
            <Text style={styles.errorText}>Backend offline</Text>
          )}
        </View>

        {sessionQuery.isLoading ? (
          <TimingTowerSkeleton rows={8} />
        ) : sessionQuery.isError ? (
          <View style={styles.stateBox}>
            <Ionicons name="cloud-offline-outline" size={24} color={OpenTyreF1Theme.colors.error} />
            <Text style={styles.stateText}>Can't reach the backend.</Text>
            <Text style={styles.stateHint}>Start the FastAPI server, then pull to retry.</Text>
            <TouchableOpacity onPress={() => sessionQuery.refetch()} style={styles.retryButton}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : !session ? (
          <View style={styles.stateBox}>
            <Text style={styles.stateText}>No sessions ingested yet.</Text>
            <Text style={styles.stateHint}>
              Run: python -m app.ingestion.fetch_openf1 --all
            </Text>
          </View>
        ) : (
          <>
            <Text style={styles.raceTitle}>
              {session.location}
              {'\n'}
              {session.sessionName}
            </Text>

            <View style={styles.metaRow}>
              <Text style={styles.metaText}>{session.year}</Text>
              <Text style={styles.metaDivider}>·</Text>
              <Text style={styles.metaText}>{session.totalLaps} laps</Text>
              {weather?.trackTemperature != null && (
                <>
                  <Text style={styles.metaDivider}>·</Text>
                  <Text style={styles.metaText}>Track {weather.trackTemperature.toFixed(0)}°C</Text>
                </>
              )}
              {weather?.rainfall ? (
                <>
                  <Text style={styles.metaDivider}>·</Text>
                  <Text style={styles.metaText}>Wet</Text>
                </>
              ) : null}
            </View>

            {/* Free OpenF1 tier is historical-only; say so rather than implying live. */}
            {session.mode !== 'live' && (
              <View style={styles.noticeBox}>
                <Ionicons name="information-circle-outline" size={15} color={OpenTyreF1Theme.colors.textTertiary} />
                <Text style={styles.noticeText}>
                  Showing the most recent completed session. Live timing needs an OpenF1 sponsor key.
                </Text>
              </View>
            )}

            {session.raceId && (
              <TouchableOpacity
                style={styles.replayCta}
                activeOpacity={0.85}
                onPress={() =>
                  router.push({ pathname: '/race/[raceId]', params: { raceId: session.raceId! } })
                }
              >
                <Ionicons name="play-circle" size={18} color={OpenTyreF1Theme.colors.onAccent} />
                <Text style={styles.replayCtaText}>Watch replay & analysis</Text>
              </TouchableOpacity>
            )}

            {recapQuery.data?.summary && (
              <RaceSummaryCard summary={recapQuery.data.summary} />
            )}

            {/* Drivers / Track switch — the circuit used to sit far below the
                timing tower, where nobody scrolled to find it. */}
            <SegmentedControl
              segments={PANELS}
              value={panel}
              onChange={setPanel}
              style={styles.panelSwitch}
            />

            {panel === 'track' ? (
              <TrackPanel
                track={trackQuery.data}
                map={mapQuery.data}
                mapLoading={mapQuery.isLoading}
              />
            ) : (
              <>
              {/* Timing tower */}
              <View style={styles.towerHeader}>
                <View style={styles.teamBarSpacer} />
                <View style={styles.avatarSpacer} />
                <Text style={[styles.towerHeaderCell, styles.colPos]}>POS</Text>
                <Text style={[styles.towerHeaderCell, styles.colDriver]}>DRIVER</Text>
                <Text style={[styles.towerHeaderCell, styles.colGap]}>GAP</Text>
                <Text style={[styles.towerHeaderCell, styles.colTyre]}>TYRE</Text>
              </View>

              {session.leaderboard.map((row, i) => {
                const c = compoundOf(row.tyreCompound);
                const retired = row.dnf || row.dns || row.dsq;
                return (
                  <View key={`${row.driverId ?? row.driverNumber}-${i}`}>
                    <View style={styles.towerRow}>
                      <View style={[styles.teamBar, { backgroundColor: row.teamColour }]} />
                      <DriverAvatar url={row.headshotUrl} code={row.code} teamColour={row.teamColour} size={26} />
                      <Text style={[styles.posCell, styles.colPos]}>
                        {row.position ?? '—'}
                      </Text>
                      <View style={styles.colDriver}>
                        <Text style={[styles.driverCode, retired && styles.retiredText]}>
                          {row.code ?? '—'}
                        </Text>
                        <Text style={styles.driverTeam} numberOfLines={1}>
                          {row.team ?? ''}
                        </Text>
                      </View>
                      <Text style={[styles.gapCell, styles.colGap]}>
                        {row.dns ? 'DNS' : row.dsq ? 'DSQ' : row.dnf ? 'DNF' : row.gap ?? '—'}
                      </Text>
                      <View style={[styles.colTyre, styles.tyreCell]}>
                        <View style={[styles.tyreBadge, { backgroundColor: c.color }]}>
                          <Text style={[styles.tyreLetter, { color: inkOn(c.color) }]}>
                            {c.letter}
                          </Text>
                        </View>
                      </View>
                    </View>
                    {i < session.leaderboard.length - 1 && <Hairline />}
                  </View>
                );
              })}
              </>
            )}

            <UpcomingRaces races={upcomingQuery.data?.items ?? []} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: OpenTyreF1Theme.colors.background },
  scrollContent: { padding: OpenTyreF1Theme.spacing.lg, paddingBottom: 64 },

  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: OpenTyreF1Theme.spacing.md,
  },
  liveIndicator: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: OpenTyreF1Theme.colors.accent },
  liveDotReplay: { backgroundColor: OpenTyreF1Theme.colors.textTertiary },
  liveText: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 11,
    letterSpacing: 1,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  errorText: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.error,
  },

  raceTitle: {
    fontFamily: OpenTyreF1Theme.fonts.displayBold,
    fontSize: OpenTyreF1Theme.type.displayXl.fontSize,
    lineHeight: OpenTyreF1Theme.type.displayXl.lineHeight,
    letterSpacing: OpenTyreF1Theme.type.displayXl.letterSpacing,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: OpenTyreF1Theme.spacing.sm,
    flexWrap: 'wrap',
  },
  metaText: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  metaDivider: { color: OpenTyreF1Theme.colors.textTertiary },

  noticeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: OpenTyreF1Theme.spacing.md,
    padding: OpenTyreF1Theme.spacing.sm,
    borderRadius: OpenTyreF1Theme.borderRadius.md,
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised,
  },
  noticeText: {
    flex: 1,
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textTertiary,
  },

  replayCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: OpenTyreF1Theme.spacing.md,
    paddingVertical: 13,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    backgroundColor: OpenTyreF1Theme.colors.accent,
  },
  replayCtaText: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.onAccent,
  },

  panelSwitch: { marginTop: OpenTyreF1Theme.spacing.lg },

  towerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: OpenTyreF1Theme.spacing.lg,
    paddingBottom: OpenTyreF1Theme.spacing.sm,
    gap: 12,
  },
  towerHeaderCell: {
    fontFamily: OpenTyreF1Theme.fonts.bodyMedium,
    fontSize: 11,
    letterSpacing: 0.5,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  towerRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 },
  teamBar: { width: 3, height: 32, borderRadius: 2 },
  teamBarSpacer: { width: 3 },
  avatarSpacer: { width: 26 },
  colPos: { width: 24 },
  colDriver: { flex: 1 },
  colGap: { width: 78, textAlign: 'right' },
  colTyre: { width: 30 },
  tyreCell: { alignItems: 'center' },
  posCell: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 15,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  driverCode: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 16,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  retiredText: { color: OpenTyreF1Theme.colors.textTertiary },
  driverTeam: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 1,
  },
  gapCell: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  tyreBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tyreLetter: { fontFamily: OpenTyreF1Theme.fonts.monoBold, fontSize: 10 },

  stateBox: { alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 40 },
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
  retryButton: {
    marginTop: 8,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    backgroundColor: OpenTyreF1Theme.colors.accent,
  },
  retryText: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.onAccent,
  },
});
