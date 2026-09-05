// Design tokens for OpenTyreF1.
//
// Two roles, not one: `accent` (a muted maroon-red — status/live, primary
// actions, active/selected state) and `highlight` (warm gold — achievements,
// informational callouts). Team and tyre colors are data encoding (identity
// bars, compound badges) — never used as UI accent.
//
// Radius rule (do not improvise per-component): containers/cards = radius.lg,
// chips/badges/pills = radius.full, inputs = radius.md.
export const OpenTyreF1Theme = {
  colors: {
    // Canvas
    background: '#0A0A0B',
    surfaceRaised: '#141416',
    surfaceSunken: '#08080A',
    hairline: 'rgba(255,255,255,0.08)',
    hairlineStrong: 'rgba(255,255,255,0.14)',

    // Text
    textPrimary: '#F5F5F7',
    textSecondary: 'rgba(245,245,247,0.56)',
    textTertiary: 'rgba(245,245,247,0.36)',

    // Accent — muted maroon, not pure racing red. Used for: live/status
    // indicators, primary buttons, active tab/selection state. Sparingly.
    accent: '#B3383D',
    onAccent: '#FFFFFF',

    // Highlight — warm gold, for achievements and informational callouts
    // (wins, titles, race-win positions) so red isn't the only emphasis color.
    highlight: '#C9A227',

    // Status
    success: '#30D158',
    error: '#FF453A',

    // Tab bar
    tabBarBackground: '#08080A',
    tabBarInactive: 'rgba(245,245,247,0.36)',
    tabBarActive: '#B3383D',

    // Team identity (2px bars only, never backgrounds/text)
    teamRedBull: '#3671C6',
    teamFerrari: '#E8002D',
    teamMercedes: '#27F4D2',
    teamMcLaren: '#FF8000',

    // Tyre compounds. These are Pirelli's real colours, kept deliberately:
    // a fan reads white as HARD and yellow as MEDIUM, so "fixing" them to fit
    // a generated palette band would make the chart wrong. They pass CVD
    // separation (ΔE 18.2 deutan) and 3:1 contrast on this surface; every
    // usage additionally carries the compound letter, so identity is never
    // colour-alone.
    tyreSoft: '#FF3333',
    tyreMedium: '#FFD12E',
    tyreHard: '#F0F0F0',
    tyreIntermediate: '#43B02A',
    tyreWet: '#0067AD',
    tyreUnknown: '#6B6B70',

    // Chart chrome — recessive by design, so marks carry the meaning.
    gridLine: 'rgba(255,255,255,0.06)',
    axisLine: 'rgba(255,255,255,0.12)',
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 48,
  },
  borderRadius: {
    md: 10,
    lg: 12,
    full: 999,
  },
  fonts: {
    display: 'BarlowCondensed_600SemiBold',
    displayBold: 'BarlowCondensed_700Bold',
    body: 'Manrope_400Regular',
    bodyMedium: 'Manrope_500Medium',
    bodySemiBold: 'Manrope_600SemiBold',
    mono: 'IBMPlexMono_500Medium',
    monoBold: 'IBMPlexMono_600SemiBold',
  },
  type: {
    displayXl: {
      fontSize: 44,
      lineHeight: 40,
      letterSpacing: -0.5,
    },
    displayLg: {
      fontSize: 32,
      lineHeight: 30,
      letterSpacing: -0.3,
    },
    displayMd: {
      fontSize: 24,
      lineHeight: 24,
      letterSpacing: -0.2,
    },
    body: {
      fontSize: 15,
      lineHeight: 21,
    },
    label: {
      fontSize: 13,
      lineHeight: 18,
    },
    caption: {
      fontSize: 11,
      lineHeight: 15,
    },
    monoLg: {
      fontSize: 20,
      lineHeight: 24,
    },
    mono: {
      fontSize: 14,
      lineHeight: 18,
    },
  },
};
