import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { OpenTyreF1Theme } from '../../constants/theme';
import { ChartTitle, EmptyChart } from '../charts/chart-kit';

/** Vertical bar-per-position histogram for the Monte Carlo position
 *  prediction — every finishing position the simulation reached, with the
 *  actual result marked so the model's honesty is visible at a glance. */
export function OutcomeDistribution({
  histogram,
  maxPosition,
  actualPosition,
}: {
  histogram: { position: number; probability: number }[];
  maxPosition: number;
  actualPosition: number | null;
}) {
  if (!histogram.length) {
    return (
      <View>
        <ChartTitle title="Finishing position distribution" />
        <EmptyChart message="Not enough simulated runs finished to build a distribution." />
      </View>
    );
  }

  const byPosition = new Map(histogram.map((h) => [h.position, h.probability]));
  const positions = Array.from({ length: maxPosition }, (_, i) => i + 1);
  const maxProb = Math.max(...histogram.map((h) => h.probability), 0.01);

  return (
    <View>
      <ChartTitle title="Finishing position distribution" subtitle="Probability of each finishing position, from the simulated runs" />
      <View style={styles.bars}>
        {positions.map((p) => {
          const prob = byPosition.get(p) ?? 0;
          const isActual = p === actualPosition;
          return (
            <View key={p} style={styles.barCol}>
              <View style={styles.barTrack}>
                <View
                  style={[
                    styles.bar,
                    { height: `${Math.max((prob / maxProb) * 100, prob > 0 ? 3 : 0)}%` },
                    isActual ? styles.barActual : styles.barDefault,
                  ]}
                />
              </View>
              <Text style={[styles.posLabel, isActual && styles.posLabelActual]}>{p}</Text>
            </View>
          );
        })}
      </View>
      {actualPosition != null && (
        <Text style={styles.caption}>Highlighted bar (P{actualPosition}) is what actually happened.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bars: { flexDirection: 'row', height: 90, alignItems: 'flex-end', gap: 2 },
  barCol: { flex: 1, height: '100%', alignItems: 'center', justifyContent: 'flex-end' },
  barTrack: { flex: 1, width: '100%', justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: 2, minHeight: 0 },
  barDefault: { backgroundColor: OpenTyreF1Theme.colors.highlight, opacity: 0.55 },
  barActual: { backgroundColor: OpenTyreF1Theme.colors.accent, opacity: 1 },
  posLabel: {
    fontFamily: OpenTyreF1Theme.fonts.mono, fontSize: 8,
    color: OpenTyreF1Theme.colors.textTertiary, marginTop: 4,
  },
  posLabelActual: { color: OpenTyreF1Theme.colors.accent, fontFamily: OpenTyreF1Theme.fonts.monoBold },
  caption: {
    fontFamily: OpenTyreF1Theme.fonts.body, fontSize: 11,
    color: OpenTyreF1Theme.colors.textTertiary, marginTop: 10,
  },
});
