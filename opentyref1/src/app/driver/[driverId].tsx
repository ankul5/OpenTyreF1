import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { fetchDriverDetail, fetchDriverSeason } from '../../services/api';
import { OpenTyreF1Theme } from '../../constants/theme';
import { Hairline } from '../../components/hairline';
import { Stat } from '../../components/stat';
import { StateBox } from '../../components/state-box';
import { DriverAvatar } from '../../components/driver-avatar';
import { DriverListSkeleton } from '../../components/skeleton';
import { flagEmoji } from '../../constants/countries';

const TEAM_ACCENT: Record<string, string> = {
  'red bull': OpenTyreF1Theme.colors.teamRedBull,
  ferrari: OpenTyreF1Theme.colors.teamFerrari,
  mercedes: OpenTyreF1Theme.colors.teamMercedes,
  mclaren: OpenTyreF1Theme.colors.teamMcLaren,
};

function teamAccent(team: string | null | undefined) {
  if (!team) return OpenTyreF1Theme.colors.hairlineStrong;
  const key = Object.keys(TEAM_ACCENT).find((k) => team.toLowerCase().includes(k));
  return key ? TEAM_ACCENT[key] : OpenTyreF1Theme.colors.hairlineStrong;
}

/** Whole years between a date of birth and today. */
function ageFrom(dob: string | null): number | null {
  if (!dob) return null;
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const beforeBirthday =
    now.getMonth() < born.getMonth() ||
    (now.getMonth() === born.getMonth() && now.getDate() < born.getDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export default function DriverDetailScreen() {
  const { driverId } = useLocalSearchParams<{ driverId: string }>();
  const router = useRouter();
  const [season, setSeason] = useState<number | null>(null);

  const detailQuery = useQuery({
    queryKey: ['driver', driverId],
    queryFn: () => fetchDriverDetail(driverId!),
    enabled: !!driverId,
  });

  const detail = detailQuery.data;

  // `seasons` arrives newest-first. Default to the latest, but only once the
  // detail has loaded — and reset when navigating to a different driver.
  useEffect(() => {
    setSeason(detail?.seasons?.[0] ?? null);
  }, [detail?.driverId]);

  const seasonQuery = useQuery({
    queryKey: ['driverSeason', driverId, season],
    queryFn: () => fetchDriverSeason(driverId!, season!),
    enabled: !!driverId && season != null,
  });

  const races = seasonQuery.data?.races ?? [];
  const standing = seasonQuery.data?.standing;
  const currentTeam = detail?.teamHistory[detail.teamHistory.length - 1]?.name ?? null;
  const age = ageFrom(detail?.dateOfBirth ?? null);
  const flag = flagEmoji(detail?.nationality);

  // Podiums and points for the selected season, from that season's races.
  const seasonPodiums = races.filter((r) => r.position != null && r.position <= 3).length;
  const seasonWins = races.filter((r) => r.position === 1).length;
  const seasonDnfs = races.filter((r) => r.position == null).length;
  const bestFinish = races.reduce<number | null>(
    (best, r) => (r.position != null && (best == null || r.position < best) ? r.position : best),
    null,
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.backButton}>
            <Ionicons name="chevron-back" size={22} color={OpenTyreF1Theme.colors.textPrimary} />
            <Text style={styles.backText}>Drivers</Text>
          </TouchableOpacity>
        </View>

        {detailQuery.isLoading ? (
          <DriverListSkeleton />
        ) : detailQuery.isError || !detail ? (
          <StateBox
            icon="cloud-offline-outline"
            iconColor={OpenTyreF1Theme.colors.error}
            text="Can't load this driver."
            hint="Make sure the FastAPI server is running."
            onRetry={() => detailQuery.refetch()}
          />
        ) : (
          <>
            {/* Identity */}
            <View style={styles.profileHeader}>
              <DriverAvatar
                url={detail.headshotUrl}
                code={detail.code}
                teamColour={teamAccent(currentTeam)}
                size={84}
              />
              <View style={{ flex: 1 }}>
                <View style={styles.teamRow}>
                  <View style={[styles.teamDot, { backgroundColor: teamAccent(currentTeam) }]} />
                  <Text style={styles.profileTeam} numberOfLines={1}>
                    {currentTeam ?? '—'}
                  </Text>
                </View>
                <Text style={styles.profileName}>
                  {detail.givenName}
                  {'\n'}
                  {detail.familyName}
                </Text>
              </View>
            </View>

            <Text style={styles.profileMeta}>
              {[
                detail.permanentNumber ? `#${detail.permanentNumber}` : detail.code,
                flag && detail.nationality ? `${flag} ${detail.nationality}` : detail.nationality,
                age != null ? `${age} yrs` : null,
              ]
                .filter(Boolean)
                .join('  ·  ')}
            </Text>

            {/* Career */}
            <Text style={styles.sectionTitle}>Career</Text>
            <Hairline style={{ marginBottom: OpenTyreF1Theme.spacing.lg }} />
            <View style={styles.statWall}>
              <Stat label="Wins" value={detail.career.wins} tone="highlight" />
              <Stat label="Podiums" value={detail.career.podiums} />
              <Stat label="Poles" value={detail.career.poles} />
            </View>
            <View style={[styles.statWall, { marginTop: OpenTyreF1Theme.spacing.lg }]}>
              <Stat label="Starts" value={detail.career.starts} />
              <Stat label="Points" value={detail.career.points} />
              <Stat
                label="Titles"
                value={detail.career.championships}
                tone={detail.career.championships > 0 ? 'highlight' : undefined}
              />
            </View>

            {/* Season picker */}
            {detail.seasons.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>Season by season</Text>
                <Hairline style={{ marginBottom: OpenTyreF1Theme.spacing.sm }} />
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.chipRow}
                >
                  {detail.seasons.map((y) => {
                    const active = y === season;
                    return (
                      <TouchableOpacity
                        key={y}
                        onPress={() => setSeason(y)}
                        style={[styles.chip, active && styles.chipActive]}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.chipText, active && styles.chipTextActive]}>{y}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </>
            )}

            {/* Selected-season summary */}
            {season != null && (
              <>
                {standing && (
                  <View style={styles.statWall}>
                    <Stat label="Championship" value={standing.position ?? '—'} />
                    <Stat label="Points" value={standing.points ?? 0} />
                    <Stat label="Wins" value={standing.wins ?? seasonWins} />
                  </View>
                )}
                <View style={[styles.statWall, { marginTop: OpenTyreF1Theme.spacing.lg }]}>
                  <Stat label="Races" value={races.length} />
                  <Stat label="Podiums" value={seasonPodiums} />
                  <Stat label="Best finish" value={bestFinish != null ? `P${bestFinish}` : '—'} />
                </View>
                {seasonDnfs > 0 && (
                  <Text style={styles.dnfNote}>
                    {seasonDnfs} race{seasonDnfs === 1 ? '' : 's'} not classified
                  </Text>
                )}

                {/* Race-by-race */}
                <Text style={styles.sectionTitle}>Results · {season}</Text>
                <Hairline />
                {seasonQuery.isLoading ? (
                  <View style={{ height: 80 }} />
                ) : races.length === 0 ? (
                  <Text style={styles.hint}>No races recorded for this season.</Text>
                ) : (
                  races.map((r, i) => {
                    const dnf = r.position == null;
                    const win = r.position === 1;
                    const podium = r.position != null && r.position <= 3;
                    return (
                      <View key={`${r.round}-${r.raceName}`}>
                        <View style={styles.raceRow}>
                          <Text style={styles.raceRound}>{String(r.round).padStart(2, '0')}</Text>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.raceName} numberOfLines={1}>
                              {r.raceName.replace(' Grand Prix', '')}
                            </Text>
                            <Text style={styles.raceMeta} numberOfLines={1}>
                              {r.grid != null ? `Grid P${r.grid}` : 'Grid —'}
                              {r.status && dnf ? ` · ${r.status}` : ''}
                            </Text>
                          </View>
                          {r.points != null && r.points > 0 && (
                            <Text style={styles.racePoints}>{r.points}</Text>
                          )}
                          <Text
                            style={[
                              styles.racePosition,
                              dnf && styles.racePositionDnf,
                              win && styles.racePositionWin,
                              podium && !win && styles.racePositionPodium,
                            ]}
                          >
                            {dnf ? 'DNF' : `P${r.position}`}
                          </Text>
                        </View>
                        {i < races.length - 1 && <Hairline />}
                      </View>
                    );
                  })
                )}
              </>
            )}

            {/* Team history */}
            <Text style={styles.sectionTitle}>Team history</Text>
            <Hairline />
            {detail.teamHistory.map((t, i) => (
              <View key={t.constructorId}>
                <View style={styles.teamHistoryRow}>
                  <View style={[styles.teamDot, { backgroundColor: teamAccent(t.name) }]} />
                  <Text style={styles.teamHistoryName} numberOfLines={1}>
                    {t.name}
                  </Text>
                  <Text style={styles.teamHistoryYears}>
                    {t.fromYear === t.toYear ? t.fromYear : `${t.fromYear}–${t.toYear}`}
                  </Text>
                  <Text style={styles.teamHistoryRaces}>{t.races} R</Text>
                </View>
                {i < detail.teamHistory.length - 1 && <Hairline />}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: OpenTyreF1Theme.colors.background },
  scrollContent: { padding: OpenTyreF1Theme.spacing.lg, paddingBottom: 64 },

  headerRow: { flexDirection: 'row', marginBottom: OpenTyreF1Theme.spacing.md },
  backButton: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: -6 },
  backText: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 15,
    color: OpenTyreF1Theme.colors.textPrimary,
  },

  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: OpenTyreF1Theme.spacing.md,
  },
  teamRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  teamDot: { width: 8, height: 8, borderRadius: 4 },
  profileTeam: {
    flex: 1,
    fontFamily: OpenTyreF1Theme.fonts.bodyMedium,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  profileName: {
    fontFamily: OpenTyreF1Theme.fonts.displayBold,
    fontSize: OpenTyreF1Theme.type.displayXl.fontSize,
    lineHeight: OpenTyreF1Theme.type.displayXl.lineHeight,
    letterSpacing: OpenTyreF1Theme.type.displayXl.letterSpacing,
    color: OpenTyreF1Theme.colors.textPrimary,
    marginTop: 4,
  },
  profileMeta: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: OpenTyreF1Theme.spacing.md,
  },

  sectionTitle: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 15,
    color: OpenTyreF1Theme.colors.textPrimary,
    marginTop: OpenTyreF1Theme.spacing.xxl,
    marginBottom: OpenTyreF1Theme.spacing.sm,
  },

  statWall: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },

  chipRow: { gap: 8, paddingVertical: OpenTyreF1Theme.spacing.sm },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    borderWidth: 1,
    borderColor: OpenTyreF1Theme.colors.hairlineStrong,
  },
  chipActive: {
    backgroundColor: OpenTyreF1Theme.colors.accent,
    borderColor: OpenTyreF1Theme.colors.accent,
  },
  chipText: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  chipTextActive: { color: OpenTyreF1Theme.colors.onAccent },

  dnfNote: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: OpenTyreF1Theme.spacing.md,
  },

  raceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  raceRound: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
    width: 22,
  },
  raceName: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 15,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  raceMeta: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 1,
  },
  racePoints: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  racePosition: {
    fontFamily: OpenTyreF1Theme.fonts.monoBold,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
    width: 42,
    textAlign: 'right',
  },
  racePositionDnf: { color: OpenTyreF1Theme.colors.error },
  racePositionWin: { color: OpenTyreF1Theme.colors.highlight },
  racePositionPodium: { color: OpenTyreF1Theme.colors.textSecondary },

  teamHistoryRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  teamHistoryName: {
    flex: 1,
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  teamHistoryYears: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  teamHistoryRaces: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
    width: 44,
    textAlign: 'right',
  },

  hint: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
    paddingVertical: OpenTyreF1Theme.spacing.md,
  },
});
