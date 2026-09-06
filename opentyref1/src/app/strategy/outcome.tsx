import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { fetchOutcomeCall, OutcomeResponse } from '../../services/api';
import { PitwallModuleScreen, actualStyles } from '../../components/strategy/pitwall-module-screen';
import { OutcomeDistribution } from '../../components/strategy/outcome-distribution';
import { OpenTyreF1Theme } from '../../constants/theme';

export default function OutcomeScreen() {
  return (
    <PitwallModuleScreen
      title="Position Prediction"
      moduleKey="pitwall-outcome"
      fetchFn={fetchOutcomeCall}
      longRunning
      renderActual={(data: OutcomeResponse) => {
        const position = data.actual.position as number | null;
        return (
          <View style={actualStyles.row}>
            <Text style={actualStyles.label}>ACTUALLY</Text>
            <Text style={actualStyles.value}>{position != null ? `Finished P${position}` : 'Unclassified'}</Text>
          </View>
        );
      }}
      renderBelow={(data: OutcomeResponse) => (
        <View style={styles.chartBlock}>
          <OutcomeDistribution
            histogram={data.histogram}
            maxPosition={data.maxPosition}
            actualPosition={(data.actual.position as number | null) ?? null}
          />
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  chartBlock: {
    marginTop: OpenTyreF1Theme.spacing.xl,
    padding: OpenTyreF1Theme.spacing.md,
    borderRadius: OpenTyreF1Theme.borderRadius.lg,
    backgroundColor: OpenTyreF1Theme.colors.surfaceRaised,
  },
});
