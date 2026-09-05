import React from 'react';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import { OpenTyreF1Theme } from '../../constants/theme';

export default function TabLayout() {
  // Fixed height/padding here ignored the system nav bar (gesture pill or the
  // Android 3-button bar), so the tab labels sat under/behind it. Push the
  // bar up by the actual bottom inset instead of a hardcoded value.
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: OpenTyreF1Theme.colors.tabBarBackground,
          borderTopColor: OpenTyreF1Theme.colors.hairline,
          borderTopWidth: 1,
          height: 56 + insets.bottom,
          paddingBottom: insets.bottom + 6,
          paddingTop: 8,
        },
        tabBarActiveTintColor: OpenTyreF1Theme.colors.tabBarActive,
        tabBarInactiveTintColor: OpenTyreF1Theme.colors.tabBarInactive,
        tabBarLabelStyle: {
          fontFamily: OpenTyreF1Theme.fonts.bodyMedium,
          fontSize: 11,
        },
      }}
    >
      <Tabs.Screen
        name="live"
        options={{
          title: 'Live',
          tabBarIcon: ({ color, size }) => (
            <MaterialIcons name="leaderboard" size={size || 22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="drivers"
        options={{
          title: 'Drivers',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="people-outline" size={size || 22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="strategy"
        options={{
          title: 'Strategy',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="bar-chart-outline" size={size || 22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="assistant"
        options={{
          title: 'Assistant',
          tabBarIcon: ({ color, focused, size }) => (
            <MaterialCommunityIcons name={focused ? 'robot' : 'robot-outline'} size={size || 22} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
