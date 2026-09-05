import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { OpenTyreF1Theme } from '../../constants/theme';

/** Tyre compound -> colour + single-letter code.
 *  The letter is the secondary encoding: compound identity must never rely on
 *  colour alone (colour-blind readers, printed posters, greyscale screenshots).
 */
export const COMPOUND: Record<string, { color: string; letter: string; label: string }> = {
  SOFT: { color: OpenTyreF1Theme.colors.tyreSoft, letter: 'S', label: 'Soft' },
  MEDIUM: { color: OpenTyreF1Theme.colors.tyreMedium, letter: 'M', label: 'Medium' },
  HARD: { color: OpenTyreF1Theme.colors.tyreHard, letter: 'H', label: 'Hard' },
  INTERMEDIATE: { color: OpenTyreF1Theme.colors.tyreIntermediate, letter: 'I', label: 'Inter' },
  WET: { color: OpenTyreF1Theme.colors.tyreWet, letter: 'W', label: 'Wet' },
};

export function compoundOf(name?: string | null) {
  if (!name) return { color: OpenTyreF1Theme.colors.tyreUnknown, letter: '?', label: 'Unknown' };
  return COMPOUND[name.toUpperCase()] ?? {
    color: OpenTyreF1Theme.colors.tyreUnknown, letter: name[0]?.toUpperCase() ?? '?', label: name,
  };
}

/** Dark compounds need dark text on them and vice versa. */
export function inkOn(hex: string) {
  const h = hex.replace('#', '');
  if (h.length < 6) return '#0A0A0B';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  // Rec. 601 luma is good enough to pick between two inks.
  return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? '#0A0A0B' : '#F5F5F7';
}

export function ChartTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.titleWrap}>
      <Text style={styles.title}>{title}</Text>
      {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
    </View>
  );
}

export interface LegendItem {
  label: string;
  color: string;
  /** Rendered inside the swatch — the non-colour channel for identity. */
  glyph?: string;
  dashed?: boolean;
}

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <View style={styles.legend}>
      {items.map((item) => (
        <View key={item.label} style={styles.legendItem}>
          {item.glyph ? (
            <View style={[styles.legendSwatch, { backgroundColor: item.color }]}>
              <Text style={[styles.legendGlyph, { color: inkOn(item.color) }]}>{item.glyph}</Text>
            </View>
          ) : (
            <View
              style={[
                styles.legendLine,
                { backgroundColor: item.color },
                item.dashed && styles.legendLineDashed,
              ]}
            />
          )}
          <Text style={styles.legendLabel}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

export function EmptyChart({ message }: { message: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyText}>{message}</Text>
    </View>
  );
}

/** Maps a data domain to pixel space. */
export function scale(value: number, dMin: number, dMax: number, rMin: number, rMax: number) {
  if (dMax === dMin) return rMin;
  return rMin + ((value - dMin) / (dMax - dMin)) * (rMax - rMin);
}

export function formatLapTime(seconds?: number | null) {
  if (seconds == null || Number.isNaN(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m > 0 ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
}

const styles = StyleSheet.create({
  titleWrap: { marginBottom: OpenTyreF1Theme.spacing.md },
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
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: OpenTyreF1Theme.spacing.md,
    marginTop: OpenTyreF1Theme.spacing.md,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendSwatch: {
    width: 16,
    height: 16,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  legendGlyph: { fontFamily: OpenTyreF1Theme.fonts.monoBold, fontSize: 9 },
  legendLine: { width: 16, height: 3, borderRadius: 2 },
  legendLineDashed: { opacity: 0.55 },
  legendLabel: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  empty: { paddingVertical: 28, alignItems: 'center' },
  emptyText: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
    textAlign: 'center',
  },
});
