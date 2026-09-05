import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, LayoutChangeEvent } from 'react-native';
import Svg, { Line, Polyline, Circle, Rect } from 'react-native-svg';
import { OpenTyreF1Theme } from '../../constants/theme';
import { ChartTitle, EmptyChart, Legend, compoundOf, formatLapTime, scale } from './chart-kit';
import type { DegradationPoint } from '../../services/api';

const HEIGHT = 210;
const PAD = { top: 10, right: 12, bottom: 20, left: 46 };

/** Predicted lap time across the simulated race.
 *
 *  Two deliberate discontinuities, both for the same reason: a line is only
 *  drawn where consecutive laps are actually comparable.
 *
 *  - **Stints are separate lines.** A pit stop is a discontinuity, not a data
 *    point, and joining across it would draw a cliff that reads as a
 *    20-second lap.
 *  - **Neutralised laps break the line and are excluded from the scale.** A
 *    safety car makes a lap 25 seconds slower and a red flag makes one 1,700
 *    seconds long. Letting those into the y-domain compresses every real
 *    degradation curve into a flat line at the bottom of the chart, which is
 *    exactly the signal this chart exists to show. They are drawn as a shaded
 *    band across the plot instead, so the reader still sees when the race was
 *    interrupted.
 */
export function DegradationChart({ points }: { points: DegradationPoint[] }) {
  const [width, setWidth] = useState(0);

  const { runs, minTime, maxTime, maxLap, compounds, neutralised } = useMemo(() => {
    // Split into contiguous racing-lap runs, breaking on a stint change or a
    // neutralised lap. Each run becomes one polyline.
    const runs: DegradationPoint[][] = [];
    let current: DegradationPoint[] = [];
    points.forEach((p) => {
      const breaks = current.length > 0 && (p.stint !== current[current.length - 1].stint);
      if (p.neutralised || breaks) {
        if (current.length) runs.push(current);
        current = [];
      }
      if (!p.neutralised) current.push(p);
    });
    if (current.length) runs.push(current);

    const racing = points.filter((p) => !p.neutralised);
    const times = racing.map((p) => p.predictedTime);
    const seen = new Set<string>();
    racing.forEach((p) => seen.add(p.compound));

    return {
      runs,
      minTime: times.length ? Math.min(...times) : 0,
      maxTime: times.length ? Math.max(...times) : 1,
      maxLap: points.length ? points[points.length - 1].lap : 1,
      compounds: [...seen],
      neutralised: points.filter((p) => p.neutralised),
    };
  }, [points]);

  if (!points.length) return <EmptyChart message="Run a simulation to see the degradation curve." />;
  if (!runs.length) {
    return <EmptyChart message="Every lap of this plan ran under a safety car or red flag, so there is no green-flag pace to chart." />;
  }

  const plotW = Math.max(width - PAD.left - PAD.right, 1);
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  // A little headroom so the fastest and slowest laps are not glued to the frame.
  const pad = Math.max((maxTime - minTime) * 0.12, 0.2);
  const lo = minTime - pad;
  const hi = maxTime + pad;

  const xOf = (lap: number) => PAD.left + scale(lap, 1, maxLap || 1, 0, plotW);
  const yOf = (time: number) => PAD.top + scale(time, hi, lo, 0, plotH);

  const gridTimes = [lo, (lo + hi) / 2, hi];

  return (
    <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      <ChartTitle
        title="Predicted lap times"
        subtitle="One line per stint. The upward slope within a stint is tyre degradation."
      />
      {/* Placed under the title so the reader knows the gaps are meaningful
          before they wonder why the line stops. */}
      {neutralised.length > 0 && (
        <Text style={styles.footnote}>
          {neutralised.length} {neutralised.length === 1 ? 'lap' : 'laps'} shaded below ran behind a
          safety car or red flag and are left off the pace scale.
        </Text>
      )}

      {width > 0 && (
        <Svg width={width} height={HEIGHT}>
          {gridTimes.map((t) => (
            <Line
              key={t}
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={yOf(t)}
              y2={yOf(t)}
              stroke={OpenTyreF1Theme.colors.gridLine}
              strokeWidth={1}
            />
          ))}

          {/* Interruptions first, so the pace lines sit on top of the band. */}
          {neutralised.map((p) => (
            <Rect
              key={`neut-${p.lap}`}
              x={xOf(p.lap) - Math.max(plotW / Math.max(maxLap, 1) / 2, 1)}
              y={PAD.top}
              width={Math.max(plotW / Math.max(maxLap, 1), 2)}
              height={plotH}
              fill={OpenTyreF1Theme.colors.hairline}
            />
          ))}

          {runs.map((rows, i) => (
            <Polyline
              key={`${rows[0].stint}-${rows[0].lap}-${i}`}
              points={rows.map((p) => `${xOf(p.lap)},${yOf(p.predictedTime)}`).join(' ')}
              fill="none"
              stroke={compoundOf(rows[0].compound).color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {/* Pit stops: the vertical rule marks where the time jump is charged. */}
          {points
            .filter((p) => p.pitStop && !p.neutralised)
            .map((p) => (
              <React.Fragment key={`pit-${p.lap}`}>
                <Line
                  x1={xOf(p.lap)}
                  x2={xOf(p.lap)}
                  y1={PAD.top}
                  y2={PAD.top + plotH}
                  stroke={OpenTyreF1Theme.colors.hairlineStrong}
                  strokeWidth={1}
                  strokeDasharray="3,3"
                />
                <Circle
                  cx={xOf(p.lap)}
                  cy={yOf(p.predictedTime)}
                  r={3}
                  fill={OpenTyreF1Theme.colors.background}
                  stroke={OpenTyreF1Theme.colors.textSecondary}
                  strokeWidth={1.5}
                />
              </React.Fragment>
            ))}
        </Svg>
      )}

      <View style={styles.yAxis} pointerEvents="none">
        {gridTimes.map((t) => (
          <Text key={t} style={[styles.axisLabel, { top: yOf(t) - 6 }]}>
            {formatLapTime(t)}
          </Text>
        ))}
      </View>

      <View style={styles.xAxis}>
        <Text style={styles.axisLabel}>Lap 1</Text>
        <Text style={styles.axisLabel}>Lap {maxLap}</Text>
      </View>

      <Legend
        items={compounds.map((c) => {
          const meta = compoundOf(c);
          return { label: meta.label, color: meta.color, glyph: meta.letter };
        })}
      />
      <Text style={styles.footnote}>Dashed rule marks a pit stop.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  yAxis: { position: 'absolute', left: 0, top: 42, height: HEIGHT },
  axisLabel: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 10,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  xAxis: { flexDirection: 'row', justifyContent: 'space-between', marginLeft: PAD.left },
  footnote: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 10,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 8,
  },
});
