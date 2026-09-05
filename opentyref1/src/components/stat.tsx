import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { OpenTyreF1Theme } from '../constants/theme';

type Tone = 'accent' | 'highlight';

// Large mono figure over a small label, on open canvas — the replacement for
// bordered stat-tile grids (a card per number is unearned elevation here).
// `tone="accent"` (red) marks a live/active state; `tone="highlight"` (gold)
// marks an achievement — so red isn't the only emphasis color on a screen.
export function Stat({ label, value, tone }: { label: string; value: string | number; tone?: Tone }) {
  return (
    <View style={styles.wrap}>
      <Text style={[styles.value, tone === 'accent' && styles.valueAccent, tone === 'highlight' && styles.valueHighlight]}>
        {value}
      </Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { minWidth: 76 },
  value: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: OpenTyreF1Theme.type.monoLg.fontSize,
    lineHeight: OpenTyreF1Theme.type.monoLg.lineHeight,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  valueAccent: { color: OpenTyreF1Theme.colors.accent },
  valueHighlight: { color: OpenTyreF1Theme.colors.highlight },
  label: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: OpenTyreF1Theme.type.caption.fontSize,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 2,
  },
});
