import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { OpenTyreF1Theme } from '../constants/theme';
import { inkOn } from './charts/chart-kit';

/** Circular driver photo, falling back to initials-on-team-colour when the
 *  headshot is missing or the remote image fails to load (~3.6% of
 *  session_drivers rows have no headshotUrl, and F1.com links can die).
 *  Geometry copies the tyreBadge circle used across live.tsx and the replay
 *  player; disk caching via expo-image since these URLs get reloaded on
 *  every scroll.
 */
export function DriverAvatar({
  url,
  code,
  teamColour,
  size = 32,
}: {
  url?: string | null;
  code?: string | null;
  teamColour: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = !!url && !failed;

  return (
    <View
      style={[
        styles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: teamColour },
      ]}
    >
      {showImage ? (
        <Image
          source={{ uri: url! }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          cachePolicy="disk"
          onError={() => setFailed(true)}
          contentFit="cover"
        />
      ) : (
        <Text style={[styles.initials, { color: inkOn(teamColour), fontSize: size * 0.36 }]}>
          {(code ?? '?').slice(0, 3)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  initials: { fontFamily: OpenTyreF1Theme.fonts.monoBold },
});
