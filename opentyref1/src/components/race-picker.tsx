import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TextInput, TouchableOpacity, FlatList, Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { fetchRaces, RaceListItem } from '../services/api';
import { OpenTyreF1Theme } from '../constants/theme';
import { Hairline } from './hairline';
import { DriverListSkeleton } from './skeleton';
import { StateBox } from './state-box';

/** Searchable race chooser, shown as a sheet.
 *
 *  Deliberately a modal rather than a route: the strategy screen keeps its
 *  in-progress stint plan while you change which race you are planning for,
 *  which navigating away and back would throw out.
 */
export function RacePicker({
  visible,
  onClose,
  onSelect,
  selectedRaceId,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (race: RaceListItem) => void;
  selectedRaceId?: string | null;
}) {
  const [search, setSearch] = useState('');

  const racesQuery = useQuery({
    queryKey: ['races', 'picker', search],
    queryFn: () => fetchRaces({ search: search.trim() || undefined }),
    placeholderData: keepPreviousData,
    enabled: visible,
  });

  const races = racesQuery.data?.items ?? [];

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent={false}>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Text style={styles.title}>Choose a race</Text>
          <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.closeButton}>
            <Ionicons name="close" size={22} color={OpenTyreF1Theme.colors.textPrimary} />
          </TouchableOpacity>
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

        {racesQuery.isLoading ? (
          <View style={styles.padded}>
            <DriverListSkeleton rows={8} />
          </View>
        ) : racesQuery.isError ? (
          <StateBox
            icon="cloud-offline-outline"
            text="Could not load races"
            hint="Check that the backend is running and reachable."
            onRetry={() => racesQuery.refetch()}
          />
        ) : races.length === 0 ? (
          <StateBox
            icon="search-outline"
            text="No races match that search"
            hint="Lap data comes from OpenF1, which covers 2023 onward."
          />
        ) : (
          <FlatList
            data={races}
            keyExtractor={(r) => r.raceId}
            contentContainerStyle={styles.list}
            ItemSeparatorComponent={Hairline}
            renderItem={({ item }) => {
              const selected = item.raceId === selectedRaceId;
              return (
                <Pressable
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  onPress={() => {
                    onSelect(item);
                    onClose();
                  }}
                >
                  <Text style={styles.round}>R{item.round}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.raceName} numberOfLines={1}>
                      {item.raceName}
                    </Text>
                    <Text style={styles.raceMeta} numberOfLines={1}>
                      {item.season} · {item.circuitName ?? ''}
                    </Text>
                  </View>
                  {selected && (
                    <Ionicons name="checkmark" size={18} color={OpenTyreF1Theme.colors.accent} />
                  )}
                </Pressable>
              );
            }}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: OpenTyreF1Theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: OpenTyreF1Theme.spacing.lg,
    paddingTop: OpenTyreF1Theme.spacing.sm,
    paddingBottom: OpenTyreF1Theme.spacing.md,
  },
  title: {
    fontFamily: OpenTyreF1Theme.fonts.displayBold,
    fontSize: OpenTyreF1Theme.type.displayMd.fontSize,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  closeButton: { padding: 4 },
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
  padded: { paddingHorizontal: OpenTyreF1Theme.spacing.lg },
  list: { paddingHorizontal: OpenTyreF1Theme.spacing.lg, paddingBottom: 32 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  rowPressed: { opacity: 0.6 },
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
});
