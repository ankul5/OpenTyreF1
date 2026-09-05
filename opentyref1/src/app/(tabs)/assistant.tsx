import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  useReducedMotion,
} from 'react-native-reanimated';
import {
  askAssistant,
  fetchAssistantCapabilities,
  AssistantAnswer,
  AssistantFact,
} from '../../services/api';
import { OpenTyreF1Theme } from '../../constants/theme';
import { Hairline } from '../../components/hairline';
import { MenuButton } from '../../components/menu-button';
import { useStrategyDraft } from '../../context/strategy-context';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  facts?: AssistantFact[];
  sources?: string[];
  followUps?: string[];
  grounded?: boolean;
  failed?: boolean;
}

let counter = 0;
const nextId = () => `m${++counter}`;

/**
 * What the assistant reports it is doing while the request is in flight.
 *
 * These are the real steps the backend takes, in the order it takes them —
 * pulling laps, filtering to representative ones, running the tyre model —
 * phrased the way a race engineer would say them over the radio. Answers
 * mostly return in well under a second, and arriving instantly read as a
 * canned lookup rather than work, so the sequence is also held for
 * MIN_THINKING_MS to make the steps legible.
 */
const THINKING_STEPS = [
  'Copy that, checking…',
  'Pulling the timing screens',
  'Filtering to representative laps',
  'Running the tyre model',
  'Box, box — answer coming',
];

const MIN_THINKING_MS = 2000;
const STEP_INTERVAL_MS = MIN_THINKING_MS / THINKING_STEPS.length;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function AssistantScreen() {
  const { draft, pendingQuestion, clearPendingQuestion } = useStrategyDraft();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const capabilities = useQuery({
    queryKey: ['assistantCapabilities'],
    queryFn: fetchAssistantCapabilities,
    staleTime: Infinity,
  });

  const reducedMotion = useReducedMotion();
  const glowOpacity = useSharedValue(0.3);
  const glowScale = useSharedValue(1);
  const glowStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
    transform: [{ scale: glowScale.value }],
  }));

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || pending) return;

      setMessages((prev) => [...prev, { id: nextId(), role: 'user', text: trimmed }]);
      setInput('');
      setPending(true);

      // The composer pulses once per send. It marks that the question left the
      // device, which matters here because an answer can take a second while
      // the backend re-runs a simulation.
      if (!reducedMotion) {
        glowOpacity.value = withSequence(withTiming(0.85, { duration: 150 }), withTiming(0.3, { duration: 700 }));
        glowScale.value = withSequence(withTiming(1.2, { duration: 150 }), withTiming(1, { duration: 700 }));
      }
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));

      try {
        // Run the request and the minimum thinking window together, so the
        // floor never adds to a genuinely slow answer — only to a fast one.
        const [answer] = await Promise.all([
          askAssistant(trimmed, {
            raceId: draft?.raceId,
            driverId: draft?.driverId,
            stints: draft?.stints,
          }) as Promise<AssistantAnswer>,
          delay(MIN_THINKING_MS),
        ]);
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            text: answer.answer,
            facts: answer.facts,
            sources: answer.sources,
            followUps: answer.followUps,
            grounded: answer.grounded,
          },
        ]);
      } catch (error: any) {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            failed: true,
            text:
              error?.response?.data?.detail ??
              'I could not reach the backend. Check that the API is running and that EXPO_PUBLIC_API_URL points at it.',
          },
        ]);
      } finally {
        setPending(false);
        requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
      }
    },
    [draft, pending, reducedMotion],
  );

  // A question handed over from the Strategy tab's "Ask about this strategy"
  // button. Cleared before sending so a re-render cannot fire it twice.
  React.useEffect(() => {
    if (!pendingQuestion || pending) return;
    clearPendingQuestion();
    send(pendingQuestion);
  }, [pendingQuestion, pending, send, clearPendingQuestion]);

  // Prompts whose data the app does not have yet are hidden rather than shown
  // and then answered with "I need a race first".
  const prompts = (capabilities.data?.quickPrompts ?? []).filter((p) => {
    if (p.needs === 'stints') return !!draft?.stints?.length;
    if (p.needs === 'race') return !!draft?.raceId;
    return true;
  });

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.headerRow}>
        <MenuButton />
        <Text style={styles.pageTitle}>Assistant</Text>
      </View>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.chatContent}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
          keyboardShouldPersistTaps="handled"
        >
          {messages.length === 0 && (
            <IntroPanel
              capabilities={capabilities.data?.capabilities ?? []}
              loading={capabilities.isLoading}
              failed={capabilities.isError}
              draftLabel={
                draft ? `${draft.raceName ?? draft.raceId}, ${draft.driverCode ?? draft.driverId}` : null
              }
            />
          )}

          {messages.map((m) =>
            m.role === 'user' ? (
              <View key={m.id} style={styles.userRow}>
                <View style={styles.userBubble}>
                  <Text style={styles.userText}>{m.text}</Text>
                </View>
              </View>
            ) : (
              <AssistantMessage key={m.id} message={m} onFollowUp={send} />
            ),
          )}

          {pending && <ThinkingRow />}
        </ScrollView>

        {prompts.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.promptRow}
            keyboardShouldPersistTaps="handled"
          >
            {prompts.map((p) => (
              <TouchableOpacity
                key={p.label}
                style={styles.promptChip}
                activeOpacity={0.7}
                onPress={() => send(p.question)}
              >
                <Text style={styles.promptText}>{p.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        <View style={styles.composerWrap}>
          <Animated.View pointerEvents="none" style={[styles.glow, glowStyle]} />
          <View style={styles.inputRow}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="Ask about a race, a driver, or your strategy"
              placeholderTextColor={OpenTyreF1Theme.colors.textTertiary}
              style={styles.input}
              onSubmitEditing={() => send(input)}
              returnKeyType="send"
              editable={!pending}
            />
            <TouchableOpacity
              onPress={() => send(input)}
              style={styles.sendButton}
              hitSlop={8}
              disabled={pending || !input.trim()}
            >
              <Ionicons
                name="arrow-up-circle"
                size={24}
                color={
                  input.trim() && !pending
                    ? OpenTyreF1Theme.colors.accent
                    : OpenTyreF1Theme.colors.textTertiary
                }
              />
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function IntroPanel({
  capabilities,
  loading,
  failed,
  draftLabel,
}: {
  capabilities: string[];
  loading: boolean;
  failed: boolean;
  draftLabel: string | null;
}) {
  return (
    <View style={styles.intro}>
      <MaterialCommunityIcons name="radio-tower" size={22} color={OpenTyreF1Theme.colors.accent} />
      <Text style={styles.introTitle}>Ask about the data you have</Text>
      <Text style={styles.introBody}>
        Every answer is built from your own database and the simulator, never generated prose. If
        the data cannot support a question, it says so instead of guessing.
      </Text>

      {loading && <Text style={styles.introMuted}>Loading what it can answer.</Text>}
      {failed && (
        <Text style={styles.introMuted}>
          Could not reach the backend, so the quick prompts are unavailable.
        </Text>
      )}

      {capabilities.map((c) => (
        <View key={c} style={styles.introItem}>
          <Ionicons name="checkmark" size={13} color={OpenTyreF1Theme.colors.textTertiary} />
          <Text style={styles.introItemText}>{c}</Text>
        </View>
      ))}

      <Text style={styles.introContext}>
        {draftLabel
          ? `Using your Strategy tab context: ${draftLabel}.`
          : 'Build a plan on the Strategy tab and it will be used as context here.'}
      </Text>
    </View>
  );
}

function AssistantMessage({
  message,
  onFollowUp,
}: {
  message: Message;
  onFollowUp: (question: string) => void;
}) {
  return (
    <View style={styles.assistantRow}>
      <MaterialCommunityIcons
        name={message.failed ? 'alert-circle-outline' : 'radio-tower'}
        size={16}
        color={message.failed ? OpenTyreF1Theme.colors.error : OpenTyreF1Theme.colors.accent}
        style={styles.assistantIcon}
      />
      <View style={styles.assistantBody}>
        <Text style={styles.assistantText}>{message.text}</Text>

        {!!message.facts?.length && (
          <View style={styles.factList}>
            {message.facts.map((f, i) => (
              <View key={`${f.label}-${i}`}>
                <View style={styles.factRow}>
                  <Text style={styles.factLabel}>{f.label}</Text>
                  <Text
                    style={[styles.factValue, f.highlight && { color: OpenTyreF1Theme.colors.highlight }]}
                  >
                    {f.value}
                  </Text>
                </View>
                {i < message.facts!.length - 1 && <Hairline />}
              </View>
            ))}
          </View>
        )}

        {!!message.sources?.length && (
          <Text style={styles.sources}>Source: {message.sources.join('. ')}</Text>
        )}

        {!!message.followUps?.length && (
          <View style={styles.followRow}>
            {message.followUps.map((f) => (
              <TouchableOpacity
                key={f}
                style={styles.followChip}
                activeOpacity={0.7}
                onPress={() => onFollowUp(f)}
              >
                <Text style={styles.followText}>{f}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

/** Pit-wall status line shown while the backend works.
 *
 *  The composer is disabled during a request, so without this the screen looks
 *  frozen rather than busy. It steps through THINKING_STEPS rather than showing
 *  one static label, so the wait reads as staged work and not a hung request.
 */
function ThinkingRow() {
  const reducedMotion = useReducedMotion();
  const pulse = useSharedValue(0.35);
  const [step, setStep] = useState(0);

  React.useEffect(() => {
    if (reducedMotion) return;
    pulse.value = withRepeat(withTiming(1, { duration: 650 }), -1, true);
  }, [reducedMotion]);

  React.useEffect(() => {
    // Hold on the last step if the backend is slower than the scripted
    // sequence, rather than looping back to "checking…".
    const id = setInterval(
      () => setStep((s) => Math.min(s + 1, THINKING_STEPS.length - 1)),
      STEP_INTERVAL_MS,
    );
    return () => clearInterval(id);
  }, []);

  const style = useAnimatedStyle(() => ({ opacity: reducedMotion ? 0.6 : pulse.value }));

  return (
    <View style={styles.assistantRow}>
      <MaterialCommunityIcons
        name="radio-tower"
        size={16}
        color={OpenTyreF1Theme.colors.accent}
        style={styles.assistantIcon}
      />
      <Animated.Text style={[styles.thinking, style]}>{THINKING_STEPS[step]}</Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: OpenTyreF1Theme.colors.background },
  flex: { flex: 1 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: OpenTyreF1Theme.spacing.sm,
    paddingHorizontal: OpenTyreF1Theme.spacing.lg,
    paddingTop: OpenTyreF1Theme.spacing.sm,
    paddingBottom: OpenTyreF1Theme.spacing.xs,
  },
  pageTitle: {
    fontFamily: OpenTyreF1Theme.fonts.displayBold,
    fontSize: OpenTyreF1Theme.type.displayMd.fontSize,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  chatContent: {
    padding: OpenTyreF1Theme.spacing.lg,
    gap: OpenTyreF1Theme.spacing.lg,
    flexGrow: 1,
  },

  intro: { gap: 8, paddingTop: OpenTyreF1Theme.spacing.md },
  introTitle: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 17,
    color: OpenTyreF1Theme.colors.textPrimary,
    marginTop: 4,
  },
  introBody: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 13,
    lineHeight: 19,
    color: OpenTyreF1Theme.colors.textSecondary,
    marginBottom: 4,
  },
  introMuted: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  introItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  introItemText: {
    flex: 1,
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 13,
    lineHeight: 19,
    color: OpenTyreF1Theme.colors.textSecondary,
  },
  introContext: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: OpenTyreF1Theme.spacing.md,
  },

  userRow: { alignItems: 'flex-end' },
  userBubble: {
    maxWidth: '85%',
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised,
    borderRadius: OpenTyreF1Theme.borderRadius.lg,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userText: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 14,
    lineHeight: 20,
    color: OpenTyreF1Theme.colors.textPrimary,
  },

  assistantRow: { flexDirection: 'row', gap: 10 },
  assistantIcon: { marginTop: 3 },
  assistantBody: { flex: 1, gap: 10 },
  assistantText: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 14,
    lineHeight: 21,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  thinking: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 2,
  },

  factList: { marginTop: 2 },
  factRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    gap: 12,
  },
  factLabel: {
    flex: 1,
    fontFamily: OpenTyreF1Theme.fonts.bodyMedium,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  factValue: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textPrimary,
    textAlign: 'right',
  },
  sources: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 10,
    lineHeight: 15,
    color: OpenTyreF1Theme.colors.textTertiary,
  },

  followRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  followChip: {
    borderWidth: 1,
    borderColor: OpenTyreF1Theme.colors.hairlineStrong,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  followText: {
    fontFamily: OpenTyreF1Theme.fonts.bodyMedium,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.textSecondary,
  },

  promptRow: {
    gap: 8,
    paddingHorizontal: OpenTyreF1Theme.spacing.lg,
    paddingBottom: OpenTyreF1Theme.spacing.sm,
  },
  promptChip: {
    borderWidth: 1,
    borderColor: OpenTyreF1Theme.colors.hairlineStrong,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    paddingHorizontal: 15,
    paddingVertical: 9,
  },
  promptText: {
    fontFamily: OpenTyreF1Theme.fonts.bodyMedium,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
  },

  composerWrap: {
    marginHorizontal: OpenTyreF1Theme.spacing.lg,
    marginBottom: OpenTyreF1Theme.spacing.sm,
  },
  glow: {
    position: 'absolute',
    left: -10,
    right: -10,
    bottom: -7,
    top: -7,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    backgroundColor: OpenTyreF1Theme.colors.accent,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised,
    borderRadius: OpenTyreF1Theme.borderRadius.full,
    paddingLeft: 16,
    paddingRight: 6,
    height: 50,
  },
  input: {
    flex: 1,
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
    padding: 0,
  },
  sendButton: { padding: 4 },
});
