import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { OpenTyreF1Theme } from '../constants/theme';
import { Hairline } from './hairline';
import { DriverAvatar } from './driver-avatar';
import { compoundOf, formatLapTime } from './charts/chart-kit';
import { RaceSummary } from '../services/api';

/** The at-a-glance card openf1ow leads with: podium, fastest lap, biggest
 *  gainer, winning strategy, conditions — read in two seconds without
 *  scrolling the full classification table. Reused as the header of the
 *  race-detail screen so it isn't rebuilt twice.
 */
export function RaceSummaryCard({ summary }: { summary: RaceSummary }) {
  return (
    <View style={styles.card}>
      <View style={styles.podiumRow}>
        {summary.podium.map((p) => (
          <View key={p.driverId} style={styles.podiumItem}>
            <Text style={styles.podiumPosition}>P{p.position}</Text>
            <DriverAvatar url={p.headshotUrl} code={p.code} teamColour={p.teamColour} size={40} />
            <Text style={styles.podiumCode}>{p.code ?? '—'}</Text>
          </View>
        ))}
      </View>

      <Hairline style={{ marginVertical: OpenTyreF1Theme.spacing.md }} />

      <View style={styles.factsGrid}>
        {summary.fastestLap && (
          <Fact
            label="Fastest lap"
            value={`${formatLapTime(summary.fastestLap.bestLap)} · ${summary.fastestLap.code ?? '—'}`}
          />
        )}
        {summary.biggestGainer && (
          <Fact
            label="Biggest gainer"
            value={`${summary.biggestGainer.code ?? '—'} +${summary.biggestGainer.positionsGained}`}
          />
        )}
        {summary.winningStrategy && (
          <Fact
            label="Winning strategy"
            value={`${summary.winningStrategy.sequence
              .map((c) => compoundOf(c).letter)
              .join(' → ')} · ${summary.winningStrategy.stops} stop${summary.winningStrategy.stops === 1 ? '' : 's'}`}
          />
        )}
        {summary.conditions && (
          <Fact
            label="Conditions"
            value={`${summary.conditions.airTemperature?.toFixed(0) ?? '—'}°C air${
              summary.conditions.wet ? ' · Wet' : ''
            }`}
          />
        )}
      </View>
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.factItem}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: OpenTyreF1Theme.spacing.md,
    borderRadius: OpenTyreF1Theme.borderRadius.lg,
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised,
  },
  podiumRow: { flexDirection: 'row', justifyContent: 'space-around' },
  podiumItem: { alignItems: 'center', gap: 6 },
  podiumPosition: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  podiumCode: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  factsGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12 },
  factItem: { width: '50%' },
  factLabel: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  factValue: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
    marginTop: 2,
  },
});
