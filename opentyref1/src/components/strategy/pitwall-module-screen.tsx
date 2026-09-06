import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { OpenTyreF1Theme } from '../../constants/theme';
import { StateBox } from '../state-box';
import { usePitwallSelection } from '../../context/pitwall-context';
import { LapScrubber } from './lap-scrubber';
import { RecommendationCard } from './recommendation-card';
import type { PitwallResponse } from '../../services/api';

/** The scaffolding every pitwall module screen shares: a back header, the
 *  race/driver/lap scrubber, and a query against that module's endpoint
 *  rendered through <RecommendationCard>. Each screen supplies only its
 *  title, its fetch function, and how to render its module-specific
 *  `actual` outcome and any extra content (a chart, for the Monte Carlo
 *  modules). */
export function PitwallModuleScreen<T extends PitwallResponse>({
  title,
  moduleKey,
  fetchFn,
  renderActual,
  renderBelow,
  longRunning,
}: {
  title: string;
  moduleKey: string;
  fetchFn: (raceId: string, driverId: string, lap: number) => Promise<T>;
  renderActual?: (data: T) => React.ReactNode;
  renderBelow?: (data: T) => React.ReactNode;
  longRunning?: boolean;
}) {
  const router = useRouter();
  const { raceId, driverId, lap } = usePitwallSelection();

  const query = useQuery({
    queryKey: [moduleKey, raceId, driverId, lap],
    queryFn: () => fetchFn(raceId!, driverId!, lap),
    enabled: !!raceId && !!driverId && lap > 0,
    staleTime: 1000 * 60 * 10,
  });

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.backButton}>
          <Ionicons name="chevron-back" size={22} color={OpenTyreF1Theme.colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{title}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <LapScrubber />

        <View style={styles.resultBlock}>
          {!raceId || !driverId ? (
            <StateBox icon="flag-outline" text="Choose a race and driver above" />
          ) : query.isError ? (
            <StateBox
              icon="cloud-offline-outline"
              text="Could not load this recommendation"
              hint={(query.error as any)?.response?.data?.detail ?? 'The backend rejected the request or is unreachable.'}
              onRetry={() => query.refetch()}
            />
          ) : query.isLoading || !query.data ? (
            <StateBox
              icon="hourglass-outline"
              text={longRunning ? 'Running the simulation' : 'Crunching the numbers'}
              hint={longRunning ? 'The first run after a backend restart can take a few seconds.' : undefined}
            />
          ) : (
            <>
              <RecommendationCard data={query.data}>
                {renderActual?.(query.data)}
              </RecommendationCard>
              {renderBelow?.(query.data)}
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export const actualStyles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 12, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: OpenTyreF1Theme.colors.hairline,
  },
  label: {
    fontFamily: OpenTyreF1Theme.fonts.mono, fontSize: 10, letterSpacing: 0.3,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  value: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold, fontSize: 13,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: OpenTyreF1Theme.colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
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
  scrollContent: { paddingHorizontal: OpenTyreF1Theme.spacing.lg, paddingBottom: 80 },
  resultBlock: { marginTop: OpenTyreF1Theme.spacing.lg },
});
