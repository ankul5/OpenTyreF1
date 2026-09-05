import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { OpenTyreF1Theme } from '../../constants/theme';
import { ChartTitle, Legend, EmptyChart, compoundOf, inkOn, LegendItem } from './chart-kit';

export interface Stint {
  stint: number | null;
  compound: string | null;
  lapStart: number;
  lapEnd: number;
  laps: number;
  tyreAgeAtStart: number | null;
}

export interface DriverStints {
  driverId: string;
  code: string | null;
  name: string | null;
  teamColour: string;
  stints: Stint[];
}

const ROW_HEIGHT = 26;
const LABEL_WIDTH = 46;
const SEGMENT_GAP = 2; // surface gap between adjacent fills, per mark spec

/** One horizontal bar per driver, split into tyre stints across race distance.
 *  Tap a stint for its exact lap range and tyre age. */
export function TyreStrategyChart({
  data,
  totalLaps,
}: {
  data: DriverStints[];
  totalLaps: number;
}) {
  const [selected, setSelected] = useState<{ driver: string; stint: Stint } | null>(null);

  const legend: LegendItem[] = useMemo(() => {
    const seen = new Map<string, LegendItem>();
    data.forEach((d) =>
      d.stints.forEach((s) => {
        const c = compoundOf(s.compound);
        if (!seen.has(c.label)) seen.set(c.label, { label: c.label, color: c.color, glyph: c.letter });
      }),
    );
    return [...seen.values()];
  }, [data]);

  if (!data.length || !totalLaps) {
    return <EmptyChart message="No tyre stint data for this race." />;
  }

  return (
    <View>
      <ChartTitle title="Tyre strategy" subtitle={`Stints across ${totalLaps} laps, finishing order`} />

      {data.map((driver) => (
        <View key={driver.driverId} style={styles.row}>
          <View style={styles.labelCell}>
            <View style={[styles.teamBar, { backgroundColor: driver.teamColour }]} />
            <Text style={styles.driverCode} numberOfLines={1}>
              {driver.code ?? driver.driverId.slice(0, 3).toUpperCase()}
            </Text>
          </View>

          <View style={styles.track}>
            {driver.stints.map((s, i) => {
              const c = compoundOf(s.compound);
              const isSel =
                selected?.driver === driver.driverId && selected?.stint.lapStart === s.lapStart;
              return (
                <Pressable
                  key={`${s.lapStart}-${i}`}
                  onPress={() =>
                    setSelected(isSel ? null : { driver: driver.driverId, stint: s })
                  }
                  style={{
                    flex: s.laps,
                    marginRight: i < driver.stints.length - 1 ? SEGMENT_GAP : 0,
                  }}
                >
                  <View
                    style={[
                      styles.segment,
                      { backgroundColor: c.color },
                      isSel && styles.segmentSelected,
                    ]}
                  >
                    {/* Letter is the non-colour channel; hidden only when the
                        segment is too narrow to fit it legibly. */}
                    {s.laps / totalLaps > 0.07 && (
                      <Text style={[styles.segmentLetter, { color: inkOn(c.color) }]}>
                        {c.letter}
                      </Text>
                    )}
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}

      <View style={styles.axis}>
        <Text style={styles.axisLabel}>Lap 1</Text>
        <Text style={styles.axisLabel}>Lap {totalLaps}</Text>
      </View>

      {selected && (
        <View style={styles.tooltip}>
          <Text style={styles.tooltipText}>
            {compoundOf(selected.stint.compound).label} · laps {selected.stint.lapStart}–
            {selected.stint.lapEnd} ({selected.stint.laps})
            {selected.stint.tyreAgeAtStart != null
              ? ` · started ${selected.stint.tyreAgeAtStart} laps old`
              : ''}
          </Text>
        </View>
      )}

      <Legend items={legend} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', height: ROW_HEIGHT },
  labelCell: { width: LABEL_WIDTH, flexDirection: 'row', alignItems: 'center', gap: 6 },
  teamBar: { width: 3, height: 14, borderRadius: 2 },
  driverCode: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  track: { flex: 1, flexDirection: 'row', height: 14 },
  segment: {
    flex: 1,
    height: 14,
    borderRadius: 4, // rounded data-ends per mark spec
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentSelected: {
    borderWidth: 2,
    borderColor: OpenTyreF1Theme.colors.textPrimary,
  },
  segmentLetter: { fontFamily: OpenTyreF1Theme.fonts.monoBold, fontSize: 9 },
  axis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginLeft: LABEL_WIDTH,
    marginTop: 6,
  },
  axisLabel: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 10,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  tooltip: {
    marginTop: OpenTyreF1Theme.spacing.md,
    padding: OpenTyreF1Theme.spacing.sm,
    borderRadius: OpenTyreF1Theme.borderRadius.md,
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised,
  },
  tooltipText: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
});
