import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import { OpenTyreF1Theme } from '../../constants/theme';
import { EmptyChart } from './chart-kit';

export interface TrackPoint {
  x: number;
  y: number;
}

export interface TrackBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface CarMarker {
  driverId: string;
  colour: string;
  /** 0-1 along the traced lap. */
  progress: number;
}

const VIEW = 320;
const PADDING = 14;

/** Circuit outline traced from real OpenF1 x/y telemetry, not a hand-drawn path.
 *  Optional car markers ride the same geometry, so the replay's positions and
 *  the map always agree. */
export function TrackMap({
  points,
  bounds,
  cars = [],
  height = 220,
}: {
  points: TrackPoint[];
  bounds?: TrackBounds;
  cars?: CarMarker[];
  height?: number;
}) {
  const { path, projected } = useMemo(() => {
    if (!points.length) return { path: '', projected: [] as TrackPoint[] };

    const b = bounds ?? {
      minX: Math.min(...points.map((p) => p.x)),
      maxX: Math.max(...points.map((p) => p.x)),
      minY: Math.min(...points.map((p) => p.y)),
      maxY: Math.max(...points.map((p) => p.y)),
    };

    const spanX = Math.max(b.maxX - b.minX, 1);
    const spanY = Math.max(b.maxY - b.minY, 1);
    // Uniform scale keeps the circuit's real proportions instead of stretching it.
    const s = (VIEW - PADDING * 2) / Math.max(spanX, spanY);
    const offX = (VIEW - spanX * s) / 2;
    const offY = (VIEW - spanY * s) / 2;

    const projected = points.map((p) => ({
      x: offX + (p.x - b.minX) * s,
      // SVG y grows downward; F1 coordinates grow upward.
      y: VIEW - (offY + (p.y - b.minY) * s),
    }));

    const path =
      projected.reduce(
        (acc, p, i) => acc + `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)} `,
        '',
      ) + 'Z';

    return { path, projected };
  }, [points, bounds]);

  if (!points.length) return <EmptyChart message="No track position data for this session." />;

  return (
    <View style={[styles.wrap, { height }]}>
      <Svg width="100%" height="100%" viewBox={`0 0 ${VIEW} ${VIEW}`}>
        <Path
          d={path}
          stroke={OpenTyreF1Theme.colors.hairlineStrong}
          strokeWidth={7}
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <Path
          d={path}
          stroke={OpenTyreF1Theme.colors.textTertiary}
          strokeWidth={2}
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {cars.map((car) => {
          const idx = Math.min(
            projected.length - 1,
            Math.max(0, Math.round(car.progress * (projected.length - 1))),
          );
          const p = projected[idx];
          if (!p) return null;
          return (
            <Circle
              key={car.driverId}
              cx={p.x}
              cy={p.y}
              r={5}
              fill={car.colour}
              // Surface ring keeps overlapping cars readable.
              stroke={OpenTyreF1Theme.colors.background}
              strokeWidth={2}
            />
          );
        })}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', alignItems: 'center', justifyContent: 'center' },
});
