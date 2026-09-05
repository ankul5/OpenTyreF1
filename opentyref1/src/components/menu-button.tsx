import React from 'react';
import { TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { OpenTyreF1Theme } from '../constants/theme';
import { useAppMenu } from '../context/app-menu';

export function MenuButton() {
  const { open } = useAppMenu();
  return (
    <TouchableOpacity onPress={open} hitSlop={12} style={styles.button} activeOpacity={0.6}>
      <Ionicons name="menu" size={22} color={OpenTyreF1Theme.colors.textPrimary} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: { padding: 4 },
});
