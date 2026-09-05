import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { OpenTyreF1Theme } from '../constants/theme';

/** The loading/error/empty state block, previously copy-pasted with drift
 *  into live.tsx, drivers.tsx, races.tsx, and race/[raceId].tsx.
 */
export function StateBox({
  icon,
  iconColor,
  text,
  hint,
  onRetry,
  center = true,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  text: string;
  hint?: string;
  onRetry?: () => void;
  center?: boolean;
}) {
  return (
    <View style={[styles.box, center && styles.centered]}>
      {icon && <Ionicons name={icon} size={24} color={iconColor ?? OpenTyreF1Theme.colors.textTertiary} />}
      <Text style={styles.text}>{text}</Text>
      {!!hint && <Text style={styles.hint}>{hint}</Text>}
      {onRetry && (
        <TouchableOpacity onPress={onRetry} style={styles.retryButton}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', gap: 6, paddingVertical: 40 },
  centered: { justifyContent: 'center' },
  text: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  hint: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 8,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    backgroundColor: OpenTyreF1Theme.colors.accent,
  },
  retryText: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.onAccent,
  },
});
