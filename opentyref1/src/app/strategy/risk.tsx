import React from 'react';
import { View, Text } from 'react-native';
import { fetchRiskCall, PitwallResponse } from '../../services/api';
import { PitwallModuleScreen, actualStyles } from '../../components/strategy/pitwall-module-screen';

export default function RiskScreen() {
  return (
    <PitwallModuleScreen
      title="Risk Analysis"
      moduleKey="pitwall-risk"
      fetchFn={fetchRiskCall}
      longRunning
      renderActual={(data: PitwallResponse) => {
        const position = data.actual.position as number | null;
        return (
          <View style={actualStyles.row}>
            <Text style={actualStyles.label}>ACTUALLY</Text>
            <Text style={actualStyles.value}>{position != null ? `Finished P${position}` : 'Unclassified'}</Text>
          </View>
        );
      }}
    />
  );
}
