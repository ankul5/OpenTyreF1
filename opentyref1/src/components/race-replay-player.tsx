import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, withTiming, useReducedMotion } from 'react-native-reanimated';
import { OpenTyreF1Theme } from '../constants/theme';
import { compoundOf, inkOn, formatLapTime } from './charts/chart-kit';

export interface ReplayEntry {
  position: number;
  driverId: string;
  code: string | null;
  name?: string | null;
  team?: string | null;
  teamColour: string;
  gap: number | null;
  tyreCompound: string | null;
  tyreLife?: number | null;
  lapTime?: number | null;
  isPitOutLap?: boolean | null;
}

export interface ReplayFrame {
  lap: number;
  leaderboard: ReplayEntry[];
}

const SPEEDS = [1, 2, 4, 8];
const ROW_HEIGHT = 44;

/** Lap-by-lap race player.
 *
 *  Takes ONLY a `frames` array, so it renders a real race and a simulated
 *  strategy identically — Phase 3 feeds it predicted frames without changes.
 */
export function RaceReplayPlayer({
  frames,
  title,
  subtitle,
  maxRows = 10,
}: {
  frames: ReplayFrame[];
  title?: string;
  subtitle?: string;
  maxRows?: number;
}) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [trackWidth, setTrackWidth] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const total = frames.length;
  const frame = frames[Math.min(index, total - 1)];

  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (!playing || total === 0) return;
    timer.current = setInterval(() => {
      setIndex((i) => {
        if (i >= total - 1) {
          setPlaying(false);
          return total - 1;
        }
        return i + 1;
      });
    }, 900 / speed);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, speed, total]);

  const seek = useCallback(
    (x: number) => {
      if (trackWidth <= 0 || total === 0) return;
      const ratio = Math.min(Math.max(x / trackWidth, 0), 1);
      setIndex(Math.round(ratio * (total - 1)));
    },
    [trackWidth, total],
  );

  const rows = useMemo(
    () => (frame ? frame.leaderboard.slice(0, maxRows) : []),
    [frame, maxRows],
  );

  if (!total || !frame) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No replay frames available.</Text>
      </View>
    );
  }

  const progress = total > 1 ? index / (total - 1) : 1;

  return (
    <View>
      {!!title && (
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{title}</Text>
            {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
          </View>
          <Text style={styles.lapCounter}>
            LAP {frame.lap}/{frames[total - 1].lap}
          </Text>
        </View>
      )}

      <View style={styles.board}>
        {rows.map((entry, i) => (
          <ReplayRow key={entry.driverId} entry={entry} slot={i} />
        ))}
      </View>

      {/* Scrubber */}
      <View
        style={styles.scrubTrack}
        onLayout={(e: LayoutChangeEvent) => setTrackWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(e) => seek(e.nativeEvent.locationX)}
        onResponderMove={(e) => seek(e.nativeEvent.locationX)}
      >
        <View style={styles.scrubFill_bg} />
        <View style={[styles.scrubFill, { width: `${progress * 100}%` }]} />
        <View style={[styles.scrubThumb, { left: `${progress * 100}%` }]} />
      </View>

      <View style={styles.controls}>
        <Pressable
          onPress={() => setIndex(0)}
          hitSlop={10}
          style={styles.iconButton}
          accessibilityLabel="Restart"
        >
          <Ionicons name="play-skip-back" size={16} color={OpenTyreF1Theme.colors.textSecondary} />
        </Pressable>

        <Pressable
          onPress={() => {
            if (index >= total - 1) setIndex(0);
            setPlaying((p) => !p);
          }}
          style={styles.playButton}
          accessibilityLabel={playing ? 'Pause' : 'Play'}
        >
          <Ionicons
            name={playing ? 'pause' : 'play'}
            size={18}
            color={OpenTyreF1Theme.colors.onAccent}
          />
        </Pressable>

        <Pressable
          onPress={() => setIndex(total - 1)}
          hitSlop={10}
          style={styles.iconButton}
          accessibilityLabel="Jump to finish"
        >
          <Ionicons name="play-skip-forward" size={16} color={OpenTyreF1Theme.colors.textSecondary} />
        </Pressable>

        <View style={{ flex: 1 }} />

        {SPEEDS.map((s) => (
          <Pressable
            key={s}
            onPress={() => setSpeed(s)}
            style={[styles.speedChip, speed === s && styles.speedChipActive]}
          >
            <Text style={[styles.speedText, speed === s && styles.speedTextActive]}>{s}x</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** One leaderboard row that slides to its new slot as positions change. */
function ReplayRow({ entry, slot }: { entry: ReplayEntry; slot: number }) {
  const reducedMotion = useReducedMotion();
  const compound = compoundOf(entry.tyreCompound);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: reducedMotion
          ? slot * ROW_HEIGHT
          : withTiming(slot * ROW_HEIGHT, { duration: 420 }),
      },
    ],
  }));

  return (
    <Animated.View style={[styles.row, animatedStyle]}>
      <View style={[styles.teamBar, { backgroundColor: entry.teamColour }]} />
      <Text style={styles.position}>{entry.position}</Text>
      <View style={styles.driverCell}>
        <Text style={styles.code}>{entry.code ?? entry.driverId.slice(0, 3).toUpperCase()}</Text>
        {!!entry.team && (
          <Text style={styles.team} numberOfLines={1}>
            {entry.team}
          </Text>
        )}
      </View>
      <Text style={styles.gap}>
        {entry.position === 1 ? 'Leader' : entry.gap != null ? `+${entry.gap.toFixed(3)}` : '—'}
      </Text>
      <View style={[styles.tyre, { backgroundColor: compound.color }]}>
        <Text style={[styles.tyreLetter, { color: inkOn(compound.color) }]}>{compound.letter}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: OpenTyreF1Theme.spacing.md },
  title: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 15,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  subtitle: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 2,
  },
  lapCounter: {
    fontFamily: OpenTyreF1Theme.fonts.monoBold,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.accent,
  },

  board: { height: ROW_HEIGHT * 10, marginBottom: OpenTyreF1Theme.spacing.md },
  row: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  teamBar: { width: 3, height: 24, borderRadius: 2 },
  position: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
    width: 20,
  },
  driverCell: { flex: 1 },
  code: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  team: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 10,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  gap: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textSecondary,
    width: 72,
    textAlign: 'right',
  },
  tyre: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  tyreLetter: { fontFamily: OpenTyreF1Theme.fonts.monoBold, fontSize: 10 },

  scrubTrack: { height: 28, justifyContent: 'center' },
  scrubFill_bg: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: OpenTyreF1Theme.colors.hairlineStrong,
  },
  scrubFill: {
    position: 'absolute',
    left: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: OpenTyreF1Theme.colors.accent,
  },
  scrubThumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    marginLeft: -7,
    backgroundColor: OpenTyreF1Theme.colors.textPrimary,
  },

  controls: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  iconButton: { padding: 6 },
  playButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: OpenTyreF1Theme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedChip: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    borderWidth: 1,
    borderColor: OpenTyreF1Theme.colors.hairline,
  },
  speedChipActive: {
    borderColor: OpenTyreF1Theme.colors.accent,
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised,
  },
  speedText: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 10,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  speedTextActive: { color: OpenTyreF1Theme.colors.accent },

  empty: { paddingVertical: 32, alignItems: 'center' },
  emptyText: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
});
