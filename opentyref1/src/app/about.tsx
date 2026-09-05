import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { OpenTyreF1Theme } from '../constants/theme';
import { Hairline } from '../components/hairline';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Hairline style={{ marginBottom: OpenTyreF1Theme.spacing.sm }} />
      {children}
    </View>
  );
}

export default function AboutScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.backButton}>
          <Ionicons name="chevron-back" size={22} color={OpenTyreF1Theme.colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>About</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.wordmark}>OpenTyreF1</Text>
        <Text style={styles.tagline}>
          Formula 1 strategy and telemetry analysis, built on real race data.
        </Text>

        <Section title="What this is">
          <Text style={styles.body}>
            A mobile app for exploring F1 lap-by-lap analysis (2023 onward) and driver history
            (2002 onward) — replays, tyre strategy, telemetry comparisons, and a strategy
            simulator, all computed from real sessions rather than approximations.
          </Text>
        </Section>

        <Section title="What this isn't">
          <Text style={styles.body}>
            Not true live timing — the free OpenF1 tier is historical-only, unlocking about 30
            minutes after a session ends, so the Live tab shows the latest completed session and
            says so honestly. Not an account-based product; nothing is stored about who's using
            it. Not a commercial or paid product — this is an academic project.
          </Text>
        </Section>

        <Section title="Data sources">
          <Text style={styles.body}>
            <Text style={styles.bold}>OpenF1</Text> — lap times, tyre stints, pit stops, weather,
            race control messages, and telemetry (2023+).{'\n\n'}
            <Text style={styles.bold}>Jolpica-F1</Text> (an Ergast-compatible API) — race results,
            championship standings, and the full season calendar (2002+).
          </Text>
        </Section>

        <Section title="Methodology">
          <Text style={styles.body}>
            <Text style={styles.bold}>Pace</Text> is the true median of each driver's "clean"
            laps — lap 1, pit in/out laps, and safety-car-affected laps are excluded, then any lap
            slower than 107% of that driver's own median is dropped as an outlier.{'\n\n'}
            <Text style={styles.bold}>Tyre degradation</Text> is the slope of lap time against
            tyre age within a stint, corrected for the session's overall fuel-burn trend so
            what's left is tyre wear, not fuel load masking it.{'\n\n'}
            The strategy simulator's predictions come from an XGBoost model trained on this same
            filtered lap data — the same pipeline that produces the numbers you see everywhere
            else in the app.
          </Text>
        </Section>

        <Section title="Tech stack">
          <Text style={styles.body}>
            Expo / React Native, FastAPI, SQLite, XGBoost.
          </Text>
        </Section>

        <Section title="Team">
          <Text style={styles.body}>
            Atharva Joshi · Ankit Sawalakhe · Kripa Patil · Araju Yelekar · Devshree Khodke{'\n'}
            Guide: Mrs. Prachi Jain — Dept. of CSE, G H Raisoni University, Amravati
          </Text>
        </Section>

        <Section title="Disclaimer">
          <Text style={styles.body}>
            OpenTyreF1 is not affiliated with, endorsed by, or connected to Formula 1. F1,
            Formula 1, and related marks are trademarks of Formula One Licensing B.V.
          </Text>
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: OpenTyreF1Theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: OpenTyreF1Theme.spacing.lg,
    paddingTop: OpenTyreF1Theme.spacing.sm,
    paddingBottom: OpenTyreF1Theme.spacing.md,
  },
  backButton: { padding: 4 },
  title: {
    fontFamily: OpenTyreF1Theme.fonts.displayBold,
    fontSize: OpenTyreF1Theme.type.displayLg.fontSize,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  content: { paddingHorizontal: OpenTyreF1Theme.spacing.lg, paddingBottom: 72 },
  wordmark: {
    fontFamily: OpenTyreF1Theme.fonts.displayBold,
    fontSize: OpenTyreF1Theme.type.displayMd.fontSize,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  tagline: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 4,
    marginBottom: OpenTyreF1Theme.spacing.xl,
  },
  section: { marginBottom: OpenTyreF1Theme.spacing.xl },
  sectionTitle: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
    marginBottom: OpenTyreF1Theme.spacing.sm,
  },
  body: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 13,
    lineHeight: 20,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  bold: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
});
