import React, { useEffect } from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  useReducedMotion,
  Easing,
} from 'react-native-reanimated';
import { OpenTyreF1Theme } from '../constants/theme';

function Bone({ style }: { style?: ViewStyle }) {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(0.5);

  useEffect(() => {
    if (reducedMotion) return;
    opacity.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, [reducedMotion]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: reducedMotion ? 0.5 : opacity.value,
  }));

  return <Animated.View style={[styles.bone, style, animatedStyle]} />;
}

// Row-shaped loader matching the timing-tower row it stands in for, rather
// than a generic centered spinner.
export function TimingRowSkeleton() {
  return (
    <View style={styles.row}>
      <Bone style={{ width: 20, height: 14 }} />
      <Bone style={{ flex: 1, height: 14, marginLeft: 16 }} />
      <Bone style={{ width: 48, height: 14, marginLeft: 16 }} />
      <Bone style={{ width: 24, height: 20, marginLeft: 16, borderRadius: OpenTyreF1Theme.borderRadius.full }} />
    </View>
  );
}

export function TimingTowerSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <View>
      {Array.from({ length: rows }).map((_, i) => (
        <TimingRowSkeleton key={i} />
      ))}
    </View>
  );
}

// Row-shaped loader for the driver directory list.
export function DriverRowSkeleton() {
  return (
    <View style={styles.driverRow}>
      <Bone style={{ width: 40, height: 40, borderRadius: OpenTyreF1Theme.borderRadius.lg }} />
      <View style={{ flex: 1, marginLeft: 12, gap: 6 }}>
        <Bone style={{ width: '55%', height: 14 }} />
        <Bone style={{ width: '35%', height: 11 }} />
      </View>
    </View>
  );
}

export function DriverListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <View>
      {Array.from({ length: rows }).map((_, i) => (
        <DriverRowSkeleton key={i} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bone: {
    backgroundColor: OpenTyreF1Theme.colors.hairlineStrong,
    borderRadius: OpenTyreF1Theme.borderRadius.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
  },
  driverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
  },
});
