import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { OpenTyreF1Theme } from '../../constants/theme';
import { Hairline } from '../hairline';
import type { PitwallResponse } from '../../services/api';

const SOURCE_LABEL: Record<PitwallResponse['source'], string> = {
  measured: 'Measured',
  derived: 'Derived from race data',
  modelled: 'Modelled',
};

/** Renders the one envelope every pitwall module returns. The sample size
 *  and source line are never optional — a 13-race red-flag sample must
 *  read as "n=13", not disappear behind a confident-looking verdict. */
export function RecommendationCard({ data, children }: { data: PitwallResponse; children?: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <View style={styles.verdictRow}>
        <Text style={styles.verdict}>{data.verdict}</Text>
        {data.confidence > 0 && (
          <View style={styles.confidenceTrack}>
            <View style={[styles.confidenceFill, { width: `${Math.round(data.confidence * 100)}%` }]} />
          </View>
        )}
      </View>

      {data.reasoning.map((line, i) => (
        <Text key={i} style={styles.reasoning}>{line}</Text>
      ))}

      {data.facts.length > 0 && (
        <>
          <Hairline style={styles.hairline} />
          <View style={styles.factsGrid}>
            {data.facts.map((f, i) => (
              <View key={i} style={styles.factCell}>
                <Text style={styles.factLabel}>{f.label}</Text>
                <Text style={styles.factValue}>{f.value}</Text>
              </View>
            ))}
          </View>
        </>
      )}

      {children}

      <Text style={styles.provenance}>
        {SOURCE_LABEL[data.source]} · n={data.sampleSize.toLocaleString()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: OpenTyreF1Theme.spacing.md,
    borderRadius: OpenTyreF1Theme.borderRadius.lg,
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised,
  },
  verdictRow: { marginBottom: 10, gap: 8 },
  verdict: {
    fontFamily: OpenTyreF1Theme.fonts.displayBold,
    fontSize: OpenTyreF1Theme.type.displayMd.fontSize,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  confidenceTrack: {
    height: 4, borderRadius: 2, backgroundColor: OpenTyreF1Theme.colors.surfaceSunken, overflow: 'hidden',
  },
  confidenceFill: { height: '100%', backgroundColor: OpenTyreF1Theme.colors.accent },
  reasoning: {
    fontFamily: OpenTyreF1Theme.fonts.body, fontSize: 13, lineHeight: 19,
    color: OpenTyreF1Theme.colors.textSecondary, marginBottom: 6,
  },
  hairline: { marginVertical: 10 },
  factsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  factCell: { minWidth: '42%' },
  factLabel: {
    fontFamily: OpenTyreF1Theme.fonts.mono, fontSize: 10, letterSpacing: 0.3,
    color: OpenTyreF1Theme.colors.textTertiary, marginBottom: 2,
  },
  factValue: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold, fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  provenance: {
    fontFamily: OpenTyreF1Theme.fonts.mono, fontSize: 10,
    color: OpenTyreF1Theme.colors.textTertiary, marginTop: 12,
  },
});
