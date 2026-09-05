import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { fetchRaces } from '../services/api';
import { OpenTyreF1Theme } from '../constants/theme';
import { Hairline } from '../components/hairline';
import { DriverListSkeleton } from '../components/skeleton';

export default function RacesScreen() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [season, setSeason] = useState<number | undefined>(undefined);

  const racesQuery = useQuery({
    queryKey: ['races', season, search],
    queryFn: () => fetchRaces({ season, search: search.trim() || undefined }),
    placeholderData: keepPreviousData,
  });

  const races = racesQuery.data?.items ?? [];

  // Seasons present in the results, so the filter never offers an empty year.
  const seasons = useMemo(() => {
    const set = new Set<number>();
    races.forEach((r) => set.add(r.season));
    return [...set].sort((a, b) => b - a);
  }, [races]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.backButton}>
          <Ionicons name="chevron-back" size={22} color={OpenTyreF1Theme.colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Races</Text>
      </View>

      <View style={styles.searchWrap}>
        <Ionicons name="search-outline" size={17} color={OpenTyreF1Theme.colors.textTertiary} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search races or circuits"
          placeholderTextColor={OpenTyreF1Theme.colors.textTertiary}
          style={styles.searchInput}
          autoCorrect={false}
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')} hitSlop={10}>
            <Ionicons name="close-circle" size={17} color={OpenTyreF1Theme.colors.textTertiary} />
          </TouchableOpacity>
        )}
      </View>
      <Hairline />

      {seasons.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          <TouchableOpacity
            onPress={() => setSeason(undefined)}
            style={[styles.chip, season === undefined && styles.chipActive]}
          >
            <Text style={[styles.chipText, season === undefined && styles.chipTextActive]}>All</Text>
          </TouchableOpacity>
          {seasons.map((y) => (
            <TouchableOpacity
              key={y}
              onPress={() => setSeason(y)}
              style={[styles.chip, season === y && styles.chipActive]}
            >
              <Text style={[styles.chipText, season === y && styles.chipTextActive]}>{y}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {racesQuery.isLoading ? (
          <DriverListSkeleton rows={10} />
        ) : races.length === 0 ? (
          <View style={styles.stateBox}>
            <Text style={styles.stateText}>No races found.</Text>
            <Text style={styles.stateHint}>
              Replayable races come from OpenF1, which covers 2023 onward.
            </Text>
          </View>
        ) : (
          races.map((race, i) => (
            <View key={race.raceId}>
              <TouchableOpacity
                style={styles.raceRow}
                activeOpacity={0.6}
                onPress={() =>
                  router.push({ pathname: '/race/[raceId]', params: { raceId: race.raceId } })
                }
              >
                <Text style={styles.round}>R{race.round}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.raceName} numberOfLines={1}>
                    {race.raceName}
                  </Text>
                  <Text style={styles.raceMeta} numberOfLines={1}>
                    {race.season} · {race.circuitName ?? ''}
                  </Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={16}
                  color={OpenTyreF1Theme.colors.textTertiary}
                />
              </TouchableOpacity>
              {i < races.length - 1 && <Hairline />}
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
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
  title: {
    fontFamily: OpenTyreF1Theme.fonts.displayBold,
    fontSize: OpenTyreF1Theme.type.displayLg.fontSize,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: OpenTyreF1Theme.spacing.lg,
    paddingBottom: OpenTyreF1Theme.spacing.md,
  },
  searchInput: {
    flex: 1,
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 15,
    color: OpenTyreF1Theme.colors.textPrimary,
    padding: 0,
  },
  chipRow: {
    gap: 8,
    paddingHorizontal: OpenTyreF1Theme.spacing.lg,
    paddingVertical: OpenTyreF1Theme.spacing.md,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    borderWidth: 1,
    borderColor: OpenTyreF1Theme.colors.hairlineStrong,
    height: 34,
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
  list: { paddingHorizontal: OpenTyreF1Theme.spacing.lg, paddingBottom: 48 },
  raceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  round: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
    width: 28,
  },
  raceName: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 15,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  raceMeta: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 12,
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
