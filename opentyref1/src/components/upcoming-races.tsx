import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { OpenTyreF1Theme } from '../constants/theme';
import { Hairline } from './hairline';
import { flagEmoji, iso2Of } from '../constants/countries';
import { useFlagSupport } from '../context/flag-support';
import { UpcomingRace } from '../services/api';

function CountryBadge({ country }: { country: string | null }) {
  const flagsSupported = useFlagSupport();
  const emoji = flagEmoji(country);
  const iso2 = iso2Of(country);

  if (flagsSupported && emoji) {
    return <Text style={styles.flagEmoji}>{emoji}</Text>;
  }
  return (
    <View style={styles.isoChip}>
      <Text style={styles.isoChipText}>{iso2 ?? '—'}</Text>
    </View>
  );
}

function countdownLabel(race: UpcomingRace): string {
  if (race.daysUntil === 0) return 'Today';
  if (race.isThisWeekend) return 'This weekend';
  if (race.daysUntil === 1) return 'Tomorrow';
  return `in ${race.daysUntil} days`;
}

export function UpcomingRaces({ races }: { races: UpcomingRace[] }) {
  if (races.length === 0) return null;
  const [next, ...rest] = races;

  return (
    <View>
      <Text style={styles.sectionTitle}>Upcoming</Text>
      <Hairline style={{ marginBottom: OpenTyreF1Theme.spacing.sm }} />

      <View style={styles.heroRow}>
        <CountryBadge country={next.country} />
        <View style={{ flex: 1 }}>
          <Text style={styles.heroName} numberOfLines={1}>
            {next.raceName}
          </Text>
          <Text style={styles.heroMeta} numberOfLines={1}>
            {next.circuitName ?? next.locality ?? ''}
          </Text>
        </View>
        <Text style={styles.heroCountdown}>{countdownLabel(next)}</Text>
      </View>

      {rest.map((race, i) => (
        <View key={race.raceId}>
          <Hairline />
          <View style={styles.row}>
            <CountryBadge country={race.country} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowName} numberOfLines={1}>
                {race.raceName}
              </Text>
            </View>
            <Text style={styles.rowCountdown}>{countdownLabel(race)}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 15,
    color: OpenTyreF1Theme.colors.textPrimary,
    marginTop: OpenTyreF1Theme.spacing.xxl,
    marginBottom: OpenTyreF1Theme.spacing.sm,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: OpenTyreF1Theme.spacing.md,
    borderRadius: OpenTyreF1Theme.borderRadius.lg,
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised,
    borderLeftWidth: 3,
    borderLeftColor: OpenTyreF1Theme.colors.accent,
  },
  heroName: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 15,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  heroMeta: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 2,
  },
  heroCountdown: {
    fontFamily: OpenTyreF1Theme.fonts.monoBold,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.accent,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  rowName: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  rowCountdown: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  flagEmoji: { fontSize: 22, width: 28, textAlign: 'center' },
  isoChip: {
    width: 28,
    height: 20,
    borderRadius: OpenTyreF1Theme.borderRadius.md,
    backgroundColor: OpenTyreF1Theme.colors.hairlineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  isoChipText: {
    fontFamily: OpenTyreF1Theme.fonts.monoBold,
    fontSize: 9,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
});
