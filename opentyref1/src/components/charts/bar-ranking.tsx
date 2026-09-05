import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { OpenTyreF1Theme } from '../../constants/theme';
import { ChartTitle, EmptyChart } from './chart-kit';

export interface BarRow {
  key: string;
  label: string;
  /** Bar length driver. */
  value: number;
  /** What the reader actually sees printed at the end of the bar. */
  display: string;
  color: string;
  /** Optional smaller note under the label (lap number, stop count...). */
  note?: string;
}

/** Horizontal ranked bars for a single measure (pace delta, pit duration).
 *  One measure, one axis, sorted — the reader compares lengths, not colours,
 *  so colour here only carries team identity. */
export function BarRanking({
  title,
  subtitle,
  rows,
  emptyMessage = 'No data available.',
  maxRows,
}: {
  title: string;
  subtitle?: string;
  rows: BarRow[];
  emptyMessage?: string;
  maxRows?: number;
}) {
  if (!rows.length) {
    return (
      <View>
        <ChartTitle title={title} subtitle={subtitle} />
        <EmptyChart message={emptyMessage} />
      </View>
    );
  }

  const shown = maxRows ? rows.slice(0, maxRows) : rows;
  const max = Math.max(...shown.map((r) => Math.abs(r.value)), 0.0001);

  return (
    <View>
      <ChartTitle title={title} subtitle={subtitle} />
      {shown.map((row) => (
        <View key={row.key} style={styles.row}>
          <View style={styles.labelCell}>
            <View style={[styles.teamBar, { backgroundColor: row.color }]} />
            <View>
              <Text style={styles.label}>{row.label}</Text>
              {!!row.note && <Text style={styles.note}>{row.note}</Text>}
            </View>
          </View>
          <View style={styles.barTrack}>
            <View
              style={[
                styles.bar,
                {
                  width: `${Math.max((Math.abs(row.value) / max) * 100, 1.5)}%`,
                  backgroundColor: row.color,
                },
              ]}
            />
          </View>
          <Text style={styles.value}>{row.display}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', height: 30, gap: 8 },
  labelCell: { width: 62, flexDirection: 'row', alignItems: 'center', gap: 6 },
  teamBar: { width: 3, height: 16, borderRadius: 2 },
  label: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  note: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 9,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  barTrack: { flex: 1, height: 10, justifyContent: 'center' },
  bar: { height: 10, borderRadius: 4 },
  value: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textSecondary,
    width: 62,
    textAlign: 'right',
  },
});
