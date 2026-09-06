import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { OpenTyreF1Theme } from '../../constants/theme';
import { MenuButton } from '../../components/menu-button';

type PitwallType = {
  href: string;
  emoji: string;
  title: string;
  description: string;
};

// The nine strategy calls a race engineer actually makes, in the order a
// pitwall would reach for them: build the plan first, then react to
// whatever the race throws at it.
const TYPES: PitwallType[] = [
  {
    href: '/strategy/planner',
    emoji: '🧮',
    title: 'Stint Planner',
    description: 'Build a tyre strategy and simulate it against the real race',
  },
  {
    href: '/strategy/safety-car',
    emoji: '🚨',
    title: 'Safety Car Strategy',
    description: 'Whether to pit during SC/VSC and the expected position gain',
  },
  {
    href: '/strategy/flags',
    emoji: '🟡',
    title: 'Red/Yellow Flag Strategy',
    description: 'React to incidents and immediate strategic changes',
  },
  {
    href: '/strategy/weather',
    emoji: '🌧️',
    title: 'Weather Strategy',
    description: 'The Inter/Wet crossover point and current weather impact',
  },
  {
    href: '/strategy/overtake',
    emoji: '🏁',
    title: 'Overtake Strategy',
    description: 'DRS opportunity and an attack recommendation',
  },
  {
    href: '/strategy/defence',
    emoji: '🛡️',
    title: 'Defensive Strategy',
    description: 'How to protect position from the cars behind',
  },
  {
    href: '/strategy/outcome',
    emoji: '🧭',
    title: 'Position Prediction',
    description: 'Predicted finishing position from this point in the race',
  },
  {
    href: '/strategy/risk',
    emoji: '⚠️',
    title: 'Risk Analysis',
    description: 'Probability of the current strategy succeeding or failing',
  },
];

export default function StrategyScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <MenuButton />
        </View>
        <Text style={styles.pageTitle}>Strategy</Text>
        <Text style={styles.pageSubtitle}>
          Choose a strategy type. Each one answers what the right call was at a given lap of a
          real race, and shows what actually happened.
        </Text>

        <View style={styles.grid}>
          {TYPES.map((t) => (
            <Pressable
              key={t.href}
              onPress={() => router.push(t.href as any)}
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
            >
              <Text style={styles.cardEmoji}>{t.emoji}</Text>
              <Text style={styles.cardTitle}>{t.title}</Text>
              <Text style={styles.cardDescription}>{t.description}</Text>
              <View style={styles.cardFooter}>
                <Text style={styles.cardFooterText}>Open</Text>
                <Ionicons name="chevron-forward" size={14} color={OpenTyreF1Theme.colors.accent} />
              </View>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: OpenTyreF1Theme.colors.background },
  scrollContent: { padding: OpenTyreF1Theme.spacing.lg, paddingBottom: 80 },
  headerRow: { flexDirection: 'row', marginBottom: OpenTyreF1Theme.spacing.sm },
  pageTitle: {
    fontFamily: OpenTyreF1Theme.fonts.displayBold,
    fontSize: OpenTyreF1Theme.type.displayLg.fontSize,
    lineHeight: OpenTyreF1Theme.type.displayLg.lineHeight,
    letterSpacing: OpenTyreF1Theme.type.displayLg.letterSpacing,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  pageSubtitle: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 13,
    lineHeight: 18,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 4,
    marginBottom: OpenTyreF1Theme.spacing.lg,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card: {
    width: '47.5%',
    padding: OpenTyreF1Theme.spacing.md,
    borderRadius: OpenTyreF1Theme.borderRadius.lg,
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised,
    borderWidth: 1,
    borderColor: OpenTyreF1Theme.colors.hairline,
    minHeight: 148,
  },
  cardPressed: { opacity: 0.7, borderColor: OpenTyreF1Theme.colors.hairlineStrong },
  cardEmoji: { fontSize: 26, marginBottom: 8 },
  cardTitle: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
    marginBottom: 4,
  },
  cardDescription: {
    flex: 1,
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 11,
    lineHeight: 15,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  cardFooter: {
    flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 10,
  },
  cardFooterText: {
    fontFamily: OpenTyreF1Theme.fonts.bodyMedium,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.accent,
  },
});
