import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { OpenTyreF1Theme } from '../constants/theme';

export type Segment<T extends string> = {
  key: T;
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
};

/**
 * Two-or-more way switch for swapping the content of a panel in place.
 *
 * A recessed track with a raised active pill, rather than the app's usual
 * outlined chips: chips read as filters that narrow one list, while this
 * replaces the panel wholesale, and the difference should be visible before
 * the user taps.
 */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  style,
}: {
  segments: Segment<T>[];
  value: T;
  onChange: (next: T) => void;
  style?: object;
}) {
  return (
    <View style={[styles.track, style]}>
      {segments.map((s) => {
        const active = s.key === value;
        return (
          <TouchableOpacity
            key={s.key}
            onPress={() => onChange(s.key)}
            activeOpacity={0.75}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[styles.segment, active && styles.segmentActive]}
          >
            {s.icon && (
              <Ionicons
                name={s.icon}
                size={15}
                color={
                  active
                    ? OpenTyreF1Theme.colors.textPrimary
                    : OpenTyreF1Theme.colors.textTertiary
                }
              />
            )}
            <Text style={[styles.label, active && styles.labelActive]}>{s.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    backgroundColor: OpenTyreF1Theme.colors.surfaceSunken,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
  },
  segmentActive: {
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised,
    borderWidth: 1,
    borderColor: OpenTyreF1Theme.colors.hairlineStrong,
  },
  label: {
    fontFamily: OpenTyreF1Theme.fonts.bodyMedium,
    fontSize: 13,
    letterSpacing: 0.2,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  labelActive: { color: OpenTyreF1Theme.colors.textPrimary },
});
