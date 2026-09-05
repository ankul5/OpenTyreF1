import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, LayoutChangeEvent } from 'react-native';
import Svg, { Line, Polyline } from 'react-native-svg';
import { OpenTyreF1Theme } from '../../constants/theme';
import { ChartTitle, Legend, EmptyChart, scale, LegendItem } from './chart-kit';

export interface TelemetrySample {
  speed: number | null;
  throttle: number | null;
  brake: number | null;
  gear: number | null;
  drs: number | null;
  progress?: number;
}

export interface TraceDriver {
  driverId: string;
  code?: string | null;
  colour: string;
  /** Set when this driver shares a team colour with another driver in the
   *  same comparison — colour alone can't carry identity then, so the line
   *  renders dashed. Same composite-encoding trick position-chart.tsx uses.
   */
  dashed?: boolean;
  lap: number;
  lapTime: number | null;
  samples: TelemetrySample[];
}

type Channel = 'speed' | 'throttle' | 'brake';

const CHANNELS: Record<Channel, { label: string; unit: string; max: number }> = {
  speed: { label: 'Speed', unit: 'km/h', max: 360 },
  throttle: { label: 'Throttle', unit: '%', max: 100 },
  brake: { label: 'Brake', unit: '%', max: 100 },
};

const HEIGHT = 150;
const PAD = { top: 6, right: 6, bottom: 16, left: 32 };

/** Overlaid telemetry traces for one or two drivers over a single lap.
 *
 *  X is lap progress (0-100%), not wall-clock — that is what makes two laps of
 *  different duration actually comparable. One channel per chart, one y-axis:
 *  speed and throttle never share a scale.
 */
export function TelemetryTrace({
  drivers,
  channel,
}: {
  drivers: TraceDriver[];
  channel: Channel;
}) {
  const [width, setWidth] = useState(0);
  const meta = CHANNELS[channel];

  const domainMax = useMemo(() => {
    let m = 0;
    drivers.forEach((d) =>
      d.samples.forEach((s) => {
        const v = s[channel];
        if (typeof v === 'number' && v > m) m = v;
      }),
    );
    return Math.max(m, 1);
  }, [drivers, channel]);

  const hasData = drivers.some((d) => d.samples.length);
  if (!hasData) return <EmptyChart message="No telemetry for this lap." />;

  const plotW = Math.max(width - PAD.left - PAD.right, 1);
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const ticks = [0, 0.5, 1].map((f) => Math.round(domainMax * f));

  return (
    <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && (
        <Svg width={width} height={HEIGHT}>
          {ticks.map((t) => {
            const y = PAD.top + plotH - scale(t, 0, domainMax, 0, plotH);
            return (
              <Line
                key={t}
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={y}
                y2={y}
                stroke={OpenTyreF1Theme.colors.gridLine}
                strokeWidth={1}
              />
            );
          })}

          {drivers.map((d) => {
            const n = Math.max(d.samples.length - 1, 1);
            const pts = d.samples
              .map((s, i) => {
                const v = typeof s[channel] === 'number' ? (s[channel] as number) : 0;
                const x = PAD.left + scale(s.progress ?? (i / n) * 100, 0, 100, 0, plotW);
                const y = PAD.top + plotH - scale(v, 0, domainMax, 0, plotH);
                return `${x},${y}`;
              })
              .join(' ');
            return (
              <Polyline
                key={d.driverId}
                points={pts}
                fill="none"
                stroke={d.colour}
                strokeWidth={2}
                strokeDasharray={d.dashed ? '5,3' : undefined}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            );
          })}
        </Svg>
      )}

      <View style={styles.yAxis} pointerEvents="none">
        {ticks
          .slice()
          .reverse()
          .map((t, i) => (
            <Text key={t} style={[styles.axisLabel, { top: i * (plotH / 2) - 5 }]}>
              {t}
            </Text>
          ))}
      </View>

      <View style={styles.captionRow}>
        <Text style={styles.caption}>
          {meta.label} ({meta.unit})
        </Text>
        <Text style={styles.caption}>lap progress →</Text>
      </View>
    </View>
  );
}

/** Speed + throttle + brake stacked, sharing one x-axis and one legend. */
export function TelemetryPanel({ drivers }: { drivers: TraceDriver[] }) {
  const legend: LegendItem[] = drivers.map((d) => ({
    label: `${d.code ?? d.driverId} · lap ${d.lap}`,
    color: d.colour,
    dashed: d.dashed,
  }));

  return (
    <View>
      <ChartTitle title="Telemetry" subtitle="Aligned by lap progress, so different lap times still compare" />
      {(['speed', 'throttle', 'brake'] as Channel[]).map((ch) => (
        <View key={ch} style={styles.channelBlock}>
          <TelemetryTrace drivers={drivers} channel={ch} />
        </View>
      ))}
      <Legend items={legend} />
    </View>
  );
}

const styles = StyleSheet.create({
  yAxis: { position: 'absolute', left: 0, top: PAD.top, height: HEIGHT },
  axisLabel: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 9,
    color: OpenTyreF1Theme.colors.textTertiary,
    position: 'absolute',
  },
  captionRow: { flexDirection: 'row', justifyContent: 'space-between', marginLeft: PAD.left },
  caption: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 10,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  channelBlock: { marginBottom: OpenTyreF1Theme.spacing.md },
});
