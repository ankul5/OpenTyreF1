import React from 'react';
import { View, ViewStyle } from 'react-native';
import { OpenTyreF1Theme } from '../constants/theme';

// The one separator used everywhere instead of bordered/shadowed cards —
// keeps the "hairline, not a box" rule consistent across all four tabs.
export function Hairline({ style, strong }: { style?: ViewStyle; strong?: boolean }) {
  return (
    <View
      style={[
        {
          height: 1,
          backgroundColor: strong ? OpenTyreF1Theme.colors.hairlineStrong : OpenTyreF1Theme.colors.hairline,
        },
        style,
      ]}
    />
  );
}
