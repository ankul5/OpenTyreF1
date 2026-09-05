import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable, LayoutChangeEvent } from 'react-native';
import Svg, { Line, Polyline, Circle } from 'react-native-svg';
import { OpenTyreF1Theme } from '../../constants/theme';
import { ChartTitle, EmptyChart, scale } from './chart-kit';

export interface PositionSeries {
  driverId: string;
  code: string | null;
  teamColour: string;
  points: { lap: number; position: number }[];
}

const HEIGHT = 260;
const PAD = { top: 8, right: 34, bottom: 22, left: 26 };

/** Position-over-laps.
 *
 *  A 20-driver field is far past what any categorical palette can carry, and
 *  teammates share a livery, so identity is composite: team colour + a dashed
 *  line for the second car of each team + a direct end-label per line. Colour
 *  alone never has to do the work.
 */
export function PositionChart({ series }: { series: PositionSeries[] }) {
  const [width, setWidth] = useState(0);
  const [focus, setFocus] = useState<string | null>(null);

  const { maxLap, maxPos, withStyle } = useMemo(() => {
    let maxLap = 0;
    let maxPos = 0;
    series.forEach((s) =>
      s.points.forEach((p) => {
        if (p.lap > maxLap) maxLap = p.lap;
        if (p.position > maxPos) maxPos = p.position;
      }),
    );
    // Second car of a team gets the dashed variant.
    const seenTeam = new Set<string>();
    const withStyle = series.map((s) => {
      const dashed = seenTeam.has(s.teamColour);
      seenTeam.add(s.teamColour);
      return { ...s, dashed };
    });
    return { maxLap, maxPos, withStyle };
  }, [series]);

  if (!series.length) return <EmptyChart message="No position data for this race." />;

  const plotW = Math.max(width - PAD.left - PAD.right, 1);
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const xOf = (lap: number) => PAD.left + scale(lap, 1, maxLap || 1, 0, plotW);
  const yOf = (pos: number) => PAD.top + scale(pos, 1, maxPos || 1, 0, plotH);

  const gridPositions = [1, 5, 10, 15, 20].filter((p) => p <= maxPos);

  return (
    <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      <ChartTitle
        title="Position changes"
        subtitle={focus ? `Highlighting ${focus}` : 'Tap a driver to highlight their line'}
      />

      {width > 0 && (
        <Svg width={width} height={HEIGHT}>
          {gridPositions.map((p) => (
            <Line
              key={p}
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={yOf(p)}
              y2={yOf(p)}
              stroke={OpenTyreF1Theme.colors.gridLine}
              strokeWidth={1}
            />
          ))}

          {withStyle.map((s) => {
            const dim = focus !== null && focus !== s.code;
            const pts = s.points.map((p) => `${xOf(p.lap)},${yOf(p.position)}`).join(' ');
            return (
              <Polyline
                key={s.driverId}
                points={pts}
                fill="none"
                stroke={s.teamColour}
                strokeWidth={focus === s.code ? 3 : 2}
                strokeDasharray={s.dashed ? '5,3' : undefined}
                opacity={dim ? 0.15 : 1}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            );
          })}

          {/* Finishing-position dot for the focused driver */}
          {withStyle
            .filter((s) => focus === s.code && s.points.length)
            .map((s) => {
              const last = s.points[s.points.length - 1];
              return (
                <Circle
                  key={`${s.driverId}-end`}
                  cx={xOf(last.lap)}
                  cy={yOf(last.position)}
                  r={4}
                  fill={s.teamColour}
                  stroke={OpenTyreF1Theme.colors.background}
                  strokeWidth={2}
                />
              );
            })}
        </Svg>
      )}

      {/* Y axis: P1 at top */}
      <View style={styles.yAxis} pointerEvents="none">
        {gridPositions.map((p) => (
          <Text key={p} style={[styles.axisLabel, { top: yOf(p) - 6 }]}>
            P{p}
          </Text>
        ))}
      </View>

      <View style={styles.xAxis}>
        <Text style={styles.axisLabel}>Lap 1</Text>
        <Text style={styles.axisLabel}>Lap {maxLap}</Text>
      </View>

      {/* Direct labels double as the legend and the filter control */}
      <View style={styles.chips}>
        {withStyle.map((s) => {
          const active = focus === s.code;
          return (
            <Pressable
              key={s.driverId}
              onPress={() => setFocus(active ? null : s.code)}
              style={[styles.chip, active && styles.chipActive]}
            >
              <View
                style={[
                  styles.chipLine,
                  { backgroundColor: s.teamColour },
                  s.dashed && styles.chipLineDashed,
                ]}
              />
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{s.code}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.footnote}>Dashed line = second car of the same team</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  yAxis: { position: 'absolute', left: 0, top: 34, height: HEIGHT },
  axisLabel: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 10,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  xAxis: { flexDirection: 'row', justifyContent: 'space-between', marginLeft: PAD.left },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: OpenTyreF1Theme.spacing.md,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    borderWidth: 1,
    borderColor: OpenTyreF1Theme.colors.hairline,
  },
  chipActive: {
    borderColor: OpenTyreF1Theme.colors.textSecondary,
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised,
  },
  chipLine: { width: 10, height: 3, borderRadius: 2 },
  chipLineDashed: { opacity: 0.5 },
  chipText: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 10,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  chipTextActive: { color: OpenTyreF1Theme.colors.textPrimary },
  footnote: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 10,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 8,
  },
});
