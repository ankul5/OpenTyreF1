import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Pressable, Dimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import { useQuery } from '@tanstack/react-query';
import { OpenTyreF1Theme } from '../constants/theme';
import { Hairline } from './hairline';
import { useAppMenu } from '../context/app-menu';
import { fetchHealthStatus } from '../services/api';

const DRAWER_WIDTH = Math.min(300, Dimensions.get('window').width * 0.82);

const NAV_ITEMS = [
  { href: '/live' as const, label: 'Live', icon: 'radio-outline' as const },
  { href: '/races' as const, label: 'Races & replays', icon: 'flag-outline' as const },
  { href: '/drivers' as const, label: 'Drivers', icon: 'people-outline' as const },
  { href: '/strategy' as const, label: 'Strategy', icon: 'bar-chart-outline' as const },
  { href: '/assistant' as const, label: 'Assistant', icon: 'chatbubble-ellipses-outline' as const },
  { href: '/about' as const, label: 'About', icon: 'information-circle-outline' as const },
];

// Rendered once at the root, above the tab navigator — screens just call
// useAppMenu().open() via <MenuButton /> rather than owning their own modal.
export function AppDrawer() {
  const { isOpen, close } = useAppMenu();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const translateX = useSharedValue(-DRAWER_WIDTH);
  const backdropOpacity = useSharedValue(0);

  useEffect(() => {
    translateX.value = withTiming(isOpen ? 0 : -DRAWER_WIDTH, {
      duration: 260,
      easing: Easing.out(Easing.cubic),
    });
    backdropOpacity.value = withTiming(isOpen ? 1 : 0, { duration: 220 });
  }, [isOpen]);

  // Only polled while the drawer is actually open.
  const { data: health, isError } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealthStatus,
    enabled: isOpen,
    refetchInterval: isOpen ? 15000 : false,
  });
  const connected = !!health && !isError;

  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdropOpacity.value }));

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={isOpen ? 'auto' : 'none'}>
      <Animated.View style={[styles.backdrop, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close menu" />
      </Animated.View>

      <Animated.View
        style={[
          styles.panel,
          { width: DRAWER_WIDTH, paddingTop: insets.top + OpenTyreF1Theme.spacing.lg, paddingBottom: insets.bottom + OpenTyreF1Theme.spacing.lg },
          panelStyle,
        ]}
      >
        <Text style={styles.wordmark}>OpenTyreF1</Text>
        <Text style={styles.tagline}>F1 strategy & telemetry</Text>

        <View style={styles.navList}>
          {NAV_ITEMS.map((item) => (
            <TouchableOpacity
              key={item.href}
              style={styles.navRow}
              activeOpacity={0.6}
              onPress={() => {
                close();
                router.push(item.href);
              }}
            >
              <Ionicons name={item.icon} size={19} color={OpenTyreF1Theme.colors.textSecondary} />
              <Text style={styles.navLabel}>{item.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={{ flex: 1 }} />

        <Hairline style={{ marginBottom: OpenTyreF1Theme.spacing.md }} />
        <View style={styles.statusRow}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: connected ? OpenTyreF1Theme.colors.success : OpenTyreF1Theme.colors.error },
            ]}
          />
          <Text style={styles.statusText}>{connected ? 'Backend connected' : 'Backend offline'}</Text>
        </View>
        <Text style={styles.versionText}>OpenTyreF1 · v1.0.0</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  panel: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised,
    paddingHorizontal: OpenTyreF1Theme.spacing.lg,
  },
  wordmark: {
    fontFamily: OpenTyreF1Theme.fonts.displayBold,
    fontSize: OpenTyreF1Theme.type.displayMd.fontSize,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  tagline: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 2,
    marginBottom: OpenTyreF1Theme.spacing.xl,
  },
  navList: { gap: 2 },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 12,
  },
  navLabel: {
    fontFamily: OpenTyreF1Theme.fonts.bodyMedium,
    fontSize: 15,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  versionText: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 10,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 6,
  },
});
