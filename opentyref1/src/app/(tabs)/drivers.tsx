import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { fetchDrivers, DriverListItem } from '../../services/api';
import { OpenTyreF1Theme } from '../../constants/theme';
import { Hairline } from '../../components/hairline';
import { DriverListSkeleton } from '../../components/skeleton';
import { MenuButton } from '../../components/menu-button';
import { DriverAvatar } from '../../components/driver-avatar';
import { StateBox } from '../../components/state-box';

const TEAM_FILTERS = ['ALL', 'RED BULL', 'FERRARI', 'MERCEDES', 'MCLAREN'];

const TEAM_ACCENT: Record<string, string> = {
  'red bull': OpenTyreF1Theme.colors.teamRedBull,
  ferrari: OpenTyreF1Theme.colors.teamFerrari,
  mercedes: OpenTyreF1Theme.colors.teamMercedes,
  mclaren: OpenTyreF1Theme.colors.teamMcLaren,
};

function teamAccent(team: string | null) {
  if (!team) return OpenTyreF1Theme.colors.hairlineStrong;
  const key = Object.keys(TEAM_ACCENT).find((k) => team.toLowerCase().includes(k));
  return key ? TEAM_ACCENT[key] : OpenTyreF1Theme.colors.hairlineStrong;
}

export default function DriversScreen() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState('ALL');

  // A team chip and the free-text box are the same backend query, so collapse them into one term.
  const effectiveSearch = useMemo(() => {
    if (search.trim()) return search.trim();
    return activeFilter === 'ALL' ? '' : activeFilter;
  }, [search, activeFilter]);

  const listQuery = useQuery({
    queryKey: ['drivers', effectiveSearch],
    queryFn: () => fetchDrivers(effectiveSearch || undefined),
    placeholderData: keepPreviousData,
  });

  const drivers = listQuery.data?.items ?? [];

  // Full career stats live on their own screen rather than in a panel below
  // this list: with 20+ drivers the panel sat off-screen, so tapping a row
  // appeared to do nothing.
  const openDriver = (driverId: string) =>
    router.push({ pathname: '/driver/[driverId]', params: { driverId } });

  const renderDriverRow = (d: DriverListItem) => (
    <TouchableOpacity
      key={d.driverId}
      activeOpacity={0.6}
      onPress={() => openDriver(d.driverId)}
      accessibilityRole="button"
      accessibilityLabel={`${d.givenName} ${d.familyName}, view stats`}
      style={styles.driverRow}
    >
      <View style={[styles.teamBar, { backgroundColor: teamAccent(d.team) }]} />
      <DriverAvatar
        url={d.headshotUrl}
        code={d.code}
        teamColour={teamAccent(d.team)}
        size={34}
      />
      <View style={styles.driverRowText}>
        <Text style={styles.driverName} numberOfLines={1}>
          {d.givenName} {d.familyName}
        </Text>
        <Text style={styles.driverTeamName} numberOfLines={1}>
          {d.team ?? 'Unknown team'}
        </Text>
      </View>
      {d.wins > 0 && <Text style={styles.driverWins}>{d.wins}W</Text>}
      <Text style={styles.driverNumber}>
        {d.permanentNumber ? String(d.permanentNumber).padStart(2, '0') : '—'}
      </Text>
      <Ionicons
        name="chevron-forward"
        size={16}
        color={OpenTyreF1Theme.colors.textTertiary}
      />
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <MenuButton />
        </View>
        <Text style={styles.pageTitle}>Drivers</Text>

        {/* Search */}
        <View style={styles.searchWrap}>
          <Ionicons name="search-outline" size={17} color={OpenTyreF1Theme.colors.textTertiary} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search drivers or teams"
            placeholderTextColor={OpenTyreF1Theme.colors.textTertiary}
            style={styles.searchInput}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')} hitSlop={10}>
              <Ionicons name="close-circle" size={17} color={OpenTyreF1Theme.colors.textTertiary} />
            </TouchableOpacity>
          )}
        </View>
        <Hairline />

        {/* Team filter chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          {TEAM_FILTERS.map((t) => {
            const active = activeFilter === t && !search.trim();
            return (
              <TouchableOpacity
                key={t}
                onPress={() => {
                  setActiveFilter(t);
                  setSearch('');
                }}
                style={[styles.chip, active && styles.chipActive]}
                activeOpacity={0.7}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{t}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Driver list */}
        {listQuery.isLoading ? (
          <DriverListSkeleton />
        ) : listQuery.isError ? (
          <StateBox
            icon="cloud-offline-outline"
            iconColor={OpenTyreF1Theme.colors.error}
            text="Can't reach the backend."
            hint="Make sure the FastAPI server is running."
            onRetry={() => listQuery.refetch()}
          />
        ) : drivers.length === 0 ? (
          <StateBox
            icon="search-outline"
            text={`No drivers match "${effectiveSearch}"`}
            hint="Try a different name or team."
          />
        ) : (
          <View>
            {drivers.map((d, i) => (
              <View key={d.driverId}>
                {renderDriverRow(d)}
                {i < drivers.length - 1 && <Hairline />}
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: OpenTyreF1Theme.colors.background },
  scrollContent: { padding: OpenTyreF1Theme.spacing.lg, paddingBottom: 64 },

  headerRow: { flexDirection: 'row', marginBottom: OpenTyreF1Theme.spacing.sm },

  pageTitle: {
    fontFamily: OpenTyreF1Theme.fonts.displayBold,
    fontSize: OpenTyreF1Theme.type.displayLg.fontSize,
    lineHeight: OpenTyreF1Theme.type.displayLg.lineHeight,
    letterSpacing: OpenTyreF1Theme.type.displayLg.letterSpacing,
    color: OpenTyreF1Theme.colors.textPrimary,
    marginBottom: OpenTyreF1Theme.spacing.lg,
  },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingBottom: OpenTyreF1Theme.spacing.md,
  },
  searchInput: {
    flex: 1,
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 15,
    color: OpenTyreF1Theme.colors.textPrimary,
    padding: 0,
  },

  chipRow: { gap: 8, paddingVertical: OpenTyreF1Theme.spacing.md },
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
    fontFamily: OpenTyreF1Theme.fonts.bodyMedium,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  chipTextActive: { color: OpenTyreF1Theme.colors.onAccent },

  driverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
  },
  teamBar: { width: 3, height: 34, borderRadius: 2 },
  driverRowText: { flex: 1 },
  driverName: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 16,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  driverTeamName: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 2,
  },
  driverWins: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  driverNumber: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 16,
    color: OpenTyreF1Theme.colors.textSecondary,
    minWidth: 24,
    textAlign: 'right',
  },
});
