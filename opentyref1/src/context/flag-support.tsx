import React, { createContext, useContext, useEffect, useState } from 'react';
import { View, Text, TextLayoutEventData, NativeSyntheticEvent } from 'react-native';

/** Whether this device renders regional-indicator flag emoji as an actual
 *  flag glyph rather than two boxed letters. Some Android builds render
 *  🇮🇹 as two ~equal-width boxes side by side, which measures roughly 2x
 *  the width of a single-codepoint emoji of the same font size — a real
 *  flag glyph renders as one glyph, much closer to 1x. Measured once at
 *  app start against a known-good single emoji, resolved app-wide so every
 *  screen falls back to the ISO-2 chip together rather than screen-by-screen.
 */
const FlagSupportContext = createContext(true);

export function useFlagSupport() {
  return useContext(FlagSupportContext);
}

const BASELINE_EMOJI = '🏁';
const TEST_FLAG = '🇮🇹';
const UNSUPPORTED_WIDTH_RATIO = 1.4;

export function FlagSupportProvider({ children }: { children: React.ReactNode }) {
  const [supported, setSupported] = useState(true);
  const [baselineWidth, setBaselineWidth] = useState<number | null>(null);
  const [flagWidth, setFlagWidth] = useState<number | null>(null);

  useEffect(() => {
    if (baselineWidth == null || flagWidth == null || baselineWidth === 0) return;
    setSupported(flagWidth / baselineWidth < UNSUPPORTED_WIDTH_RATIO);
  }, [baselineWidth, flagWidth]);

  const onBaselineLayout = (e: NativeSyntheticEvent<TextLayoutEventData>) => {
    setBaselineWidth(e.nativeEvent.lines[0]?.width ?? null);
  };
  const onFlagLayout = (e: NativeSyntheticEvent<TextLayoutEventData>) => {
    setFlagWidth(e.nativeEvent.lines[0]?.width ?? null);
  };

  return (
    <FlagSupportContext.Provider value={supported}>
      {children}
      <View style={{ position: 'absolute', opacity: 0, height: 0, overflow: 'hidden' }} pointerEvents="none">
        <Text style={{ fontSize: 17 }} onTextLayout={onBaselineLayout}>
          {BASELINE_EMOJI}
        </Text>
        <Text style={{ fontSize: 17 }} onTextLayout={onFlagLayout}>
          {TEST_FLAG}
        </Text>
      </View>
    </FlagSupportContext.Provider>
  );
}
